import { describe, expect, it } from "vitest";
import {
  DEFAULT_GA, GENE_COUNT, GENE_RANGES, Evolution, cloneGenome, crossover, defaultEvolution, fromGenes, mutate,
  nextGeneration, rankIndices, toGenes, tournament, type GaConfig,
} from "../src/ga";
import { MAX_WHEELS, MIN_WHEELS, randomGenome, type Genome } from "../src/genome";
import { Rng } from "../src/rng";
import { inBounds } from "./helpers";

const rngOf = (seed: number) => new Rng(seed);

function fourWheels(rng: Rng): Genome {
  let g = randomGenome(rng);
  while (g.wheels.length < MAX_WHEELS) g = randomGenome(rng);
  return g;
}

describe("gene vector", () => {
  it("round-trips every genome", () => {
    const rng = rngOf(1);
    for (let i = 0; i < 100; i++) {
      const g = randomGenome(rng);
      const genes = toGenes(g);
      expect(genes).toHaveLength(GENE_COUNT);
      expect(fromGenes(genes)).toEqual(g);
    }
    expect(GENE_RANGES).toHaveLength(GENE_COUNT);
  });

  it("grows a missing wheel from its neighbour", () => {
    const rng = rngOf(2);
    let g = randomGenome(rng);
    while (g.wheels.length !== 2) g = randomGenome(rng);
    const genes = toGenes(g);
    genes[17] = 3;
    const grown = fromGenes(genes);
    expect(grown.wheels).toHaveLength(3);
    expect(inBounds(grown)).toBe(true);
  });
});

describe("crossover", () => {
  for (const kind of ["uniform", "single-point"] as const) {
    it(`${kind}: outputs valid genomes with genes from both parents`, () => {
      const rng = rngOf(3);
      for (let i = 0; i < 100; i++) {
        const a = fourWheels(rng);
        const b = fourWheels(rng);
        const child = crossover(rng, a, b, kind);
        expect(inBounds(child)).toBe(true);
        const gc = toGenes(child);
        const ga = toGenes(a);
        const gb = toGenes(b);
        let fromA = 0;
        let fromB = 0;
        for (let k = 0; k < GENE_COUNT; k++) {
          if (gc[k] === ga[k] && gc[k] !== gb[k]) fromA++;
          if (gc[k] === gb[k] && gc[k] !== ga[k]) fromB++;
          expect(gc[k] === ga[k] || gc[k] === gb[k]).toBe(true);
        }
        if (kind === "single-point") {
          expect(fromA).toBeGreaterThan(0);
          expect(fromB).toBeGreaterThan(0);
        }
      }
    });
  }

  it("uniform crossover mixes both parents across many children", () => {
    const rng = rngOf(4);
    const a = fourWheels(rng);
    const b = fourWheels(rng);
    let both = 0;
    for (let i = 0; i < 50; i++) {
      const gc = toGenes(crossover(rng, a, b, "uniform"));
      const ga = toGenes(a);
      const gb = toGenes(b);
      if (gc.some((x, k) => x === ga[k]) && gc.some((x, k) => x === gb[k])) both++;
    }
    expect(both).toBeGreaterThan(45);
  });

  it("single-point crossover is a prefix of one parent and a suffix of the other", () => {
    const rng = rngOf(5);
    const a = fourWheels(rng);
    const b = fourWheels(rng);
    const ga = toGenes(a);
    const gb = toGenes(b);
    const gc = toGenes(crossover(rng, a, b, "single-point"));
    let cut = 0;
    while (cut < GENE_COUNT && gc[cut] === ga[cut]) cut++;
    for (let k = cut; k < GENE_COUNT; k++) expect(gc[k]).toBe(gb[k]);
  });

  it("handles parents with different wheel counts", () => {
    const rng = rngOf(6);
    for (let i = 0; i < 200; i++) {
      const child = crossover(rng, randomGenome(rng), randomGenome(rng), i % 2 ? "uniform" : "single-point");
      expect(inBounds(child)).toBe(true);
      expect(child.wheels.length).toBeGreaterThanOrEqual(MIN_WHEELS);
    }
  });
});

describe("mutate", () => {
  it("rate 0 changes nothing and rate 1 changes (nearly) every gene", () => {
    const rng = rngOf(7);
    const g = fourWheels(rng);
    expect(mutate(rng, g, 0, 0.3)).toEqual(g);
    const ga = toGenes(g);
    const gm = toGenes(mutate(rng, g, 1, 0.3));
    const changed = gm.filter((x, k) => x !== ga[k]).length;
    expect(changed).toBeGreaterThan(GENE_COUNT - 6);
  });

  it("changes about `rate` of the genes", () => {
    const rng = rngOf(8);
    const g = fourWheels(rng);
    const ga = toGenes(g);
    let changed = 0;
    const trials = 400;
    for (let i = 0; i < trials; i++) {
      const gm = toGenes(mutate(rng, g, 0.2, 0.05));
      changed += gm.filter((x, k) => x !== ga[k]).length;
    }
    const frac = changed / (trials * GENE_COUNT);
    // Clamping and rounding hide a few changes, so allow a little under the rate.
    expect(frac).toBeGreaterThan(0.12);
    expect(frac).toBeLessThan(0.22);
  });

  it("always stays in bounds, even with huge strength", () => {
    const rng = rngOf(9);
    for (let i = 0; i < 300; i++) expect(inBounds(mutate(rng, randomGenome(rng), 1, 5))).toBe(true);
  });

  it("strength scales the size of changes", () => {
    const g = fourWheels(rngOf(10));
    const drift = (strength: number) => {
      const rng = rngOf(11);
      let total = 0;
      for (let i = 0; i < 100; i++) total += Math.abs(mutate(rng, g, 1, strength).vertices[0].radius - g.vertices[0].radius);
      return total;
    };
    expect(drift(0.4)).toBeGreaterThan(drift(0.02) * 3);
  });
});

describe("tournament", () => {
  it("favors fitter genomes over many trials", () => {
    const rng = rngOf(12);
    const fitness = Array.from({ length: 20 }, (_, i) => i);
    const wins = new Array(20).fill(0);
    for (let i = 0; i < 20000; i++) wins[tournament(rng, fitness, 3)]++;
    const topHalf = wins.slice(10).reduce((a, b) => a + b, 0);
    const bottomHalf = wins.slice(0, 10).reduce((a, b) => a + b, 0);
    expect(topHalf).toBeGreaterThan(bottomHalf * 2.5);
    expect(wins[19]).toBeGreaterThan(wins[0] * 10);
  });

  it("size 1 is a uniform pick and a bigger size is more selective", () => {
    const fitness = Array.from({ length: 10 }, (_, i) => i);
    const mean = (k: number) => {
      const rng = rngOf(13);
      let s = 0;
      for (let i = 0; i < 5000; i++) s += tournament(rng, fitness, k);
      return s / 5000;
    };
    expect(mean(1)).toBeGreaterThan(4);
    expect(mean(1)).toBeLessThan(5);
    expect(mean(5)).toBeGreaterThan(mean(2));
  });
});

describe("nextGeneration", () => {
  const cfg: GaConfig = { ...DEFAULT_GA, populationSize: 12, elites: 3 };

  it("elitism keeps the top K unchanged, best first", () => {
    const rng = rngOf(14);
    const genomes = Array.from({ length: 12 }, () => randomGenome(rng));
    const fitness = genomes.map((_, i) => ((i * 7) % 12) + 1);
    const order = rankIndices(fitness);
    const next = nextGeneration(rng, genomes, fitness, cfg);
    expect(next).toHaveLength(12);
    for (let i = 0; i < 3; i++) expect(next[i]).toEqual(genomes[order[i]]);
    next.forEach((g) => expect(inBounds(g)).toBe(true));
  });

  it("does not alias elite genomes with the old population", () => {
    const rng = rngOf(15);
    const genomes = Array.from({ length: 6 }, () => randomGenome(rng));
    const next = nextGeneration(rng, genomes, [5, 4, 3, 2, 1, 0], { ...cfg, populationSize: 6, elites: 2 });
    next[0].vertices[0].radius = 99;
    expect(genomes[0].vertices[0].radius).not.toBe(99);
  });

  it("resizes the population and caps elites", () => {
    const rng = rngOf(16);
    const genomes = Array.from({ length: 6 }, () => randomGenome(rng));
    const fit = [1, 2, 3, 4, 5, 6];
    expect(nextGeneration(rng, genomes, fit, { ...cfg, populationSize: 20 })).toHaveLength(20);
    expect(nextGeneration(rng, genomes, fit, { ...cfg, populationSize: 4, elites: 10 })).toHaveLength(4);
    expect(nextGeneration(rng, genomes, fit, { ...cfg, elites: 0, crossoverRate: 0 })).toHaveLength(12);
  });

  it("is deterministic for a seed", () => {
    const mk = () => {
      const rng = rngOf(17);
      const genomes = Array.from({ length: 10 }, () => randomGenome(rng));
      return nextGeneration(rng, genomes, genomes.map((_, i) => i), cfg);
    };
    expect(mk()).toEqual(mk());
  });

  it("rankIndices sorts best first and breaks ties by index", () => {
    expect(rankIndices([1, 5, 5, 2])).toEqual([1, 2, 3, 0]);
  });

  it("cloneGenome is deep", () => {
    const g = randomGenome(rngOf(18));
    const c = cloneGenome(g);
    expect(c).toEqual(g);
    c.wheels[0].radius = 0;
    expect(g.wheels[0].radius).not.toBe(0);
  });
});

describe("Evolution", () => {
  it("records stats, advances and keeps the elite genome", () => {
    const cfg = defaultEvolution(5);
    cfg.ga.populationSize = 6;
    const evo = new Evolution(cfg);
    expect(evo.genomes).toHaveLength(6);
    const stats = evo.record([1, 9, 3, 4, 5, 2]);
    expect(stats).toMatchObject({ generation: 1, best: 9, worst: 1 });
    expect(stats.average).toBeCloseTo(4);
    expect(stats.bestGenome).toEqual(evo.genomes[1]);
    const best = evo.genomes[1];
    evo.advance();
    expect(evo.generation).toBe(2);
    expect(evo.genomes[0]).toEqual(best);
  });

  it("runGeneration simulates the population and stores fitness", () => {
    const cfg = defaultEvolution(6);
    cfg.ga.populationSize = 4;
    const evo = new Evolution(cfg);
    const stats = evo.runGeneration();
    expect(evo.fitness).toHaveLength(4);
    expect(stats.best).toBe(Math.max(...evo.fitness));
    expect(evo.history).toHaveLength(1);
  });

  it("changing the terrain seed rebuilds the track", () => {
    const evo = new Evolution(defaultEvolution(1));
    const before = evo.terrain.points[200].y;
    evo.setTerrainSeed(99);
    expect(evo.cfg.terrainSeed).toBe(99);
    expect(evo.terrain.points[200].y).not.toBe(before);
  });
});
