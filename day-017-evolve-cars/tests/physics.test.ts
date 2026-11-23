import { describe, expect, it } from "vitest";
import { clampGenome, randomGenome, VERTEX_COUNT, type Genome } from "../src/genome";
import { buildCar, createWorld, removeCar, SPAWN_X } from "../src/physics";
import { Rng } from "../src/rng";
import { generateTerrain, heightAt } from "../src/terrain";

const terrain = generateTerrain(42);

function finiteBody(b: { getPosition(): { x: number; y: number }; getMass(): number }): boolean {
  const p = b.getPosition();
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(b.getMass()) && b.getMass() > 0;
}

describe("buildCar", () => {
  it("builds a valid body for 300 random genomes", () => {
    const rng = new Rng(12);
    const world = createWorld(terrain);
    for (let i = 0; i < 300; i++) {
      const g = randomGenome(rng);
      const car = buildCar(world, g, terrain);
      expect(finiteBody(car.chassis)).toBe(true);
      expect(car.chassis.getMass()).toBeGreaterThan(0);
      expect(car.wheels).toHaveLength(g.wheels.length);
      expect(car.joints).toHaveLength(g.wheels.length);
      expect(car.chassis.getFixtureList()).not.toBeNull();
      car.wheels.forEach((w) => expect(finiteBody(w)).toBe(true));
    }
  });

  it("builds valid cars from the extreme corners of the gene space", () => {
    const world = createWorld(terrain);
    for (const pick of [0, 1]) {
      const g: Genome = clampGenome({
        vertices: Array.from({ length: VERTEX_COUNT }, (_, i) => ({ angle: pick ? 1e9 : -1e9, radius: pick ? 1e9 : -1e9 + i })),
        wheels: Array.from({ length: 4 }, () => ({ vertex: pick ? 99 : -9, radius: pick ? 9 : 0, density: pick ? 99 : 0 })),
        chassisDensity: pick ? 99 : 0,
      });
      const car = buildCar(world, g, terrain);
      expect(finiteBody(car.chassis)).toBe(true);
      for (let s = 0; s < 120; s++) world.step(1 / 60);
      expect(Number.isFinite(car.chassis.getPosition().x)).toBe(true);
    }
  });

  it("spawns above the ground at the start line", () => {
    const world = createWorld(terrain);
    const car = buildCar(world, randomGenome(new Rng(2)), terrain);
    const p = car.chassis.getPosition();
    expect(p.x).toBe(SPAWN_X);
    expect(p.y).toBeGreaterThan(heightAt(terrain, SPAWN_X));
  });

  it("cars do not collide with each other", () => {
    const world = createWorld(terrain);
    const g = randomGenome(new Rng(3));
    const a = buildCar(world, g, terrain);
    const b = buildCar(world, g, terrain);
    for (let s = 0; s < 180; s++) world.step(1 / 60);
    // Two identical cars on the same spot would blow apart if they collided.
    expect(a.chassis.getPosition().x).toBeCloseTo(b.chassis.getPosition().x, 6);
  });

  it("removeCar takes every body out of the world", () => {
    const world = createWorld(terrain);
    const before = world.getBodyCount();
    const car = buildCar(world, randomGenome(new Rng(4)), terrain);
    expect(world.getBodyCount()).toBe(before + 1 + car.wheels.length);
    removeCar(world, car);
    expect(world.getBodyCount()).toBe(before);
  });

  it("falls onto the track and does not sink through it", () => {
    const world = createWorld(terrain);
    const car = buildCar(world, randomGenome(new Rng(5)), terrain);
    for (let s = 0; s < 240; s++) world.step(1 / 60);
    const p = car.chassis.getPosition();
    expect(p.y).toBeGreaterThan(heightAt(terrain, p.x) - 0.3);
  });
});
