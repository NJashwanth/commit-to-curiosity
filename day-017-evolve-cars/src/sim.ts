import type { World } from "planck";
import type { Genome } from "./genome";
import { buildCar, createWorld, SPAWN_X, type Car } from "./physics";
import type { Terrain } from "./terrain";

// Fixed timestep simulation of a whole population on one terrain. Nothing here
// reads the clock or Math.random, so the same genomes and terrain always give
// the same fitness values.

export interface SimConfig {
  dt: number;
  velocityIterations: number;
  positionIterations: number;
  /** A car dies when its best distance has not grown by `progressEpsilon` for this long. */
  stallSeconds: number;
  progressEpsilon: number;
  /** A car dies when it is upside down and slower than `flipSpeed` for this long. */
  flipSeconds: number;
  flipAngle: number;
  flipSpeed: number;
  /** Hard cap so a run always ends. */
  maxSeconds: number;
}

export const DEFAULT_SIM: SimConfig = {
  dt: 1 / 60,
  velocityIterations: 8,
  positionIterations: 3,
  stallSeconds: 3,
  progressEpsilon: 0.5,
  flipSeconds: 1.5,
  flipAngle: 2.0,
  flipSpeed: 0.4,
  maxSeconds: 45,
};

export type DeathReason = "stall" | "flip" | "timeout" | "finish";

export interface Life {
  alive: boolean;
  reason: DeathReason | null;
  /** Best x reached minus the spawn x, in metres. This is the fitness. */
  distance: number;
  bestX: number;
  /** The x at which progress was last counted, and when. */
  markX: number;
  lastProgressTime: number;
  flippedFor: number;
  diedAt: number | null;
}

export interface Observation {
  x: number;
  /** Chassis angle in radians (any multiple of 2 pi). */
  angle: number;
  speed: number;
}

export function newLife(): Life {
  return {
    alive: true,
    reason: null,
    distance: 0,
    bestX: SPAWN_X,
    markX: SPAWN_X,
    lastProgressTime: 0,
    flippedFor: 0,
    diedAt: null,
  };
}

/** Smallest absolute angle from upright, in [0, pi]. */
export function tilt(angle: number): number {
  const a = Math.abs(angle) % (Math.PI * 2);
  return a > Math.PI ? Math.PI * 2 - a : a;
}

/**
 * Apply fitness and death rules for one step. Pure: it only reads `obs` and
 * mutates `life`, which makes the rules easy to test without physics.
 */
export function updateLife(life: Life, obs: Observation, time: number, trackEnd: number, cfg: SimConfig): void {
  if (!life.alive) return;
  if (obs.x > life.bestX) {
    life.bestX = obs.x;
    if (obs.x - life.markX >= cfg.progressEpsilon) {
      life.markX = obs.x;
      life.lastProgressTime = time;
    }
    life.distance = Math.max(0, life.bestX - SPAWN_X);
  }

  const upsideDown = tilt(obs.angle) > cfg.flipAngle;
  life.flippedFor = upsideDown && obs.speed < cfg.flipSpeed ? life.flippedFor + cfg.dt : 0;

  let reason: DeathReason | null = null;
  if (obs.x >= trackEnd) reason = "finish";
  else if (life.flippedFor >= cfg.flipSeconds) reason = "flip";
  else if (time - life.lastProgressTime >= cfg.stallSeconds) reason = "stall";
  else if (time >= cfg.maxSeconds) reason = "timeout";

  if (reason) {
    life.alive = false;
    life.reason = reason;
    life.diedAt = time;
  }
}

export interface Entry {
  car: Car;
  life: Life;
}

export class Simulation {
  readonly world: World;
  readonly entries: Entry[];
  time = 0;
  private readonly trackEnd: number;

  constructor(
    readonly terrain: Terrain,
    genomes: Genome[],
    readonly cfg: SimConfig = DEFAULT_SIM,
  ) {
    this.world = createWorld(terrain);
    this.trackEnd = terrain.length - 2;
    this.entries = genomes.map((g) => ({ car: buildCar(this.world, g, terrain), life: newLife() }));
  }

  get aliveCount(): number {
    return this.entries.reduce((n, e) => n + (e.life.alive ? 1 : 0), 0);
  }

  get done(): boolean {
    return this.aliveCount === 0;
  }

  /** Index of the live car that has gone furthest, or the best overall if none are alive. */
  leaderIndex(): number {
    let best = -1;
    let bestAlive = -1;
    for (let i = 0; i < this.entries.length; i++) {
      const { life } = this.entries[i];
      if (best < 0 || life.distance > this.entries[best].life.distance) best = i;
      if (life.alive && (bestAlive < 0 || life.distance > this.entries[bestAlive].life.distance)) bestAlive = i;
    }
    return bestAlive >= 0 ? bestAlive : best;
  }

  step(): void {
    const { cfg } = this;
    this.world.step(cfg.dt, cfg.velocityIterations, cfg.positionIterations);
    this.time += cfg.dt;
    for (const { car, life } of this.entries) {
      if (!life.alive) continue;
      const v = car.chassis.getLinearVelocity();
      updateLife(
        life,
        { x: car.chassis.getPosition().x, angle: car.chassis.getAngle(), speed: Math.hypot(v.x, v.y) },
        this.time,
        this.trackEnd,
        cfg,
      );
      if (!life.alive) {
        // Freeze the body where it died; it stays visible but costs nothing.
        for (const w of car.wheels) w.setActive(false);
        car.chassis.setActive(false);
      }
    }
  }

  runToEnd(): void {
    while (!this.done) this.step();
  }

  fitness(): number[] {
    return this.entries.map((e) => e.life.distance);
  }
}

/** Run one generation to completion and return each genome's fitness. */
export function evaluate(terrain: Terrain, genomes: Genome[], cfg: SimConfig = DEFAULT_SIM): number[] {
  const sim = new Simulation(terrain, genomes, cfg);
  sim.runToEnd();
  return sim.fitness();
}
