import { describe, expect, it } from "vitest";
import { randomGenome } from "../src/genome";
import { SPAWN_X } from "../src/physics";
import { Rng } from "../src/rng";
import { DEFAULT_SIM, Simulation, evaluate, newLife, tilt, updateLife, type Observation } from "../src/sim";
import { generateTerrain, type Terrain } from "../src/terrain";

const cfg = DEFAULT_SIM;
const END = 1000;
const obs = (x: number, angle = 0, speed = 5): Observation => ({ x, angle, speed });

/** Step the pure rules for `seconds` at a fixed observation. */
function run(life: ReturnType<typeof newLife>, o: Observation, from: number, seconds: number, trackEnd = END): number {
  let t = from;
  const steps = Math.round(seconds / cfg.dt);
  for (let i = 0; i < steps && life.alive; i++) {
    t += cfg.dt;
    updateLife(life, o, t, trackEnd, cfg);
  }
  return t;
}

describe("fitness", () => {
  it("is the best distance reached past the spawn point", () => {
    const life = newLife();
    updateLife(life, obs(SPAWN_X + 10), 0.1, END, cfg);
    updateLife(life, obs(SPAWN_X + 25), 0.2, END, cfg);
    updateLife(life, obs(SPAWN_X + 12), 0.3, END, cfg);
    expect(life.distance).toBeCloseTo(25);
  });

  it("never goes negative when a car rolls backwards", () => {
    const life = newLife();
    updateLife(life, obs(SPAWN_X - 3), 0.1, END, cfg);
    expect(life.distance).toBe(0);
    expect(life.alive).toBe(true);
  });

  it("ignores dead cars", () => {
    const life = newLife();
    life.alive = false;
    updateLife(life, obs(SPAWN_X + 50), 1, END, cfg);
    expect(life.distance).toBe(0);
  });
});

describe("death rules", () => {
  it("a car that keeps making progress does not stall", () => {
    const life = newLife();
    for (let i = 1; i <= 600; i++) updateLife(life, obs(SPAWN_X + i * 0.05), i * cfg.dt, END, cfg);
    expect(life.alive).toBe(true);
  });

  it("stalls after stallSeconds without progress, not before", () => {
    const life = newLife();
    const t = run(life, obs(SPAWN_X + 2), 0, cfg.stallSeconds - 0.3);
    expect(life.alive).toBe(true);
    run(life, obs(SPAWN_X + 2), t, 1);
    expect(life.alive).toBe(false);
    expect(life.reason).toBe("stall");
    expect(life.diedAt).toBeCloseTo(cfg.stallSeconds, 0);
  });

  it("progress below the epsilon does not reset the stall timer", () => {
    const life = newLife();
    let t = 0;
    for (let i = 0; i < 400 && life.alive; i++) {
      t += cfg.dt;
      updateLife(life, obs(SPAWN_X + 2 + i * 0.0005), t, END, cfg);
    }
    expect(life.reason).toBe("stall");
  });

  it("dies as flipped only when upside down and nearly stopped", () => {
    const upside = Math.PI;
    const moving = newLife();
    run(moving, obs(SPAWN_X + 1, upside, 5), 0, 1.4);
    updateLife(moving, obs(SPAWN_X + 1, upside, 5), 1.5, END, cfg);
    expect(moving.alive).toBe(true);

    const stopped = newLife();
    run(stopped, obs(SPAWN_X + 1, upside, 0.1), 0, cfg.flipSeconds + 0.2);
    expect(stopped.alive).toBe(false);
    expect(stopped.reason).toBe("flip");
    expect(stopped.diedAt).toBeLessThan(cfg.stallSeconds);
  });

  it("the flip timer resets when the car rights itself", () => {
    const life = newLife();
    let t = run(life, obs(SPAWN_X + 1, Math.PI, 0.1), 0, 1.2);
    updateLife(life, obs(SPAWN_X + 1, 0, 0.1), t + cfg.dt, END, cfg);
    expect(life.flippedFor).toBe(0);
    t = run(life, obs(SPAWN_X + 1, Math.PI, 0.1), t, 1.2);
    expect(life.alive).toBe(true);
  });

  it("finishes at the end of the track and times out at maxSeconds", () => {
    const finish = newLife();
    updateLife(finish, obs(END + 1), 5, END, cfg);
    expect(finish.reason).toBe("finish");

    const slow = newLife();
    for (let t = cfg.dt; t < cfg.maxSeconds + 1 && slow.alive; t += cfg.dt) {
      updateLife(slow, obs(SPAWN_X + t * 2), t, END, cfg);
    }
    expect(slow.reason).toBe("timeout");
  });

  it("tilt is the angle from upright regardless of winding", () => {
    expect(tilt(0)).toBe(0);
    expect(tilt(Math.PI * 2)).toBeCloseTo(0);
    expect(tilt(-Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(tilt(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(tilt((Math.PI * 3) / 2)).toBeCloseTo(Math.PI / 2);
  });
});

describe("Simulation", () => {
  const terrain = generateTerrain(42);
  const genomes = (n: number, seed = 1) => {
    const rng = new Rng(seed);
    return Array.from({ length: n }, () => randomGenome(rng));
  };

  it("runs a population to the end and every car ends dead with a reason", () => {
    const sim = new Simulation(terrain, genomes(6));
    sim.runToEnd();
    expect(sim.done).toBe(true);
    expect(sim.aliveCount).toBe(0);
    for (const e of sim.entries) {
      expect(e.life.reason).not.toBeNull();
      expect(e.life.diedAt).toBeGreaterThan(0);
    }
    expect(sim.time).toBeLessThanOrEqual(cfg.maxSeconds + 0.1);
  });

  it("gives identical fitness for the same genomes and terrain", () => {
    const a = evaluate(terrain, genomes(8, 5));
    const b = evaluate(generateTerrain(42), genomes(8, 5));
    expect(a).toEqual(b);
    expect(a.some((f) => f > 0)).toBe(true);
  });

  it("different terrain seeds give different results", () => {
    expect(evaluate(generateTerrain(1), genomes(6, 2))).not.toEqual(evaluate(generateTerrain(2), genomes(6, 2)));
  });

  it("a car blocked by a wall stalls and keeps its distance", () => {
    const points = [];
    for (let x = 0; x <= 60; x++) points.push({ x, y: x >= 14 ? 6 : 0 });
    const wall: Terrain = { seed: 0, points, length: 60 };
    const sim = new Simulation(wall, genomes(1, 9));
    sim.runToEnd();
    const life = sim.entries[0].life;
    expect(life.reason).toBe("stall");
    expect(life.distance).toBeLessThan(12);
  });

  it("freezes bodies of dead cars and tracks the leader", () => {
    const sim = new Simulation(terrain, genomes(5, 3));
    for (let i = 0; i < 60 * 12; i++) sim.step();
    const dead = sim.entries.find((e) => !e.life.alive);
    if (dead) expect(dead.car.chassis.isActive()).toBe(false);
    const leader = sim.leaderIndex();
    const best = Math.max(...sim.fitness());
    expect(sim.entries[leader].life.distance).toBeLessThanOrEqual(best);
    sim.runToEnd();
    expect(sim.entries[sim.leaderIndex()].life.distance).toBe(Math.max(...sim.fitness()));
  });
});
