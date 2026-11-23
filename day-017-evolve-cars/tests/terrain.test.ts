import { describe, expect, it } from "vitest";
import { FLAT_START, RAMP_DISTANCE, STEP, difficultyAt, generateTerrain, heightAt, maxSlopeBetween } from "../src/terrain";

describe("terrain", () => {
  it("is identical for the same seed and differs between seeds", () => {
    expect(generateTerrain(42)).toEqual(generateTerrain(42));
    expect(generateTerrain(42).points).not.toEqual(generateTerrain(43).points);
  });

  it("spans the requested length with evenly spaced points", () => {
    const t = generateTerrain(1, 100);
    expect(t.length).toBe(100);
    expect(t.points).toHaveLength(101);
    t.points.forEach((p, i) => expect(p.x).toBe(i * STEP));
  });

  it("starts flat", () => {
    const t = generateTerrain(7);
    for (let x = 0; x <= FLAT_START; x++) expect(heightAt(t, x)).toBe(0);
  });

  it("gets steeper and rougher with distance", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const t = generateTerrain(seed);
      const early = maxSlopeBetween(t, FLAT_START, 150);
      const late = maxSlopeBetween(t, 500, 700);
      expect(late).toBeGreaterThan(early);
    }
  });

  it("difficulty ramps from 0 to 1", () => {
    expect(difficultyAt(0)).toBe(0);
    expect(difficultyAt(FLAT_START)).toBe(0);
    expect(difficultyAt(FLAT_START + RAMP_DISTANCE / 2)).toBeCloseTo(0.5);
    expect(difficultyAt(10000)).toBe(1);
  });

  it("heightAt interpolates and clamps to the ends", () => {
    const t = generateTerrain(9, 50);
    const a = t.points[20];
    const b = t.points[21];
    expect(heightAt(t, 20.5)).toBeCloseTo((a.y + b.y) / 2);
    expect(heightAt(t, -5)).toBe(t.points[0].y);
    expect(heightAt(t, 9999)).toBe(t.points[t.points.length - 1].y);
  });
});
