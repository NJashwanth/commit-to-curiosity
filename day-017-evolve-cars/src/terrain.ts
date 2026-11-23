import { Rng } from "./rng";

// Seeded procedural track. It starts flat, then gets steeper and rougher with
// distance: the slope limit and the bump amplitude both grow linearly until
// they saturate at `RAMP_DISTANCE`.

export interface Pt {
  x: number;
  y: number;
}

export interface Terrain {
  seed: number;
  points: Pt[];
  length: number;
}

export const STEP = 1; // metres between terrain points
export const FLAT_START = 14; // metres of flat ground to spawn on
export const DEFAULT_LENGTH = 700;
export const RAMP_DISTANCE = 160;
export const MAX_SLOPE = 1.0; // rise over run at full difficulty (45 degrees)
export const UPHILL_BIAS = 0.15; // mean extra slope per step at full difficulty, so the climb gets harder
export const MAX_BUMP = 0.55; // metres of random jitter at full difficulty

/** 0 at the start, 1 once the track is as hard as it gets. */
export function difficultyAt(x: number): number {
  return Math.min(1, Math.max(0, (x - FLAT_START) / RAMP_DISTANCE));
}

export function generateTerrain(seed: number, length = DEFAULT_LENGTH): Terrain {
  const rng = new Rng(seed ^ 0x9e3779b9);
  const points: Pt[] = [];
  let y = 0;
  let slope = 0;
  const n = Math.ceil(length / STEP);
  for (let i = 0; i <= n; i++) {
    const x = i * STEP;
    points.push({ x, y });
    if (x < FLAT_START) continue;
    const d = difficultyAt(x);
    const limit = 0.1 + (MAX_SLOPE - 0.1) * d;
    // The slope is a mean-reverting random walk, so hills are smooth but vary.
    slope = slope * 0.8 + rng.gaussian(UPHILL_BIAS * d, limit * 0.55);
    slope = Math.max(-limit, Math.min(limit, slope));
    const bump = rng.gaussian(0, MAX_BUMP * d * d);
    y += slope * STEP + bump;
  }
  return { seed, points, length: n * STEP };
}

/** Ground height at x by linear interpolation (clamped to the track ends). */
export function heightAt(t: Terrain, x: number): number {
  const p = t.points;
  if (x <= p[0].x) return p[0].y;
  const last = p[p.length - 1];
  if (x >= last.x) return last.y;
  const i = Math.floor(x / STEP);
  const a = p[i];
  const b = p[i + 1];
  const f = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * f;
}

/** Steepest absolute slope between x0 and x1, for tests and the "hardest terrain" view. */
export function maxSlopeBetween(t: Terrain, x0: number, x1: number): number {
  let m = 0;
  for (let i = Math.max(0, Math.floor(x0 / STEP)); i < Math.min(t.points.length - 1, Math.ceil(x1 / STEP)); i++) {
    m = Math.max(m, Math.abs(t.points[i + 1].y - t.points[i].y) / STEP);
  }
  return m;
}
