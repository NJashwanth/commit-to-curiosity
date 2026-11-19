/**
 * Seeded 2D toy datasets with ±1 labels. Points sit roughly inside
 * [-1, 1] × [-1, 1] before noise, and noise is the standard deviation of the
 * Gaussian jitter added to each coordinate, in the same units.
 */
import { gaussian, mulberry32, uniform, type Rng } from "./rng";

export const DATASETS = ["moons", "circles", "xor", "spiral"] as const;
export type DatasetName = (typeof DATASETS)[number];

export interface Dataset {
  readonly name: DatasetName;
  /** One [x, y] pair per sample. */
  readonly X: number[][];
  /** +1 or -1 per sample. */
  readonly y: number[];
}

export interface DatasetOptions {
  /** Number of samples, split as evenly as possible between the classes. Default 200. */
  n?: number;
  /** Gaussian noise standard deviation. Default DEFAULT_NOISE[name]. */
  noise?: number;
  /** Default 1. */
  seed?: number;
}

export const MAX_SAMPLES = 2000;

type Generator = (count: number, label: 1 | -1, rng: Rng) => number[][];

/** Two interleaving half circles. */
const moons: Generator = (count, label, rng) =>
  Array.from({ length: count }, () => {
    const t = Math.PI * rng();
    // Upper moon centred at (0, 0), lower one at (1, 0.5) and flipped; then
    // shift and scale both so the pair spans about [-1, 1].
    const [x, y] = label === 1 ? [Math.cos(t), Math.sin(t)] : [1 - Math.cos(t), 0.5 - Math.sin(t)];
    return [(x - 0.5) / 1.5, (y - 0.25) / 1.5];
  });

/** A disc of +1 inside a ring of -1. */
const circles: Generator = (count, label, rng) =>
  Array.from({ length: count }, () => {
    const t = 2 * Math.PI * rng();
    const r = label === 1 ? 0.5 * Math.sqrt(rng()) : uniform(rng, 0.75, 1);
    return [r * Math.cos(t), r * Math.sin(t)];
  });

/** +1 where x and y have the same sign. Points keep a 0.1 gap from the axes. */
const xor: Generator = (count, label, rng) =>
  Array.from({ length: count }, () => {
    const sx = rng() < 0.5 ? 1 : -1;
    const sy = label === 1 ? sx : -sx;
    return [sx * uniform(rng, 0.1, 1), sy * uniform(rng, 0.1, 1)];
  });

/** Two spirals, each making 1.75 turns out from the centre, half a turn apart. */
const spiral: Generator = (count, label, rng) =>
  Array.from({ length: count }, () => {
    const r = uniform(rng, 0.08, 1);
    const t = 3.5 * Math.PI * r + (label === 1 ? 0 : Math.PI);
    return [r * Math.cos(t), r * Math.sin(t)];
  });

const GENERATORS: Record<DatasetName, Generator> = { moons, circles, xor, spiral };

/** Noise that leaves each dataset hard but learnable to 100% by a small MLP. */
export const DEFAULT_NOISE: Record<DatasetName, number> = { moons: 0.1, circles: 0.1, xor: 0.1, spiral: 0.05 };

export function makeDataset(name: DatasetName, options: DatasetOptions = {}): Dataset {
  const generate = GENERATORS[name];
  if (!generate) throw new RangeError(`unknown dataset "${name}"; expected one of ${DATASETS.join(", ")}`);
  const { n = 200, noise = DEFAULT_NOISE[name], seed = 1 } = options;
  if (!Number.isInteger(n) || n < 2 || n > MAX_SAMPLES) {
    throw new RangeError(`sample count must be an integer from 2 to ${MAX_SAMPLES}, got ${n}`);
  }
  if (!(noise >= 0) || !Number.isFinite(noise)) throw new RangeError(`noise must be 0 or more, got ${noise}`);
  if (!Number.isInteger(seed)) throw new RangeError(`seed must be an integer, got ${seed}`);

  const rng = mulberry32(seed);
  const positives = Math.ceil(n / 2);
  const X = [...generate(positives, 1, rng), ...generate(n - positives, -1, rng)];
  const y = X.map((_, i) => (i < positives ? 1 : -1));
  if (noise > 0) {
    for (const p of X) {
      p[0]! += noise * gaussian(rng);
      p[1]! += noise * gaussian(rng);
    }
  }
  return { name, X, y };
}
