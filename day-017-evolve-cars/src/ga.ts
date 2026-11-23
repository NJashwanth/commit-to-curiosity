import {
  BOUNDS, MAX_WHEELS, MIN_WHEELS, SECTOR, VERTEX_COUNT, clampGenome, randomGenome, type Genome, type Wheel,
} from "./genome";
import { Rng } from "./rng";
import { DEFAULT_SIM, evaluate, type SimConfig } from "./sim";
import { generateTerrain, type Terrain } from "./terrain";

// Genetic algorithm: tournament selection, uniform or single-point crossover,
// Gaussian mutation and elitism. Genomes are flattened to a fixed gene vector
// so crossover and mutation can treat every gene the same way.
//
// Layout (30 genes):
//   0          chassis density
//   1..16      vertex i angle and radius
//   17         wheel count
//   18..29     four wheel slots of (vertex, radius, density)
// A wheel slot past the wheel count is `undefined` (dormant) in a parent.

export type CrossoverKind = "uniform" | "single-point";
export type Genes = (number | undefined)[];

export const GENE_COUNT = 30;
const COUNT_GENE = 17;
const WHEEL_BASE = 18;

export interface GaConfig {
  populationSize: number;
  tournamentSize: number;
  crossover: CrossoverKind;
  /** Chance that two selected parents are crossed (otherwise the child copies one). */
  crossoverRate: number;
  /** Per gene chance of mutating. */
  mutationRate: number;
  /** Gaussian sd of a mutation as a fraction of the gene's range. */
  mutationStrength: number;
  /** Top K genomes copied unchanged into the next generation. */
  elites: number;
}

export const DEFAULT_GA: GaConfig = {
  populationSize: 30,
  tournamentSize: 3,
  crossover: "uniform",
  crossoverRate: 0.9,
  mutationRate: 0.1,
  mutationStrength: 0.2,
  elites: 2,
};

/** Min and max of every gene, used to scale and bound mutation. */
export const GENE_RANGES: { min: number; max: number }[] = (() => {
  const r: { min: number; max: number }[] = [BOUNDS.chassisDensity];
  for (let i = 0; i < VERTEX_COUNT; i++) {
    r.push({ min: i * SECTOR + BOUNDS.angleFraction.min * SECTOR, max: i * SECTOR + BOUNDS.angleFraction.max * SECTOR });
    r.push(BOUNDS.radius);
  }
  r.push({ min: MIN_WHEELS, max: MAX_WHEELS });
  for (let k = 0; k < MAX_WHEELS; k++) r.push({ min: 0, max: VERTEX_COUNT - 1 }, BOUNDS.wheelRadius, BOUNDS.wheelDensity);
  return r;
})();

export function toGenes(g: Genome): Genes {
  const genes: Genes = [g.chassisDensity];
  for (const v of g.vertices) genes.push(v.angle, v.radius);
  genes.push(g.wheels.length);
  for (let k = 0; k < MAX_WHEELS; k++) {
    const w = g.wheels[k];
    genes.push(w?.vertex, w?.radius, w?.density);
  }
  return genes;
}

export function fromGenes(genes: Genes): Genome {
  const vertices = [];
  for (let i = 0; i < VERTEX_COUNT; i++) vertices.push({ angle: genes[1 + 2 * i] as number, radius: genes[2 + 2 * i] as number });
  const count = Math.min(MAX_WHEELS, Math.max(MIN_WHEELS, Math.round(genes[COUNT_GENE] as number)));
  const wheels: Wheel[] = [];
  for (let k = 0; k < count; k++) {
    const base = WHEEL_BASE + 3 * k;
    if (genes[base] !== undefined) {
      wheels.push({ vertex: genes[base] as number, radius: genes[base + 1] as number, density: genes[base + 2] as number });
    } else {
      // A newly grown wheel copies an existing one, moved to the opposite side of the body.
      const src: Wheel = wheels[(k - 1 + wheels.length) % wheels.length] ?? { vertex: 0, radius: 0.3, density: 1 };
      wheels.push({ ...src, vertex: (src.vertex + VERTEX_COUNT / 2) % VERTEX_COUNT });
    }
  }
  return clampGenome({ vertices, wheels, chassisDensity: genes[0] as number });
}

/** Pick the gene from `first`, falling back to `second` when `first` has it dormant. */
function pickGene(first: Genes, second: Genes, i: number): number | undefined {
  return first[i] ?? second[i];
}

export function crossover(rng: Rng, a: Genome, b: Genome, kind: CrossoverKind): Genome {
  const ga = toGenes(a);
  const gb = toGenes(b);
  const child: Genes = new Array(GENE_COUNT);
  if (kind === "single-point") {
    // The cut lies strictly inside the vector so both parents always contribute.
    const cut = rng.int(1, GENE_COUNT - 1);
    for (let i = 0; i < GENE_COUNT; i++) child[i] = i < cut ? pickGene(ga, gb, i) : pickGene(gb, ga, i);
  } else {
    for (let i = 0; i < GENE_COUNT; i++) child[i] = rng.chance(0.5) ? pickGene(ga, gb, i) : pickGene(gb, ga, i);
  }
  return fromGenes(child);
}

/** Add Gaussian noise to each gene with probability `rate`. Always returns a valid genome. */
export function mutate(rng: Rng, g: Genome, rate: number, strength: number): Genome {
  const genes = toGenes(g);
  for (let i = 0; i < GENE_COUNT; i++) {
    const v = genes[i];
    if (v === undefined || !rng.chance(rate)) continue;
    const range = GENE_RANGES[i].max - GENE_RANGES[i].min;
    genes[i] = v + rng.gaussian(0, strength * range);
  }
  return fromGenes(genes);
}

/** Index of the fittest among `k` random contestants. */
export function tournament(rng: Rng, fitness: readonly number[], k: number): number {
  let best = rng.int(0, fitness.length - 1);
  for (let i = 1; i < k; i++) {
    const c = rng.int(0, fitness.length - 1);
    if (fitness[c] > fitness[best]) best = c;
  }
  return best;
}

export function cloneGenome(g: Genome): Genome {
  return {
    vertices: g.vertices.map((v) => ({ ...v })),
    wheels: g.wheels.map((w) => ({ ...w })),
    chassisDensity: g.chassisDensity,
  };
}

/** Indices sorted by fitness, best first (ties keep the lower index first so it is stable). */
export function rankIndices(fitness: readonly number[]): number[] {
  return fitness.map((_, i) => i).sort((x, y) => fitness[y] - fitness[x] || x - y);
}

export function nextGeneration(rng: Rng, genomes: readonly Genome[], fitness: readonly number[], cfg: GaConfig): Genome[] {
  const size = Math.max(2, Math.floor(cfg.populationSize));
  const order = rankIndices(fitness);
  const next: Genome[] = [];
  const elites = Math.min(Math.max(0, Math.floor(cfg.elites)), size, genomes.length);
  for (let i = 0; i < elites; i++) next.push(cloneGenome(genomes[order[i]]));
  while (next.length < size) {
    const pa = genomes[tournament(rng, fitness, cfg.tournamentSize)];
    const pb = genomes[tournament(rng, fitness, cfg.tournamentSize)];
    const child = rng.chance(cfg.crossoverRate) ? crossover(rng, pa, pb, cfg.crossover) : cloneGenome(pa);
    next.push(mutate(rng, child, cfg.mutationRate, cfg.mutationStrength));
  }
  return next;
}

export interface GenerationStats {
  generation: number;
  best: number;
  average: number;
  worst: number;
  bestGenome: Genome;
}

export interface EvolutionConfig {
  seed: number;
  terrainSeed: number;
  ga: GaConfig;
  sim: SimConfig;
}

export function defaultEvolution(seed = 42): EvolutionConfig {
  return { seed, terrainSeed: seed, ga: { ...DEFAULT_GA }, sim: DEFAULT_SIM };
}

/** Owns the population and drives generation after generation. Fully seeded. */
export class Evolution {
  readonly rng: Rng;
  terrain: Terrain;
  genomes: Genome[];
  fitness: number[] = [];
  generation = 1;
  history: GenerationStats[] = [];

  constructor(public cfg: EvolutionConfig) {
    this.rng = new Rng(cfg.seed);
    this.terrain = generateTerrain(cfg.terrainSeed);
    this.genomes = Array.from({ length: cfg.ga.populationSize }, () => randomGenome(this.rng));
  }

  setTerrainSeed(seed: number): void {
    this.cfg.terrainSeed = seed;
    this.terrain = generateTerrain(seed);
  }

  /** Record fitness for the current population (from a finished simulation) and return its stats. */
  record(fitness: number[]): GenerationStats {
    this.fitness = fitness;
    const order = rankIndices(fitness);
    const stats: GenerationStats = {
      generation: this.generation,
      best: fitness[order[0]],
      average: fitness.reduce((a, b) => a + b, 0) / fitness.length,
      worst: fitness[order[order.length - 1]],
      bestGenome: cloneGenome(this.genomes[order[0]]),
    };
    this.history.push(stats);
    return stats;
  }

  /** Simulate the current population to the end and record the result. */
  runGeneration(): GenerationStats {
    return this.record(evaluate(this.terrain, this.genomes, this.cfg.sim));
  }

  /** Breed the next population from the recorded fitness. */
  advance(): void {
    this.genomes = nextGeneration(this.rng, this.genomes, this.fitness, this.cfg.ga);
    this.generation++;
  }
}
