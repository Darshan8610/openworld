import { describe, expect, it } from 'vitest';
import { PropPhysicsWorld } from '../src/physics/prop-physics';
import { boxShape, sphereShape } from '../src/physics/rigid-body';
import type { GroundContact } from '../src/physics/rigid-body';
import type { SurfaceKind } from '../src/physics/surfaces';
import { PHYSICAL_MATERIALS, combineFriction, gripFor } from '../src/physics/surfaces';

const flatGround = (surface: SurfaceKind) => (_x: number, _z: number, out: GroundContact): GroundContact => {
  out.height = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.surface = surface;
  return out;
};

function simulate(world: PropPhysicsWorld, surface: SurfaceKind, seconds: number, step = 1 / 120): void {
  const ground = flatGround(surface);
  for (let t = 0; t < seconds; t += step) world.step(step, ground);
}

describe('physical materials', () => {
  it('defines every surface with plausible, ordered properties', () => {
    for (const material of Object.values(PHYSICAL_MATERIALS)) {
      expect(material.friction).toBeGreaterThanOrEqual(0);
      expect(material.friction).toBeLessThanOrEqual(1);
      expect(material.restitution).toBeGreaterThanOrEqual(0);
      expect(material.density).toBeGreaterThan(0);
    }
    expect(PHYSICAL_MATERIALS.ice.friction).toBeLessThan(PHYSICAL_MATERIALS.asphalt.friction);
    expect(PHYSICAL_MATERIALS.rubber.restitution).toBeGreaterThan(PHYSICAL_MATERIALS.soil.restitution);
  });

  it('combines friction and reduces grip with speed on loose surfaces', () => {
    expect(combineFriction(PHYSICAL_MATERIALS.rubber, PHYSICAL_MATERIALS.asphalt)).toBeCloseTo(Math.sqrt(0.95 * 0.86), 5);
    expect(gripFor('snow', 45)).toBeLessThan(gripFor('asphalt', 45));
  });
});

describe('prop rigid bodies', () => {
  it('falls under gravity and settles exactly on the ground', () => {
    const world = new PropPhysicsWorld({ maxBodies: 8 });
    const body = world.add({ id: 'crate', position: { x: 0, y: 6, z: 0 }, shape: boxShape(0.4, 0.4, 0.4), material: 'wood', mass: 20 })!;
    simulate(world, 'grass', 3);
    expect(body.position.y).toBeCloseTo(0.4, 2);
    expect(body.grounded).toBe(true);
    expect(body.sleeping).toBe(true);
  });

  it('keeps momentum through an origin rebase (canonical coordinates only)', () => {
    const world = new PropPhysicsWorld({ maxBodies: 4 });
    const body = world.add({
      id: 'barrel', position: { x: 0, y: 0.5, z: 0 }, shape: sphereShape(0.5), material: 'metal', mass: 30,
      velocity: { x: 6, y: 0, z: -3 },
    })!;
    const before = { vx: body.velocity.x, vz: body.velocity.z };
    // The floating origin rebases every 2048 m; physics never moves with it.
    simulate(world, 'gravel', 0.25);
    expect(body.position.x).toBeGreaterThan(0);
    expect(body.velocity.x).toBeLessThan(before.vx);
    expect(body.velocity.z).toBeLessThan(0);
  });

  it('slides farther on ice than on asphalt from the same speed', () => {
    const run = (surface: SurfaceKind): number => {
      const world = new PropPhysicsWorld({ maxBodies: 2 });
      const body = world.add({
        id: 'tin', position: { x: 0, y: 0.2, z: 0 }, shape: boxShape(0.2, 0.2, 0.2), material: 'metal', mass: 3,
        velocity: { x: 8, y: 0, z: 0 },
      })!;
      simulate(world, surface, 3);
      return body.position.x;
    };
    const onIce = run('ice');
    const onAsphalt = run('asphalt');
    expect(onIce).toBeGreaterThan(onAsphalt + 2);
  });

  it('bounces off a hard surface and damps out', () => {
    const world = new PropPhysicsWorld({ maxBodies: 2 });
    const body = world.add({ id: 'rubber', position: { x: 0, y: 5, z: 0 }, shape: sphereShape(0.2), material: 'rubber', mass: 1 })!;
    // Dropped from 5 m with a 0.2 m radius: ground contact at ~0.99 s.
    simulate(world, 'concrete', 1.05);
    expect(body.velocity.y).toBeGreaterThan(0);
    simulate(world, 'concrete', 4);
    expect(body.velocity.y).toBeCloseTo(0, 2);
  });

  it('separates overlapping bodies instead of leaving them interpenetrated', () => {
    const world = new PropPhysicsWorld({ maxBodies: 4 });
    const a = world.add({ id: 'a', position: { x: -0.1, y: 0.3, z: 0 }, shape: sphereShape(0.3), material: 'wood', mass: 5 })!;
    const b = world.add({ id: 'b', position: { x: 0.1, y: 0.3, z: 0 }, shape: sphereShape(0.3), material: 'wood', mass: 5 })!;
    simulate(world, 'grass', 0.5);
    expect(Math.abs(b.position.x - a.position.x)).toBeGreaterThan(0.5);
  });

  it('respects its body budget and reports truncation', () => {
    const world = new PropPhysicsWorld({ maxBodies: 2 });
    expect(world.add({ id: '1', position: { x: 0, y: 1, z: 0 }, shape: sphereShape(0.2), material: 'wood' })).toBeDefined();
    expect(world.add({ id: '2', position: { x: 1, y: 1, z: 0 }, shape: sphereShape(0.2), material: 'wood' })).toBeDefined();
    expect(world.add({ id: '3', position: { x: 2, y: 1, z: 0 }, shape: sphereShape(0.2), material: 'wood' })).toBeUndefined();
    expect(world.stats.truncated).toBe(1);
    world.setCapacity(8);
    expect(world.add({ id: '3', position: { x: 2, y: 1, z: 0 }, shape: sphereShape(0.2), material: 'wood' })).toBeDefined();
  });

  it('clamps runaway velocity instead of tunnelling', () => {
    const world = new PropPhysicsWorld({ maxBodies: 2 });
    const body = world.add({ id: 'fast', position: { x: 0, y: 40, z: 0 }, shape: sphereShape(0.2), material: 'metal' })!;
    body.velocity.y = -400;
    simulate(world, 'grass', 0.05);
    expect(Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z)).toBeLessThanOrEqual(70.001);
  });

  it('answers physics raycasts against prop bounds', () => {
    const world = new PropPhysicsWorld({ maxBodies: 2 });
    world.add({ id: 'target', position: { x: 0, y: 0.5, z: -5 }, shape: sphereShape(0.5), material: 'wood' });
    const hit = world.raycast({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
    expect(hit?.id).toBe('target');
    expect(hit!.distance).toBeCloseTo(4.5, 1);
    expect(world.raycast({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 1 }, 20)).toBeUndefined();
  });

  it('pushes nearby bodies radially and wakes them', () => {
    const world = new PropPhysicsWorld({ maxBodies: 4 });
    const body = world.add({ id: 'push', position: { x: 0.5, y: 0.3, z: 0 }, shape: sphereShape(0.3), material: 'wood', mass: 5 })!;
    simulate(world, 'grass', 2);
    expect(body.sleeping).toBe(true);
    expect(world.push({ x: 0, y: 0.3, z: 0 }, 3, { x: 12, y: 0, z: 0 })).toBe(1);
    expect(body.sleeping).toBe(false);
    expect(body.velocity.x).toBeGreaterThan(0);
  });

  it('is stable over a long fixed-step run without state creep', () => {
    const world = new PropPhysicsWorld({ maxBodies: 6 });
    const body = world.add({ id: 'long', position: { x: 0, y: 0.35, z: 0 }, shape: boxShape(0.3, 0.35, 0.3), material: 'wood', mass: 12 })!;
    simulate(world, 'grass', 30);
    expect(body.position.y).toBeCloseTo(0.35, 3);
    expect(Number.isFinite(body.position.x)).toBe(true);
    expect(world.stats.substeps).toBeLessThanOrEqual(8);
  });
});

describe('Phase 13 physics stability', () => {
  it('keeps a dense pile finite and asleep through a long settle', () => {
    const world = new PropPhysicsWorld({ maxBodies: 64 });
    const bodies = [];
    for (let i = 0; i < 40; i++) {
      const body = world.add({
        id: `pile-${i}`,
        position: { x: (i % 6) * 0.9 - 2, y: 1 + Math.floor(i / 6) * 1.1, z: (i % 4) * 0.9 - 1.5 },
        shape: boxShape(0.4, 0.4, 0.4),
        material: i % 3 === 0 ? 'wood' : i % 3 === 1 ? 'metal' : 'rubber',
        mass: 10 + (i % 5),
      });
      expect(body).toBeDefined();
      bodies.push(body!);
    }
    const ground = flatGround('gravel');
    // 60 simulated seconds at the full fixed rate (7200 steps).
    for (let step = 0; step < 7200; step++) world.step(1 / 120, ground);
    let asleep = 0;
    for (const body of bodies) {
      const p = body.position;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      expect(p.y).toBeGreaterThan(-2); // never fell through the world
      expect(p.y).toBeLessThan(20); // never launched into orbit
      if (body.sleeping) asleep++;
    }
    // Most of the pile must have settled to sleep (bounded energy).
    expect(asleep).toBeGreaterThanOrEqual(30);
  });
});
