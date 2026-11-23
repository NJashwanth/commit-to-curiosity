import { Rng } from "./rng";

// A car is 8 chassis vertices, 2 to 4 wheels and a chassis density.
//
// Vertex i lives in its own 45 degree sector of the circle (BoxCar2D style), so
// the vertices are always in angular order around the centre and the chassis,
// built as 8 triangles fanned from the centre, is always a valid shape.
// Every value is clamped by `clampGenome`, so any genome builds a valid car.

export const VERTEX_COUNT = 8;
export const MIN_WHEELS = 2;
export const MAX_WHEELS = 4;
export const SECTOR = (Math.PI * 2) / VERTEX_COUNT;

export const BOUNDS = {
  /** Vertex radius in metres. */
  radius: { min: 0.25, max: 1.2 },
  /** Where inside its sector a vertex angle may sit, as a fraction of the sector. */
  angleFraction: { min: 0.1, max: 0.9 },
  wheelRadius: { min: 0.15, max: 0.7 },
  wheelDensity: { min: 0.3, max: 2.5 },
  chassisDensity: { min: 0.3, max: 3 },
} as const;

export interface Vertex {
  /** Absolute angle in radians, always inside sector i of vertex i. */
  angle: number;
  radius: number;
}

export interface Wheel {
  /** Index of the chassis vertex the wheel is attached to (0..7). */
  vertex: number;
  radius: number;
  density: number;
}

export interface Genome {
  vertices: Vertex[];
  wheels: Wheel[];
  chassisDensity: number;
}

function clamp(x: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

export function angleRange(i: number): { min: number; max: number } {
  return {
    min: i * SECTOR + BOUNDS.angleFraction.min * SECTOR,
    max: i * SECTOR + BOUNDS.angleFraction.max * SECTOR,
  };
}

/** Return a copy with every gene forced into its valid range. */
export function clampGenome(g: Genome): Genome {
  const vertices: Vertex[] = [];
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const v = g.vertices?.[i];
    const r = angleRange(i);
    vertices.push({
      angle: clamp(v?.angle as number, r.min, r.max, (r.min + r.max) / 2),
      radius: clamp(v?.radius as number, BOUNDS.radius.min, BOUNDS.radius.max, 0.6),
    });
  }
  const source = Array.isArray(g.wheels) ? g.wheels.slice(0, MAX_WHEELS) : [];
  const wheels: Wheel[] = source.map((w) => ({
    vertex: Math.round(clamp(w?.vertex as number, 0, VERTEX_COUNT - 1, 0)),
    radius: clamp(w?.radius as number, BOUNDS.wheelRadius.min, BOUNDS.wheelRadius.max, 0.3),
    density: clamp(w?.density as number, BOUNDS.wheelDensity.min, BOUNDS.wheelDensity.max, 1),
  }));
  // Pad up to the minimum with spread out default wheels.
  while (wheels.length < MIN_WHEELS) {
    wheels.push({ vertex: wheels.length === 0 ? 5 : 1, radius: 0.3, density: 1 });
  }
  return {
    vertices,
    wheels,
    chassisDensity: clamp(g.chassisDensity, BOUNDS.chassisDensity.min, BOUNDS.chassisDensity.max, 1),
  };
}

export function randomGenome(rng: Rng): Genome {
  const vertices: Vertex[] = [];
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const r = angleRange(i);
    vertices.push({
      angle: rng.range(r.min, r.max),
      radius: rng.range(BOUNDS.radius.min, BOUNDS.radius.max),
    });
  }
  const count = rng.int(MIN_WHEELS, MAX_WHEELS);
  const wheels: Wheel[] = [];
  for (let i = 0; i < count; i++) {
    wheels.push({
      vertex: rng.int(0, VERTEX_COUNT - 1),
      radius: rng.range(BOUNDS.wheelRadius.min, BOUNDS.wheelRadius.max),
      density: rng.range(BOUNDS.wheelDensity.min, BOUNDS.wheelDensity.max),
    });
  }
  return {
    vertices,
    wheels,
    chassisDensity: rng.range(BOUNDS.chassisDensity.min, BOUNDS.chassisDensity.max),
  };
}

/** Chassis vertex positions in body space (y up). */
export function vertexPoints(g: Genome): { x: number; y: number }[] {
  return g.vertices.map((v) => ({ x: Math.cos(v.angle) * v.radius, y: Math.sin(v.angle) * v.radius }));
}

/** A colour derived from the genes, as [hue 0-360, saturation %, lightness %]. */
export function genomeColor(g: Genome): [number, number, number] {
  const meanRadius = g.vertices.reduce((s, v) => s + v.radius, 0) / g.vertices.length;
  const hue = ((g.vertices[0].angle * 57.2958 + meanRadius * 211 + g.wheels.length * 53) % 360 + 360) % 360;
  const t = (g.chassisDensity - BOUNDS.chassisDensity.min) / (BOUNDS.chassisDensity.max - BOUNDS.chassisDensity.min);
  return [Math.round(hue), 65, Math.round(40 + 25 * (1 - t))];
}

export function genomeColorCss(g: Genome, alpha = 1): string {
  const [h, s, l] = genomeColor(g);
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}
