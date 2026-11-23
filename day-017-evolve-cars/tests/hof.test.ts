import { describe, expect, it } from "vitest";
import { cloneGenome, type GenerationStats } from "../src/ga";
import { randomGenome, type Genome } from "../src/genome";
import {
  FORMAT_VERSION, GENOME_FORMAT, GenomeImportError, HOF_FORMAT, HallOfFame, exportGenome, exportHof, importGenome,
  importHof, parseGenome,
} from "../src/hof";
import { Rng } from "../src/rng";
import { inBounds } from "./helpers";

const rng = new Rng(77);
const stats = (generation: number, best: number, g = randomGenome(rng)): GenerationStats => ({
  generation, best, average: best / 2, worst: 0, bestGenome: g,
});

describe("HallOfFame", () => {
  it("keeps one entry per generation and copies the genome", () => {
    const hof = new HallOfFame();
    const s = stats(1, 10);
    const entry = hof.add(s, 42);
    expect(hof.entries).toHaveLength(1);
    expect(entry).toMatchObject({ generation: 1, distance: 10, terrainSeed: 42 });
    s.bestGenome.chassisDensity = 123;
    expect(hof.entries[0].genome.chassisDensity).not.toBe(123);
  });

  it("finds the best entry, earliest on a tie, and can be cleared", () => {
    const hof = new HallOfFame();
    expect(hof.best()).toBeNull();
    hof.add(stats(1, 10), 1);
    hof.add(stats(2, 30), 1);
    hof.add(stats(3, 30), 1);
    hof.add(stats(4, 5), 1);
    expect(hof.best()!.generation).toBe(2);
    hof.clear();
    expect(hof.entries).toEqual([]);
  });
});

describe("genome export and import", () => {
  it("round-trips exactly for many random genomes", () => {
    const r = new Rng(5);
    for (let i = 0; i < 100; i++) {
      const g = randomGenome(r);
      expect(importGenome(exportGenome(g))).toEqual(g);
    }
  });

  it("round-trips metadata and the exported text is stable", () => {
    const g = randomGenome(rng);
    const text = exportGenome(g, { generation: 7, distance: 123.456, terrainSeed: 9 });
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ format: GENOME_FORMAT, version: FORMAT_VERSION, generation: 7, distance: 123.456, terrainSeed: 9 });
    expect(exportGenome(importGenome(text), { generation: 7, distance: 123.456, terrainSeed: 9 })).toBe(text);
  });

  it("accepts a bare genome object", () => {
    const g = randomGenome(rng);
    expect(importGenome(JSON.stringify(g))).toEqual(g);
  });

  it("round-trips a whole hall of fame", () => {
    const hof = new HallOfFame();
    for (let i = 1; i <= 5; i++) hof.add(stats(i, i * 11.5), 42);
    expect(importHof(exportHof(hof))).toEqual(hof.entries);
  });

  it("importHof also takes a single genome file", () => {
    const g = randomGenome(rng);
    const [entry] = importHof(exportGenome(g, { generation: 3, distance: 50, terrainSeed: 8 }));
    expect(entry).toEqual({ generation: 3, distance: 50, terrainSeed: 8, genome: g });
    expect(importHof(JSON.stringify(g))[0]).toMatchObject({ generation: 0, distance: 0, genome: g });
  });

  it("clamps out of range values instead of building a broken car", () => {
    const g: Genome = cloneGenome(randomGenome(rng));
    g.vertices[2].radius = 500;
    g.chassisDensity = -4;
    const back = importGenome(JSON.stringify(g));
    expect(inBounds(back)).toBe(true);
  });
});

describe("import errors are clear", () => {
  const expectError = (fn: () => unknown, text: RegExp) => {
    expect(fn).toThrow(GenomeImportError);
    expect(fn).toThrow(text);
  };

  it("reports bad JSON", () => {
    expectError(() => importGenome("{not json"), /^Invalid JSON: /);
    expectError(() => importGenome(""), /^Invalid JSON: /);
    expectError(() => importHof("nope"), /^Invalid JSON: /);
  });

  it("reports the wrong shape", () => {
    expectError(() => importGenome("42"), /expected an object/);
    expectError(() => importGenome("[]"), /expected an object/);
    expectError(() => importGenome("{}"), /vertices must be an array of 8 items, got undefined/);
    const g = randomGenome(rng);
    expectError(() => parseGenome({ ...g, vertices: g.vertices.slice(0, 5) }), /got 5/);
    expectError(() => parseGenome({ ...g, wheels: [] }), /wheels must be an array of 2 to 4 items, got 0/);
    expectError(() => parseGenome({ ...g, wheels: "x" }), /got string/);
  });

  it("reports the exact bad field", () => {
    const g = randomGenome(rng);
    const bad = (mut: (c: any) => void) => {
      const c = JSON.parse(JSON.stringify(g));
      mut(c);
      return c;
    };
    expectError(() => parseGenome(bad((c) => (c.vertices[3].radius = "big"))), /vertices\[3\]\.radius must be a finite number, got "big"/);
    expectError(() => parseGenome(bad((c) => (c.vertices[0] = 5))), /vertices\[0\] must be an object/);
    expectError(() => parseGenome(bad((c) => (c.wheels[1].density = null))), /wheels\[1\]\.density must be a finite number, got null/);
    expectError(() => parseGenome(bad((c) => (c.wheels[0] = []))), /wheels\[0\] must be an object/);
    expectError(() => parseGenome(bad((c) => delete c.chassisDensity)), /chassisDensity must be a finite number, got nothing/);
  });

  it("rejects mixed up file types and versions", () => {
    const hof = new HallOfFame();
    hof.add(stats(1, 1), 1);
    expectError(() => importGenome(exportHof(hof)), /hall of fame, not a single genome/);
    expectError(() => importGenome(JSON.stringify({ format: GENOME_FORMAT, version: 99, genome: randomGenome(rng) })), /Unsupported version 99/);
    expectError(() => importHof(JSON.stringify({ format: HOF_FORMAT, version: 2, entries: [] })), /Unsupported version 2/);
    expectError(() => importHof("[]"), /expected an object/);
    expectError(() => importHof(JSON.stringify({ format: HOF_FORMAT, entries: {} })), /entries must be an array/);
    expectError(() => importHof(JSON.stringify({ format: HOF_FORMAT, entries: [1] })), /entries\[0\] must be an object/);
    expectError(() => importHof(JSON.stringify({ format: HOF_FORMAT, entries: [{ generation: "a" }] })), /entries\[0\]\.generation/);
  });
});
