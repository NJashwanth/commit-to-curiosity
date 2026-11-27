/** Loads model.json and runs it. Architecture and weights come from the file; nothing is hard-coded. */
import { argmax, conv2d, dense, flatten, maxpool2d, relu, softmax } from "./ops";
import { Tensor, sizeOf, tensor } from "./tensor";

export const FORMAT = "digit-sketch-cnn";

export type LayerSpec =
  | { type: "conv2d"; in: number; out: number; kernel: number; weight: number[]; bias: number[] }
  | { type: "dense"; in: number; out: number; weight: number[]; bias: number[] }
  | { type: "maxpool"; size: number }
  | { type: "relu" }
  | { type: "flatten" }
  | { type: "softmax" };

export interface ModelSpec {
  format: string;
  version: number;
  meta: Record<string, unknown> & { params?: number };
  input: { shape: [number, number, number]; mean: number; std: number };
  layers: LayerSpec[];
}

interface Layer {
  spec: LayerSpec;
  weight?: Float32Array;
  bias?: Float32Array;
  /** Shape of this layer's output, worked out when the model is built. */
  outShape: number[];
}

export interface Prediction {
  /** Probability of each digit 0 to 9. */
  probs: Float32Array;
  label: number;
  confidence: number;
  /** Output of every layer, in order. activations[i] belongs to spec.layers[i]. */
  activations: Tensor[];
}

function fail(message: string): never {
  throw new Error(`invalid model file: ${message}`);
}

function numberArray(value: unknown, expected: number, what: string): Float32Array {
  if (!Array.isArray(value)) fail(`${what} is not an array`);
  if (value.length !== expected) fail(`${what} has ${value.length} values, expected ${expected}`);
  return Float32Array.from(value as number[]);
}

export class Model {
  readonly spec: ModelSpec;
  private readonly layers: Layer[];

  constructor(spec: ModelSpec) {
    if (!spec || spec.format !== FORMAT) fail(`format is ${JSON.stringify(spec?.format)}, expected "${FORMAT}"`);
    if (!Array.isArray(spec.layers) || spec.layers.length === 0) fail("no layers");
    const inp = spec.input;
    if (!inp || !Array.isArray(inp.shape) || inp.shape.length !== 3 || !Number.isFinite(inp.mean) || !(inp.std > 0)) {
      fail("input needs a [C, H, W] shape, a mean and a positive std");
    }
    this.spec = spec;
    let shape: number[] = [...inp.shape];
    this.layers = spec.layers.map((layer, i) => {
      const where = `layer ${i} (${layer?.type})`;
      let weight: Float32Array | undefined;
      let bias: Float32Array | undefined;
      switch (layer.type) {
        case "conv2d": {
          if (shape.length !== 3 || shape[0] !== layer.in) fail(`${where} expects ${layer.in} input channels, got shape [${shape}]`);
          weight = numberArray(layer.weight, layer.out * layer.in * layer.kernel * layer.kernel, `${where} weight`);
          bias = numberArray(layer.bias, layer.out, `${where} bias`);
          if (shape[1] < layer.kernel || shape[2] < layer.kernel) fail(`${where}: input [${shape}] is smaller than the kernel`);
          shape = [layer.out, shape[1] - layer.kernel + 1, shape[2] - layer.kernel + 1];
          break;
        }
        case "dense": {
          if (shape.length !== 1 || shape[0] !== layer.in) fail(`${where} expects ${layer.in} inputs, got shape [${shape}]`);
          weight = numberArray(layer.weight, layer.out * layer.in, `${where} weight`);
          bias = numberArray(layer.bias, layer.out, `${where} bias`);
          shape = [layer.out];
          break;
        }
        case "maxpool": {
          if (shape.length !== 3 || Math.floor(shape[1] / layer.size) < 1 || Math.floor(shape[2] / layer.size) < 1) {
            fail(`${where}: cannot pool shape [${shape}]`);
          }
          shape = [shape[0], Math.floor(shape[1] / layer.size), Math.floor(shape[2] / layer.size)];
          break;
        }
        case "flatten":
          shape = [sizeOf(shape)];
          break;
        case "relu":
        case "softmax":
          break;
        default:
          fail(`${where} has an unknown type`);
      }
      return { spec: layer, weight, bias, outShape: [...shape] };
    });
  }

  /** Number of classes the last layer produces. */
  get classes(): number {
    return this.layers[this.layers.length - 1].outShape[0];
  }

  /** Output shape of every layer. */
  get shapes(): number[][] {
    return this.layers.map((l) => l.outShape);
  }

  /** Run a normalized [C, H, W] input through every layer. Returns the final tensor and each layer's output. */
  forward(input: Tensor): { output: Tensor; activations: Tensor[] } {
    if (input.shape.join("x") !== this.spec.input.shape.join("x")) {
      throw new Error(`input shape [${input.shape}] does not match the model's [${this.spec.input.shape}]`);
    }
    const activations: Tensor[] = [];
    let x = input;
    for (const layer of this.layers) {
      const s = layer.spec;
      switch (s.type) {
        case "conv2d":
          x = conv2d(x, layer.weight!, layer.bias!, s.out, s.kernel);
          break;
        case "dense":
          x = dense(x, layer.weight!, layer.bias!, s.out);
          break;
        case "maxpool":
          x = maxpool2d(x, s.size);
          break;
        case "relu":
          x = relu(x);
          break;
        case "flatten":
          x = flatten(x);
          break;
        case "softmax":
          x = softmax(x);
          break;
      }
      activations.push(x);
    }
    return { output: x, activations };
  }

  /** (pixel - mean) / std, for pixels already scaled to [0, 1]. */
  normalize(pixels01: ArrayLike<number>): Tensor {
    const { shape, mean, std } = this.spec.input;
    const t = tensor(shape);
    if (pixels01.length !== t.data.length) throw new Error(`expected ${t.data.length} pixels, got ${pixels01.length}`);
    for (let i = 0; i < t.data.length; i++) t.data[i] = (pixels01[i] - mean) / std;
    return t;
  }

  /** Classify a 28x28 image given as 784 values in [0, 1] (ink high). */
  predict(pixels01: ArrayLike<number>): Prediction {
    const { output, activations } = this.forward(this.normalize(pixels01));
    const label = argmax(output.data);
    return { probs: output.data, label, confidence: output.data[label], activations };
  }

  /** Post-ReLU feature maps of each conv layer, in order: activations[i] for a conv at i (or i+1 if a ReLU follows). */
  convMaps(activations: Tensor[]): Tensor[] {
    const maps: Tensor[] = [];
    this.layers.forEach((l, i) => {
      if (l.spec.type !== "conv2d") return;
      const next = this.layers[i + 1];
      maps.push(next && next.spec.type === "relu" ? activations[i + 1] : activations[i]);
    });
    return maps;
  }
}

export function loadModel(json: unknown): Model {
  return new Model(json as ModelSpec);
}

export async function fetchModel(url: string): Promise<Model> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status}`);
  return loadModel(await res.json());
}
