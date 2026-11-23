import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_GA, Evolution, defaultEvolution, type CrossoverKind, type EvolutionConfig, type GenerationStats } from "./ga";
import { HallOfFame, exportGenome } from "./hof";

// Headless evolution in Node: the same Evolution class the browser uses.
//   npm run evolve -- --generations 50 --seed 42

export interface HeadlessOptions {
  generations: number;
  seed: number;
  terrainSeed: number | null;
  population: number;
  mutationRate: number;
  mutationStrength: number;
  crossover: CrossoverKind;
  elites: number;
  exportPath: string | null;
  quiet: boolean;
}

export const DEFAULT_OPTIONS: HeadlessOptions = {
  generations: 20,
  seed: 42,
  terrainSeed: null,
  population: DEFAULT_GA.populationSize,
  mutationRate: DEFAULT_GA.mutationRate,
  mutationStrength: DEFAULT_GA.mutationStrength,
  crossover: DEFAULT_GA.crossover,
  elites: DEFAULT_GA.elites,
  exportPath: null,
  quiet: false,
};

export const USAGE = `Usage: npm run evolve -- [options]
  --generations N       generations to run (default ${DEFAULT_OPTIONS.generations})
  --seed N              evolution seed (default ${DEFAULT_OPTIONS.seed})
  --terrain-seed N      terrain seed (default: same as --seed)
  --population N        cars per generation (default ${DEFAULT_OPTIONS.population})
  --mutation-rate X     per gene mutation chance (default ${DEFAULT_OPTIONS.mutationRate})
  --mutation-strength X gaussian sd as a fraction of each gene range (default ${DEFAULT_OPTIONS.mutationStrength})
  --crossover KIND      uniform or single-point (default ${DEFAULT_OPTIONS.crossover})
  --elites K            top K carried over unchanged (default ${DEFAULT_OPTIONS.elites})
  --export FILE         write the best genome as JSON
  --quiet               only print the final summary`;

export function parseArgs(argv: string[]): HeadlessOptions {
  const o: HeadlessOptions = { ...DEFAULT_OPTIONS };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`Missing value for ${flag}`);
    return v;
  };
  const numeric = (i: number, flag: string, min: number, integer: boolean): number => {
    const raw = need(i, flag);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
      throw new Error(`${flag} must be ${integer ? "an integer" : "a number"} >= ${min}, got "${raw}"`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--generations": o.generations = numeric(i++, flag, 1, true); break;
      case "--seed": o.seed = numeric(i++, flag, 0, true); break;
      case "--terrain-seed": o.terrainSeed = numeric(i++, flag, 0, true); break;
      case "--population": o.population = numeric(i++, flag, 2, true); break;
      case "--mutation-rate": o.mutationRate = numeric(i++, flag, 0, false); break;
      case "--mutation-strength": o.mutationStrength = numeric(i++, flag, 0, false); break;
      case "--elites": o.elites = numeric(i++, flag, 0, true); break;
      case "--crossover": {
        const v = need(i++, flag);
        if (v !== "uniform" && v !== "single-point") throw new Error(`--crossover must be uniform or single-point, got "${v}"`);
        o.crossover = v;
        break;
      }
      case "--export": o.exportPath = need(i++, flag); break;
      case "--quiet": o.quiet = true; break;
      case "--": break;
      default: throw new Error(`Unknown option ${flag}`);
    }
  }
  return o;
}

export function toConfig(o: HeadlessOptions): EvolutionConfig {
  const cfg = defaultEvolution(o.seed);
  cfg.terrainSeed = o.terrainSeed ?? o.seed;
  cfg.ga = {
    ...cfg.ga,
    populationSize: o.population,
    mutationRate: o.mutationRate,
    mutationStrength: o.mutationStrength,
    crossover: o.crossover,
    elites: o.elites,
  };
  return cfg;
}

export interface HeadlessResult {
  history: GenerationStats[];
  hof: HallOfFame;
  evolution: Evolution;
}

export function formatStats(s: GenerationStats): string {
  const pad = (v: number, w: number) => v.toFixed(1).padStart(w);
  return `gen ${String(s.generation).padStart(3)}  best ${pad(s.best, 7)} m  avg ${pad(s.average, 7)} m  worst ${pad(s.worst, 6)} m`;
}

/** Run `generations` generations. Deterministic for a given config. */
export function runHeadless(cfg: EvolutionConfig, generations: number, onGeneration?: (s: GenerationStats) => void): HeadlessResult {
  const evolution = new Evolution(cfg);
  const hof = new HallOfFame();
  for (let g = 0; g < generations; g++) {
    const stats = evolution.runGeneration();
    hof.add(stats, cfg.terrainSeed);
    onGeneration?.(stats);
    if (g < generations - 1) evolution.advance();
  }
  return { history: evolution.history, hof, evolution };
}

export function main(argv: string[], out: (line: string) => void = console.log): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(USAGE);
    return 0;
  }
  let opts: HeadlessOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    out(`${(e as Error).message}\n${USAGE}`);
    return 1;
  }
  const cfg = toConfig(opts);
  out(`evolve-cars: ${opts.generations} generations, population ${opts.population}, seed ${opts.seed}, terrain ${cfg.terrainSeed}, ${opts.crossover} crossover`);
  const started = Date.now();
  const result = runHeadless(cfg, opts.generations, (s) => {
    if (!opts.quiet) out(formatStats(s));
  });
  const best = result.hof.best()!;
  out(`best overall: ${best.distance.toFixed(1)} m in generation ${best.generation} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (opts.exportPath) {
    writeFileSync(opts.exportPath, exportGenome(best.genome, best) + "\n");
    out(`wrote ${opts.exportPath}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
