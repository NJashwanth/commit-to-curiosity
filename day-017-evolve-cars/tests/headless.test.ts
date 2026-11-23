import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importGenome } from "../src/hof";
import { DEFAULT_OPTIONS, formatStats, main, parseArgs, runHeadless, toConfig } from "../src/headless";

const small = (seed: number, population = 8) => toConfig({ ...DEFAULT_OPTIONS, seed, population });

describe("runHeadless", () => {
  it("same seed and config give identical generation results", () => {
    const a = runHeadless(small(42), 3);
    const b = runHeadless(small(42), 3);
    expect(b.history).toEqual(a.history);
    expect(b.evolution.genomes).toEqual(a.evolution.genomes);
    expect(b.evolution.fitness).toEqual(a.evolution.fitness);
  });

  it("different seeds give different runs", () => {
    expect(runHeadless(small(1), 2).history).not.toEqual(runHeadless(small(2), 2).history);
  });

  it("fills the hall of fame with one entry per generation", () => {
    const r = runHeadless(small(3, 6), 3);
    expect(r.hof.entries.map((e) => e.generation)).toEqual([1, 2, 3]);
    expect(r.hof.entries.map((e) => e.distance)).toEqual(r.history.map((h) => h.best));
  });

  it("carries each generation's best car into the next population (elitism)", () => {
    const evo = runHeadless(small(4, 10), 1).evolution;
    const best = evo.history[0].bestGenome;
    evo.advance();
    expect(evo.genomes[0]).toEqual(best);
  });

  it("a seeded 15-generation run improves best fitness over generation 1", { timeout: 180_000 }, () => {
    const cfg = toConfig({ ...DEFAULT_OPTIONS, seed: 42, population: 20 });
    const seen: number[] = [];
    const r = runHeadless(cfg, 15, (s) => seen.push(s.generation));
    expect(seen).toHaveLength(15);
    const first = r.history[0];
    const last = r.history[14];
    expect(last.best).toBeGreaterThan(first.best);
    expect(last.average).toBeGreaterThan(first.average);
  });
});

describe("cli", () => {
  it("parses options", () => {
    const o = parseArgs(["--generations", "50", "--seed", "42", "--population", "10", "--mutation-rate", "0.2", "--mutation-strength", "0.3", "--crossover", "single-point", "--elites", "3", "--terrain-seed", "7", "--export", "x.json", "--quiet", "--"]);
    expect(o).toMatchObject({ generations: 50, seed: 42, population: 10, mutationRate: 0.2, mutationStrength: 0.3, crossover: "single-point", elites: 3, terrainSeed: 7, exportPath: "x.json", quiet: true });
    expect(toConfig(o).terrainSeed).toBe(7);
    expect(toConfig(parseArgs([])).terrainSeed).toBe(DEFAULT_OPTIONS.seed);
  });

  it("rejects bad options with a clear message", () => {
    expect(() => parseArgs(["--generations", "0"])).toThrow(/--generations must be an integer >= 1, got "0"/);
    expect(() => parseArgs(["--seed", "abc"])).toThrow(/--seed must be/);
    expect(() => parseArgs(["--mutation-rate"])).toThrow(/Missing value for --mutation-rate/);
    expect(() => parseArgs(["--crossover", "blend"])).toThrow(/uniform or single-point/);
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option --nope/);
  });

  it("main prints per-generation stats and can export the best genome", () => {
    const dir = mkdtempSync(join(tmpdir(), "evolve-"));
    const file = join(dir, "best.json");
    try {
      const lines: string[] = [];
      const code = main(["--generations", "2", "--population", "6", "--seed", "5", "--export", file], (l) => lines.push(l));
      expect(code).toBe(0);
      expect(lines.filter((l) => l.startsWith("gen "))).toHaveLength(2);
      expect(lines.some((l) => l.startsWith("best overall:"))).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(importGenome(readFileSync(file, "utf8")).wheels.length).toBeGreaterThanOrEqual(2);

      const quiet: string[] = [];
      main(["--generations", "1", "--population", "4", "--quiet"], (l) => quiet.push(l));
      expect(quiet.some((l) => l.startsWith("gen "))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main shows usage for --help and for bad arguments", () => {
    const out: string[] = [];
    expect(main(["--help"], (l) => out.push(l))).toBe(0);
    expect(out[0]).toContain("Usage: npm run evolve");
    const bad: string[] = [];
    expect(main(["--generations", "x"], (l) => bad.push(l))).toBe(1);
    expect(bad[0]).toContain("--generations must be");
  });

  it("formats a stats line", () => {
    const line = formatStats({ generation: 7, best: 123.456, average: 50, worst: 0, bestGenome: null as never });
    expect(line).toBe("gen   7  best   123.5 m  avg    50.0 m  worst    0.0 m");
  });
});
