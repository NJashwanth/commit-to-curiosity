/** The training loop shared by the playground, the tests and tools/train-all.ts. */
import { DATASETS, DEFAULT_NOISE, makeDataset, type Dataset, type DatasetName } from "./datasets";
import { ACTIVATIONS, LOSS_FNS, LOSSES, MLP, accuracy, l2, type Activation, type LossName } from "./nn";
import { OPTIMIZERS, makeOptimizer, type Optimizer, type OptimizerName } from "./optim";
import { mulberry32, type Rng } from "./rng";

export interface TrainConfig {
  dataset: DatasetName;
  samples: number;
  /** Defaults to DEFAULT_NOISE for the dataset. */
  noise: number;
  /** Seeds the dataset, the weights and the minibatch order. */
  seed: number;
  /** Full layer sizes, input first: [2, 16, 16, 1]. */
  shape: number[];
  activation: Activation;
  loss: LossName;
  optimizer: OptimizerName;
  lr: number;
  /** L2 regularization strength. */
  l2: number;
  /** Samples per step; 0 means the whole dataset. */
  batchSize: number;
}

export const DEFAULT_CONFIG: Readonly<TrainConfig> = {
  dataset: "moons",
  samples: 200,
  noise: 0.1,
  seed: 1,
  shape: [2, 16, 16, 1],
  activation: "tanh",
  loss: "hinge",
  optimizer: "adam",
  lr: 0.03,
  l2: 0.0001,
  batchSize: 0,
};

export const MAX_UNITS = 64;
export const MAX_HIDDEN_LAYERS = 4;

/**
 * Parses a network shape like "2-16-16-1". The playground's data has two
 * inputs and one output score, so the first size must be 2 and the last 1.
 */
export function parseShape(text: string): number[] {
  const parts = text.trim().split(/\s*[-,x×\s]\s*/);
  if (parts.some((p) => !/^\d+$/.test(p))) {
    throw new SyntaxError(`shape must be numbers separated by dashes, like 2-16-16-1; got "${text.trim()}"`);
  }
  const sizes = parts.map(Number);
  if (sizes.length < 2) throw new SyntaxError("shape needs at least an input and an output size, like 2-1");
  if (sizes[0] !== 2) throw new RangeError(`the first size is the input and must be 2 (x and y), got ${sizes[0]}`);
  if (sizes.at(-1) !== 1) throw new RangeError(`the last size is the output score and must be 1, got ${sizes.at(-1)}`);
  const hidden = sizes.slice(1, -1);
  if (hidden.length > MAX_HIDDEN_LAYERS) throw new RangeError(`at most ${MAX_HIDDEN_LAYERS} hidden layers`);
  if (hidden.some((h) => h < 1 || h > MAX_UNITS)) {
    throw new RangeError(`hidden layers need 1 to ${MAX_UNITS} units each`);
  }
  return sizes;
}

/** Checks a config, throwing a readable error for the first bad field. */
export function validateConfig(config: TrainConfig): void {
  const oneOf = (field: string, value: string, options: readonly string[]) => {
    if (!options.includes(value)) throw new RangeError(`${field} must be one of ${options.join(", ")}; got "${value}"`);
  };
  oneOf("dataset", config.dataset, DATASETS);
  oneOf("activation", config.activation, ACTIVATIONS);
  oneOf("loss", config.loss, LOSSES);
  oneOf("optimizer", config.optimizer, OPTIMIZERS);
  parseShape(config.shape.join("-"));
  if (!(config.l2 >= 0) || !Number.isFinite(config.l2)) throw new RangeError(`l2 must be 0 or more, got ${config.l2}`);
  if (!Number.isInteger(config.batchSize) || config.batchSize < 0) {
    throw new RangeError(`batch size must be a whole number (0 for the full dataset), got ${config.batchSize}`);
  }
}

export interface StepStats {
  step: number;
  /** Batch loss including the L2 term. */
  loss: number;
  /** Accuracy on the full dataset after the update, 0 to 1. */
  accuracy: number;
}

export class Trainer {
  readonly config: TrainConfig;
  readonly data: Dataset;
  readonly model: MLP;
  optimizer: Optimizer;
  readonly history: StepStats[] = [];
  private readonly rng: Rng;
  private readonly order: number[];

  constructor(config: Partial<TrainConfig> = {}) {
    const name = config.dataset ?? DEFAULT_CONFIG.dataset;
    this.config = {
      ...DEFAULT_CONFIG,
      noise: DEFAULT_NOISE[name] ?? DEFAULT_CONFIG.noise,
      ...config,
      shape: [...(config.shape ?? DEFAULT_CONFIG.shape)],
    };
    validateConfig(this.config);
    const { dataset, samples, noise, seed, shape, activation } = this.config;
    this.data = makeDataset(dataset, { n: samples, noise, seed });
    this.model = new MLP(shape[0]!, shape.slice(1), { activation, seed });
    this.optimizer = makeOptimizer(this.config.optimizer, this.model.parameters(), this.config.lr);
    this.rng = mulberry32(seed ^ 0x5eed);
    this.order = this.data.X.map((_, i) => i);
  }

  get steps(): number {
    return this.history.length;
  }

  get last(): StepStats | undefined {
    return this.history.at(-1);
  }

  setLearningRate(lr: number): void {
    this.optimizer.lr = lr; // validates
    this.config.lr = lr;
  }

  setL2(lambda: number): void {
    validateConfig({ ...this.config, l2: lambda });
    this.config.l2 = lambda;
  }

  setBatchSize(size: number): void {
    validateConfig({ ...this.config, batchSize: size });
    this.config.batchSize = size;
  }

  setLoss(loss: LossName): void {
    validateConfig({ ...this.config, loss });
    this.config.loss = loss;
  }

  /** Switches optimizer, starting it with fresh state (Adam's moments at 0). */
  setOptimizer(name: OptimizerName): void {
    validateConfig({ ...this.config, optimizer: name });
    this.config.optimizer = name;
    this.optimizer = makeOptimizer(name, this.model.parameters(), this.config.lr);
  }

  /** The sample indices for the next step: everything, or a seeded random subset. */
  nextBatch(): number[] {
    const n = this.order.length;
    const size = this.config.batchSize;
    if (size === 0 || size >= n) return this.order.slice();
    // Partial Fisher-Yates: the first `size` slots become a uniform sample.
    const idx = this.order;
    for (let i = 0; i < size; i++) {
      const j = i + Math.floor(this.rng() * (n - i));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    return idx.slice(0, size);
  }

  /** One forward, backward and update. */
  step(): StepStats {
    const { X, y } = this.data;
    const batch = this.nextBatch();
    const scores = batch.map((i) => this.model.forward(X[i]!)[0]!);
    const labels = batch.map((i) => y[i]!);
    const params = this.model.parameters();
    const loss = LOSS_FNS[this.config.loss](scores, labels).add(l2(params, this.config.l2));
    this.optimizer.zeroGrad();
    loss.backward();
    this.optimizer.step();
    const stats = { step: this.steps + 1, loss: loss.data, accuracy: this.accuracy() };
    this.history.push(stats);
    return stats;
  }

  /** Accuracy on the whole dataset with the current weights. */
  accuracy(): number {
    return accuracy(this.scores(), this.data.y);
  }

  /** The model's raw score for every sample. */
  scores(): number[] {
    return this.data.X.map((p) => this.model.predict(p)[0]!);
  }

  /**
   * Scores on a res × res grid covering [-extent, extent]², row by row from
   * the top (largest y) down, for the decision boundary heatmap.
   */
  predictGrid(res: number, extent: number): Float64Array {
    const out = new Float64Array(res * res);
    const point = [0, 0];
    for (let row = 0; row < res; row++) {
      point[1] = extent - ((row + 0.5) / res) * 2 * extent;
      for (let col = 0; col < res; col++) {
        point[0] = -extent + ((col + 0.5) / res) * 2 * extent;
        out[row * res + col] = this.model.predict(point)[0]!;
      }
    }
    return out;
  }
}

export interface RunResult {
  steps: number;
  accuracy: number;
  loss: number;
  /** The step where the final unbroken run at the target accuracy began, or null. */
  reachedAt: number | null;
}

/**
 * Trains until accuracy reaches `target` and then keeps going for `patience`
 * more steps (so a lucky step isn't reported), or until `maxSteps`.
 */
export function train(trainer: Trainer, maxSteps: number, target = 1, patience = 0): RunResult {
  let reachedAt: number | null = null;
  while (trainer.steps < maxSteps) {
    const { step, accuracy } = trainer.step();
    if (accuracy >= target && reachedAt === null) reachedAt = step;
    if (accuracy < target) reachedAt = null;
    if (reachedAt !== null && step - reachedAt >= patience) break;
  }
  const last = trainer.last;
  return { steps: trainer.steps, accuracy: last?.accuracy ?? trainer.accuracy(), loss: last?.loss ?? NaN, reachedAt };
}
