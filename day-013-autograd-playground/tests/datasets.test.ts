import { describe, expect, it } from "vitest";
import { DATASETS, DEFAULT_NOISE, MAX_SAMPLES, makeDataset, type DatasetName } from "../src/datasets";

const radius = ([x, y]: number[]) => Math.hypot(x!, y!);

describe.each(DATASETS)("%s", (name) => {
  it("is deterministic for a seed", () => {
    const a = makeDataset(name, { n: 150, noise: 0.2, seed: 7 });
    const b = makeDataset(name, { n: 150, noise: 0.2, seed: 7 });
    expect(a).toEqual(b);
    expect(makeDataset(name, { n: 150, noise: 0.2, seed: 8 }).X).not.toEqual(a.X);
  });

  it.each([2, 3, 200, 401])("has the right shape with %i samples", (n) => {
    const d = makeDataset(name, { n });
    expect(d.name).toBe(name);
    expect(d.X).toHaveLength(n);
    expect(d.y).toHaveLength(n);
    for (const p of d.X) {
      expect(p).toHaveLength(2);
      expect(p.every(Number.isFinite)).toBe(true);
    }
    expect(d.y.every((l) => l === 1 || l === -1)).toBe(true);
    const pos = d.y.filter((l) => l === 1).length;
    expect(pos).toBe(Math.ceil(n / 2));
    expect(n - pos).toBe(Math.floor(n / 2));
  });

  it("stays roughly inside [-1, 1]² without noise", () => {
    const d = makeDataset(name, { n: 500, noise: 0 });
    for (const [x, y] of d.X) {
      expect(Math.abs(x!)).toBeLessThanOrEqual(1 + 1e-12);
      expect(Math.abs(y!)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it("noise moves points by about its standard deviation", () => {
    const clean = makeDataset(name, { n: 400, noise: 0, seed: 3 });
    const noisy = makeDataset(name, { n: 400, noise: 0.2, seed: 3 });
    // Same seed, so the clean positions are the same; the jitter comes after.
    const dx = noisy.X.map((p, i) => p[0]! - clean.X[i]![0]!);
    const sd = Math.sqrt(dx.reduce((s, d) => s + d * d, 0) / dx.length);
    expect(sd).toBeGreaterThan(0.17);
    expect(sd).toBeLessThan(0.23);
    expect(noisy.y).toEqual(clean.y);
  });

  it("uses its default noise when none is given", () => {
    expect(makeDataset(name, { seed: 4 })).toEqual(makeDataset(name, { seed: 4, noise: DEFAULT_NOISE[name] }));
  });
});

describe("dataset geometry without noise", () => {
  it("circles: +1 inside radius 0.5, -1 in the ring from 0.75 to 1", () => {
    const d = makeDataset("circles", { n: 400, noise: 0 });
    d.X.forEach((p, i) => {
      if (d.y[i] === 1) expect(radius(p)).toBeLessThanOrEqual(0.5);
      else {
        expect(radius(p)).toBeGreaterThanOrEqual(0.75);
        expect(radius(p)).toBeLessThanOrEqual(1);
      }
    });
  });

  it("xor: the label is the sign of x·y, away from the axes", () => {
    const d = makeDataset("xor", { n: 400, noise: 0 });
    d.X.forEach(([x, y], i) => {
      expect(Math.sign(x! * y!)).toBe(d.y[i]);
      expect(Math.min(Math.abs(x!), Math.abs(y!))).toBeGreaterThanOrEqual(0.1);
    });
  });

  it("spiral: the two arms are half a turn apart", () => {
    const d = makeDataset("spiral", { n: 400, noise: 0 });
    d.X.forEach((p, i) => {
      const r = radius(p);
      expect(r).toBeGreaterThanOrEqual(0.08);
      // Rotating a point by the arm's phase lands it on the angle 3.5πr.
      const phase = d.y[i] === 1 ? 0 : Math.PI;
      const angle = 3.5 * Math.PI * r + phase;
      expect(p[0]).toBeCloseTo(r * Math.cos(angle), 12);
      expect(p[1]).toBeCloseTo(r * Math.sin(angle), 12);
    });
  });

  it("moons: each class lies on its half circle", () => {
    const d = makeDataset("moons", { n: 200, noise: 0 });
    d.X.forEach(([x, y], i) => {
      const [ux, uy] = [x! * 1.5 + 0.5, y! * 1.5 + 0.25]; // undo the shift and scale
      if (d.y[i] === 1) {
        expect(Math.hypot(ux, uy)).toBeCloseTo(1, 12);
        expect(uy).toBeGreaterThanOrEqual(0);
      } else {
        expect(Math.hypot(ux - 1, uy - 0.5)).toBeCloseTo(1, 12);
        expect(uy).toBeLessThanOrEqual(0.5);
      }
    });
  });
});

describe("dataset validation", () => {
  it("rejects bad options", () => {
    expect(() => makeDataset("nope" as DatasetName)).toThrow('unknown dataset "nope"; expected one of moons, circles, xor, spiral');
    expect(() => makeDataset("moons", { n: 1 })).toThrow(`sample count must be an integer from 2 to ${MAX_SAMPLES}, got 1`);
    expect(() => makeDataset("moons", { n: MAX_SAMPLES + 1 })).toThrow(RangeError);
    expect(() => makeDataset("moons", { n: 10.5 })).toThrow(RangeError);
    expect(() => makeDataset("moons", { noise: -0.1 })).toThrow("noise must be 0 or more, got -0.1");
    expect(() => makeDataset("moons", { noise: NaN })).toThrow(RangeError);
    expect(() => makeDataset("moons", { seed: 1.5 })).toThrow("seed must be an integer, got 1.5");
  });
});
