import { BOUNDS, MAX_WHEELS, MIN_WHEELS, VERTEX_COUNT, angleRange, type Genome } from "../src/genome";

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
