import { describe, expect, it } from "vitest";
import {
  BOUNDS, MAX_WHEELS, MIN_WHEELS, VERTEX_COUNT, angleRange, clampGenome, genomeColor, genomeColorCss,
  randomGenome, vertexPoints, type Genome,
} from "../src/genome";
import { Rng } from "../src/rng";

export function inBounds(g: Genome): boolean {
  if (g.vertices.length !== VERTEX_COUNT) return false;
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const v = g.vertices[i];
    const r = angleRange(i);
    if (!(v.angle >= r.min && v.angle <= r.max)) return false;
    if (!(v.radius >= BOUNDS.radius.min && v.radius <= BOUNDS.radius.max)) return false;
  }
  if (g.wheels.length < MIN_WHEELS || g.wheels.length > MAX_WHEELS) return false;
  for (const w of g.wheels) {
    if (!Number.isInteger(w.vertex) || w.vertex < 0 || w.vertex >= VERTEX_COUNT) return false;
    if (!(w.radius >= BOUNDS.wheelRadius.min && w.radius <= BOUNDS.wheelRadius.max)) return false;
    if (!(w.density >= BOUNDS.wheelDensity.min && w.density <= BOUNDS.wheelDensity.max)) return false;
  }
  return g.chassisDensity >= BOUNDS.chassisDensity.min && g.chassisDensity <= BOUNDS.chassisDensity.max;
}

describe("randomGenome", () => {
  it("is always within bounds", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 500; i++) expect(inBounds(randomGenome(rng))).toBe(true);
  });

  it("is deterministic for a seed and covers 2 to 4 wheels", () => {
    expect(randomGenome(new Rng(5))).toEqual(randomGenome(new Rng(5)));
    const rng = new Rng(2);
    const counts = new Set(Array.from({ length: 200 }, () => randomGenome(rng).wheels.length));
    expect([...counts].sort()).toEqual([2, 3, 4]);
  });

  it("keeps vertices in angular order", () => {
    const g = randomGenome(new Rng(8));
    for (let i = 1; i < VERTEX_COUNT; i++) expect(g.vertices[i].angle).toBeGreaterThan(g.vertices[i - 1].angle);
    expect(vertexPoints(g)).toHaveLength(VERTEX_COUNT);
  });
});

describe("clampGenome", () => {
  it("forces wild values into range", () => {
    const g = randomGenome(new Rng(3));
    g.vertices.forEach((v) => { v.angle = 99; v.radius = -5; });
    g.wheels.forEach((w) => { w.vertex = 42.7; w.radius = 100; w.density = -1; });
    g.chassisDensity = 1e9;
    const c = clampGenome(g);
    expect(inBounds(c)).toBe(true);
    expect(c.wheels[0].vertex).toBe(VERTEX_COUNT - 1);
  });

  it("repairs NaN, missing vertices and wheel counts", () => {
    const broken = { vertices: [{ angle: NaN, radius: NaN }], wheels: [], chassisDensity: NaN } as unknown as Genome;
    expect(inBounds(clampGenome(broken))).toBe(true);
    const many = randomGenome(new Rng(4));
    while (many.wheels.length < 7) many.wheels.push({ ...many.wheels[0] });
    expect(clampGenome(many).wheels).toHaveLength(MAX_WHEELS);
    const noWheels = { ...randomGenome(new Rng(4)), wheels: undefined } as unknown as Genome;
    expect(clampGenome(noWheels).wheels).toHaveLength(MIN_WHEELS);
  });

  it("leaves a valid genome unchanged", () => {
    const g = randomGenome(new Rng(6));
    expect(clampGenome(g)).toEqual(g);
  });
});

describe("genomeColor", () => {
  it("is a valid hsl derived from the genes", () => {
    const g = randomGenome(new Rng(10));
    const [h, s, l] = genomeColor(g);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
    expect(s).toBeGreaterThan(0);
    expect(l).toBeGreaterThan(0);
    expect(genomeColorCss(g, 0.5)).toMatch(/^hsla\(\d+, 65%, \d+%, 0\.5\)$/);
    const other = randomGenome(new Rng(11));
    expect(genomeColor(other)).not.toEqual(genomeColor(g));
  });
});
