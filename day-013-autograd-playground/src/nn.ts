/**
 * A tiny neural net library on top of the scalar engine: Neuron, Layer and MLP,
 * the losses used for ±1 labels, and L2 regularization.
 */
import { AutogradError, Value, sigmoid, type Scalar } from "./engine";
import { mulberry32, uniform, type Rng } from "./rng";

export const ACTIVATIONS = ["tanh", "relu", "sigmoid", "linear"] as const;
export type Activation = (typeof ACTIVATIONS)[number];

export function activate(v: Value, act: Activation): Value {
  switch (act) {
    case "tanh":
      return v.tanh();
    case "relu":
      return v.relu();
    case "sigmoid":
      return v.sigmoid();
    case "linear":
      return v;
  }
}

/** The same activations on plain numbers, for fast inference. */
export function activateNumber(x: number, act: Activation): number {
  switch (act) {
    case "tanh":
      return Math.tanh(x);
    case "relu":
      return x > 0 ? x : 0;
    case "sigmoid":
      return sigmoid(x);
    case "linear":
      return x;
  }
}

export interface Module {
  parameters(): Value[];
}

/** Sets the grad of every parameter to 0. */
export function zeroGrad(module: Module): void {
  for (const p of module.parameters()) p.grad = 0;
}

export class Neuron implements Module {
  readonly w: Value[];
  readonly b: Value;

  constructor(
    nin: number,
    readonly activation: Activation,
    rng: Rng,
  ) {
    // Uniform init with variance 1/nin (LeCun), or 2/nin for ReLU (He),
    // so activations keep roughly the same scale from layer to layer.
    const limit = Math.sqrt((activation === "relu" ? 6 : 3) / nin);
    this.w = Array.from({ length: nin }, () => new Value(uniform(rng, -limit, limit)));
    this.b = new Value(0);
  }

  forward(x: readonly Scalar[]): Value {
    const n = this.w.length;
    if (x.length !== n) throw new AutogradError(`Neuron expects ${n} inputs, got ${x.length}`);
    const terms: Value[] = new Array(n + 1);
    for (let i = 0; i < n; i++) terms[i] = this.w[i]!.mul(x[i]!);
    terms[n] = this.b;
    return activate(Value.sum(terms), this.activation);
  }

  /** forward() on plain numbers: no graph, used for the heatmap and accuracy. */
  predict(x: readonly number[]): number {
    let z = this.b.data;
    for (let i = 0; i < this.w.length; i++) z += this.w[i]!.data * x[i]!;
    return activateNumber(z, this.activation);
  }

  parameters(): Value[] {
    return [...this.w, this.b];
  }
}

export class Layer implements Module {
  readonly neurons: Neuron[];

  constructor(nin: number, nout: number, activation: Activation, rng: Rng) {
    this.neurons = Array.from({ length: nout }, () => new Neuron(nin, activation, rng));
  }

  forward(x: readonly Scalar[]): Value[] {
    return this.neurons.map((n) => n.forward(x));
  }

  predict(x: readonly number[]): number[] {
    return this.neurons.map((n) => n.predict(x));
  }

  parameters(): Value[] {
    return this.neurons.flatMap((n) => n.parameters());
  }
}

export interface MLPOptions {
  /** Activation for the hidden layers. Default tanh. */
  activation?: Activation;
  /** Activation for the last layer. Default linear (raw scores). */
  outputActivation?: Activation;
  /** Seed for the weight init. Default 1. */
  seed?: number;
}

export class MLP implements Module {
  readonly layers: Layer[];
  /** Layer sizes including the input, e.g. [2, 16, 16, 1]. */
  readonly shape: number[];

  constructor(nin: number, sizes: readonly number[], options: MLPOptions = {}) {
    const { activation = "tanh", outputActivation = "linear", seed = 1 } = options;
    const dims = [nin, ...sizes];
    if (sizes.length === 0 || dims.some((d) => !Number.isInteger(d) || d < 1)) {
      throw new AutogradError(`MLP layer sizes must be positive integers, got ${dims.join("-")}`);
    }
    const rng = mulberry32(seed);
    this.shape = dims;
    this.layers = sizes.map(
      (nout, i) => new Layer(dims[i]!, nout, i === sizes.length - 1 ? outputActivation : activation, rng),
    );
  }

  /** The output layer's values. Always an array, even with one output. */
  forward(x: readonly Scalar[]): Value[] {
    let h: Value[] = x.map(Value.from); // wrap inputs once so every neuron shares them
    for (const layer of this.layers) h = layer.forward(h);
    return h;
  }

  predict(x: readonly number[]): number[] {
    let h = x as number[];
    for (const layer of this.layers) h = layer.predict(h);
    return h;
  }

  parameters(): Value[] {
    return this.layers.flatMap((l) => l.parameters());
  }

  get paramCount(): number {
    let n = 0;
    for (let i = 1; i < this.shape.length; i++) n += (this.shape[i - 1]! + 1) * this.shape[i]!;
    return n;
  }

  zeroGrad(): void {
    zeroGrad(this);
  }

  toString(): string {
    return `MLP(${this.shape.join("-")}, ${this.layers[0]!.neurons[0]!.activation}, ${this.paramCount} params)`;
  }
}

// ---------------------------------------------------------------- losses ----

export const LOSSES = ["mse", "hinge", "bce"] as const;
export type LossName = (typeof LOSSES)[number];
export type Loss = (scores: readonly Value[], labels: readonly number[]) => Value;

function checkBatch(scores: readonly Value[], labels: readonly number[]): void {
  if (scores.length === 0) throw new AutogradError("loss needs at least one prediction");
  if (scores.length !== labels.length) {
    throw new AutogradError(`loss got ${scores.length} predictions but ${labels.length} labels`);
  }
}

/** Mean squared error: mean((score - label)²). */
export function mse(scores: readonly Value[], labels: readonly number[]): Value {
  checkBatch(scores, labels);
  const terms = scores.map((s, i) => {
    const d = s.sub(labels[i]!);
    return d.mul(d);
  });
  return Value.sum(terms).div(scores.length);
}

/** SVM max-margin loss for ±1 labels: mean(relu(1 - label·score)). */
export function hinge(scores: readonly Value[], labels: readonly number[]): Value {
  checkBatch(scores, labels);
  const terms = scores.map((s, i) => s.mul(-labels[i]!).add(1).relu());
  return Value.sum(terms).div(scores.length);
}

/**
 * Binary cross-entropy on raw scores (logits) for ±1 labels. Written in the
 * stable form relu(z) - t·z + log(1 + exp(-|z|)) with t = (label + 1) / 2, so
 * large scores never overflow exp or hit log(0). Its gradient is sigmoid(z) - t.
 */
export function bce(scores: readonly Value[], labels: readonly number[]): Value {
  checkBatch(scores, labels);
  const terms = scores.map((z, i) => {
    const t = (labels[i]! + 1) / 2;
    const pos = z.relu();
    const abs = pos.add(z.neg().relu());
    return pos.sub(z.mul(t)).add(abs.neg().exp().add(1).log());
  });
  return Value.sum(terms).div(scores.length);
}

export const LOSS_FNS: Record<LossName, Loss> = { mse, hinge, bce };

/** L2 regularization: lambda · Σ p². Returns a constant 0 when lambda is 0. */
export function l2(params: readonly Value[], lambda: number): Value {
  if (lambda === 0) return new Value(0);
  return Value.sum(params.map((p) => p.mul(p))).mul(lambda);
}

/** Fraction of scores whose sign matches the ±1 label (score > 0 means +1). */
export function accuracy(scores: readonly number[], labels: readonly number[]): number {
  if (scores.length === 0) return 0;
  let right = 0;
  for (let i = 0; i < scores.length; i++) if ((scores[i]! > 0 ? 1 : -1) === labels[i]) right++;
  return right / scores.length;
}
