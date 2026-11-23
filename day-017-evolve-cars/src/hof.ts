import { cloneGenome, type GenerationStats } from "./ga";
import { MAX_WHEELS, MIN_WHEELS, VERTEX_COUNT, clampGenome, type Genome } from "./genome";

// Hall of fame: the best car of every generation, plus JSON export and import.
// JSON numbers round-trip exactly, so export then import returns an equal genome.

export const GENOME_FORMAT = "evolve-cars/genome";
export const HOF_FORMAT = "evolve-cars/hall-of-fame";
export const FORMAT_VERSION = 1;

export interface HofEntry {
  generation: number;
  distance: number;
  terrainSeed: number;
  genome: Genome;
}

export class GenomeImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenomeImportError";
  }
}

export class HallOfFame {
  entries: HofEntry[] = [];

  /** Keep the best car of a finished generation. */
  add(stats: GenerationStats, terrainSeed: number): HofEntry {
    const entry: HofEntry = {
      generation: stats.generation,
      distance: stats.best,
      terrainSeed,
      genome: cloneGenome(stats.bestGenome),
    };
    this.entries.push(entry);
    return entry;
  }

  /** The all-time best entry (earliest wins a tie). */
  best(): HofEntry | null {
    let best: HofEntry | null = null;
    for (const e of this.entries) if (!best || e.distance > best.distance) best = e;
    return best;
  }

  clear(): void {
    this.entries = [];
  }
}

// ---- export ---------------------------------------------------------------

export function exportGenome(genome: Genome, meta: { generation?: number; distance?: number; terrainSeed?: number } = {}): string {
  return JSON.stringify({ format: GENOME_FORMAT, version: FORMAT_VERSION, ...meta, genome }, null, 2);
}

export function exportHof(hof: HallOfFame): string {
  return JSON.stringify({ format: HOF_FORMAT, version: FORMAT_VERSION, entries: hof.entries }, null, 2);
}

// ---- import ---------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new GenomeImportError(`Invalid genome: ${path} must be a finite number, got ${JSON.stringify(v) ?? "nothing"}`);
  }
  return v;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new GenomeImportError(`Invalid JSON: ${(e as Error).message}`);
  }
}

/** Validate an untrusted value as a genome. Out of range values are clamped. */
export function parseGenome(value: unknown): Genome {
  if (!isObject(value)) throw new GenomeImportError("Invalid genome: expected an object");
  const { vertices, wheels } = value;
  if (!Array.isArray(vertices) || vertices.length !== VERTEX_COUNT) {
    throw new GenomeImportError(
      `Invalid genome: vertices must be an array of ${VERTEX_COUNT} items, got ${Array.isArray(vertices) ? vertices.length : typeof vertices}`,
    );
  }
  if (!Array.isArray(wheels) || wheels.length < MIN_WHEELS || wheels.length > MAX_WHEELS) {
    throw new GenomeImportError(
      `Invalid genome: wheels must be an array of ${MIN_WHEELS} to ${MAX_WHEELS} items, got ${Array.isArray(wheels) ? wheels.length : typeof wheels}`,
    );
  }
  const genome: Genome = {
    vertices: vertices.map((v, i) => {
      if (!isObject(v)) throw new GenomeImportError(`Invalid genome: vertices[${i}] must be an object`);
      return { angle: num(v.angle, `vertices[${i}].angle`), radius: num(v.radius, `vertices[${i}].radius`) };
    }),
    wheels: wheels.map((w, i) => {
      if (!isObject(w)) throw new GenomeImportError(`Invalid genome: wheels[${i}] must be an object`);
      return {
        vertex: num(w.vertex, `wheels[${i}].vertex`),
        radius: num(w.radius, `wheels[${i}].radius`),
        density: num(w.density, `wheels[${i}].density`),
      };
    }),
    chassisDensity: num(value.chassisDensity, "chassisDensity"),
  };
  return clampGenome(genome);
}

function checkVersion(obj: Record<string, unknown>): void {
  if (obj.version !== undefined && obj.version !== FORMAT_VERSION) {
    throw new GenomeImportError(`Unsupported version ${JSON.stringify(obj.version)}, expected ${FORMAT_VERSION}`);
  }
}

/** Import one genome from a genome file, or a bare genome object. */
export function importGenome(text: string): Genome {
  const data = parseJson(text);
  if (isObject(data) && data.format === HOF_FORMAT) {
    throw new GenomeImportError("This file is a hall of fame, not a single genome. Use the hall of fame import.");
  }
  if (isObject(data) && data.format === GENOME_FORMAT) {
    checkVersion(data);
    return parseGenome(data.genome);
  }
  return parseGenome(data);
}

/** Import a hall of fame file. A single genome file becomes one entry. */
export function importHof(text: string): HofEntry[] {
  const data = parseJson(text);
  if (!isObject(data)) throw new GenomeImportError("Invalid hall of fame: expected an object");
  if (data.format === HOF_FORMAT) {
    checkVersion(data);
    if (!Array.isArray(data.entries)) throw new GenomeImportError("Invalid hall of fame: entries must be an array");
    return data.entries.map((e, i) => {
      if (!isObject(e)) throw new GenomeImportError(`Invalid hall of fame: entries[${i}] must be an object`);
      return {
        generation: num(e.generation, `entries[${i}].generation`),
        distance: num(e.distance, `entries[${i}].distance`),
        terrainSeed: num(e.terrainSeed, `entries[${i}].terrainSeed`),
        genome: parseGenome(e.genome),
      };
    });
  }
  const genome = importGenome(text);
  const meta = (k: string) => (typeof data[k] === "number" ? (data[k] as number) : 0);
  return [{ generation: meta("generation"), distance: meta("distance"), terrainSeed: meta("terrainSeed"), genome }];
}
