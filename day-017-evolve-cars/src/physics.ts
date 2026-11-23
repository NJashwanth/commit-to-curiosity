import { Chain, Circle, Polygon, RevoluteJoint, Vec2, World } from "planck";
import type { Body, Joint } from "planck";
import { vertexPoints, type Genome } from "./genome";
import { heightAt, type Terrain } from "./terrain";

// Builds planck.js bodies. Cars never collide with each other (shared negative
// filter group), so a whole population shares one world and one track.

export const GRAVITY = -10;
export const SPAWN_X = 4;
export const MOTOR_SPEED = 9; // rad/s, wheels spin clockwise to drive right
const CAR_GROUP = -1;

export interface Car {
  genome: Genome;
  chassis: Body;
  wheels: Body[];
  joints: Joint[];
}

export function createWorld(terrain: Terrain): World {
  const world = new World({ gravity: new Vec2(0, GRAVITY) });
  const ground = world.createBody();
  ground.createFixture({
    shape: new Chain(terrain.points.map((p) => new Vec2(p.x, p.y)), false),
    friction: 0.9,
  });
  return world;
}

/** Furthest chassis or wheel extent below the body origin, used to place the car above the ground. */
function lowestExtent(g: Genome): number {
  let low = 0;
  for (const p of vertexPoints(g)) low = Math.max(low, -p.y);
  const pts = vertexPoints(g);
  for (const w of g.wheels) low = Math.max(low, -pts[w.vertex].y + w.radius);
  return low;
}

export function buildCar(world: World, genome: Genome, terrain: Terrain): Car {
  const pts = vertexPoints(genome);
  const x = SPAWN_X;
  const y = heightAt(terrain, x) + lowestExtent(genome) + 0.4;
  const chassis = world.createDynamicBody(new Vec2(x, y));

  // Fan of triangles from the centre: always a valid polygon set for in-sector vertices.
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    chassis.createFixture({
      shape: new Polygon([new Vec2(0, 0), new Vec2(a.x, a.y), new Vec2(b.x, b.y)]),
      density: genome.chassisDensity,
      friction: 0.5,
      filterGroupIndex: CAR_GROUP,
    });
  }

  const wheels: Body[] = [];
  const joints: Joint[] = [];
  for (const w of genome.wheels) {
    const anchor = pts[w.vertex];
    const wheel = world.createDynamicBody(new Vec2(x + anchor.x, y + anchor.y));
    wheel.createFixture({
      shape: new Circle(w.radius),
      density: w.density,
      friction: 1.1,
      restitution: 0.05,
      filterGroupIndex: CAR_GROUP,
    });
    const mass = wheel.getMass();
    const joint = world.createJoint(
      new RevoluteJoint(
        {
          enableMotor: true,
          motorSpeed: -MOTOR_SPEED,
          maxMotorTorque: 5 + 22 * mass,
        },
        chassis,
        wheel,
        wheel.getPosition(),
      ),
    );
    wheels.push(wheel);
    if (joint) joints.push(joint);
  }
  return { genome, chassis, wheels, joints };
}

export function removeCar(world: World, car: Car): void {
  for (const w of car.wheels) world.destroyBody(w);
  world.destroyBody(car.chassis);
}
