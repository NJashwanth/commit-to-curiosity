import { describe, expect, it } from "vitest";
import { Rng, deriveSeed } from "../src/rng";

describe("Rng", () => {
  it("is deterministic for a seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it("differs between seeds", () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it("stays in [0, 1)", () => {
    const r = new Rng(7);
    for (let i = 0; i < 5000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("range, int and pick respect their bounds", () => {
    const r = new Rng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const f = r.range(-2, 5);
      expect(f).toBeGreaterThanOrEqual(-2);
      expect(f).toBeLessThan(5);
      const n = r.int(2, 4);
      seen.add(n);
      expect(r.pick([10, 20, 30])).toBeGreaterThanOrEqual(10);
    }
    expect([...seen].sort()).toEqual([2, 3, 4]);
  });

  it("chance follows its probability", () => {
    const r = new Rng(9);
    let hits = 0;
    for (let i = 0; i < 10000; i++) if (r.chance(0.3)) hits++;
    expect(hits / 10000).toBeGreaterThan(0.27);
    expect(hits / 10000).toBeLessThan(0.33);
  });

  it("gaussian has roughly the requested mean and sd", () => {
    const r = new Rng(11);
    const xs = Array.from({ length: 20000 }, () => r.gaussian(2, 3));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(mean).toBeGreaterThan(1.9);
    expect(mean).toBeLessThan(2.1);
    expect(sd).toBeGreaterThan(2.9);
    expect(sd).toBeLessThan(3.1);
  });

  it("deriveSeed is stable and label sensitive", () => {
    expect(deriveSeed(42, 1)).toBe(deriveSeed(42, 1));
    expect(deriveSeed(42, 1)).not.toBe(deriveSeed(42, 2));
    expect(deriveSeed(42, 1)).not.toBe(deriveSeed(43, 1));
  });
});
