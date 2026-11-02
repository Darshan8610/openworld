import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { EventBus } from '../src/game/events';
import { PhysicsWorld, collisionGroups, PHYSICS_LAYER, PHYSICS_LAYER_NAMES } from '../src/physics/physics-world';
import type { PhysicsBody } from '../src/physics/physics-world';

const STEP = 1 / 120;
const worlds: PhysicsWorld[] = [];

async function makeWorld(bus = new EventBus(), maxBodies?: number): Promise<PhysicsWorld> {
  const origin = new FloatingOrigin();
  const physics = await PhysicsWorld.create({ origin, events: bus, ...(maxBodies ? { maxBodies } : {}) });
  worlds.push(physics);
  return physics;
}

function box(physics: PhysicsWorld, position: Vector3, half = 0.5, material: 'wood' | 'ice' | 'asphalt' = 'wood'): PhysicsBody {
  const body = physics.createSolid(
    { position, linearDamping: 0, angularDamping: 0 },
    { type: 'box', halfExtents: { x: half, y: half, z: half } },
    { material },
  );
  if (!body) throw new Error('body budget unexpectedly exhausted');
  return body;
}

afterEach(() => {
  while (worlds.length > 0) worlds.pop()?.dispose();
});

describe('physics world', () => {
  it('applies gravity and settles a dynamic body on static ground', async () => {
    const physics = await makeWorld();
    physics.createSolid({ kind: 'fixed', position: new Vector3(0, 0, 0) },
      { type: 'box', halfExtents: { x: 50, y: 1, z: 50 } }, { material: 'concrete' });
    const body = box(physics, new Vector3(0, 12, 0));
    expect(physics.stats.bodies).toBe(2);
    for (let i = 0; i < 900; i++) physics.step(STEP);
    // Ground top is y = 1.0; the 0.5 m half-extent box rests at 1.5.
    expect(physics.positionOf(body).y).toBeCloseTo(1.5, 1);
    expect(physics.stats.dynamic).toBe(1);
  });

  it('runs on the fixed step regardless of the render delta', async () => {
    const physics = await makeWorld();
    expect(physics.step(STEP)).toBe(1);
    // A 40 ms frame runs 40 / 8.33 = 4 fixed steps (the remainder carries over).
    expect(physics.step(0.04)).toBe(4);
    // A 4 s stall cannot produce unbounded catch-up work.
    expect(physics.step(4)).toBe(8);
  });

  it('differentiates surface friction: ice slides, asphalt grips', async () => {
    const physics = await makeWorld();
    physics.createSolid({ kind: 'fixed', position: new Vector3(-30, 0, 0) },
      { type: 'box', halfExtents: { x: 15, y: 1, z: 15 } }, { material: 'ice' });
    physics.createSolid({ kind: 'fixed', position: new Vector3(30, 0, 0) },
      { type: 'box', halfExtents: { x: 15, y: 1, z: 15 } }, { material: 'asphalt' });
    const sliderIce = box(physics, new Vector3(-42, 1.5, 0));
    const sliderAsphalt = box(physics, new Vector3(18, 1.5, 0));
    sliderIce.body.setLinvel({ x: 6, y: 0, z: 0 }, true);
    sliderAsphalt.body.setLinvel({ x: 6, y: 0, z: 0 }, true);
    for (let i = 0; i < 240; i++) physics.step(STEP);
    const iceDistance = physics.positionOf(sliderIce).x - -42;
    const asphaltDistance = physics.positionOf(sliderAsphalt).x - 18;
    expect(iceDistance).toBeGreaterThan(asphaltDistance * 1.6);
    expect(asphaltDistance).toBeLessThan(iceDistance);
  });

  it('ray casts in canonical world space and ignores sensors by default', async () => {
    const physics = await makeWorld();
    physics.createSolid({ kind: 'fixed', position: new Vector3(0, 0, 0) },
      { type: 'box', halfExtents: { x: 20, y: 1, z: 20 } }, { material: 'concrete' });
    physics.createSolid({ kind: 'fixed', position: new Vector3(0, 6, 0) },
      { type: 'box', halfExtents: { x: 4, y: 4, z: 4 } }, { sensor: true });
    physics.step(STEP);
    const down = new Vector3(0, -1, 0);
    const hit = physics.raycast(new Vector3(2, 20, -3), down, 100);
    expect(hit).toBeDefined();
    expect(hit!.distance).toBeCloseTo(19, 1);
    expect(hit!.point.y).toBeCloseTo(1, 1);
    expect(hit!.normal.y).toBeGreaterThan(0.95);
    expect(hit!.sensor).toBe(false);
    // The sensor is on the ray path, but excluded unless requested.
    const throughSensor = physics.raycast(new Vector3(0, 20, 0), down, 100, { includeSensors: true });
    expect(throughSensor!.sensor).toBe(true);
    expect(physics.raycast(new Vector3(0, 20, 0), new Vector3(0, 1, 0), 100)).toBeUndefined();
  });

  it('reports ground height under a canonical position', async () => {
    const physics = await makeWorld();
    physics.createSolid({ kind: 'fixed', position: new Vector3(0, 0, 0) },
      { type: 'box', halfExtents: { x: 30, y: 2, z: 30 } }, { material: 'grass' });
    physics.step(STEP);
    const hit = physics.groundAt(new Vector3(10, 0, -10), 40);
    expect(hit).toBeDefined();
    expect(hit!.point.y).toBeCloseTo(2, 1);
  });

  it('preserves canonical pose, momentum and rest state across origin rebases', async () => {
    const origin = new FloatingOrigin();
    const physics = await PhysicsWorld.create({ origin });
    worlds.push(physics);
    origin.update(new Vector3(100000, 450, -50000));
    physics.createSolid({ kind: 'fixed', position: new Vector3(100000, 0, -50000) },
      { type: 'box', halfExtents: { x: 60, y: 1, z: 60 } }, { material: 'concrete' });
    const body = box(physics, new Vector3(100010, 8, -50000));
    for (let i = 0; i < 480; i++) physics.step(STEP);
    body.body.setLinvel({ x: 4, y: 0, z: -2 }, true);
    const beforeWorld = physics.positionOf(body);
    const beforeLocal = body.body.translation();
    const beforeVelocity = physics.velocityOf(body);
    const shiftsBefore = origin.shifts;

    origin.update(new Vector3(102400, 500, -50000));
    expect(origin.shifts).toBeGreaterThan(shiftsBefore);
    expect(physics.stats.rebases).toBeGreaterThan(0);
    const afterWorld = physics.positionOf(body);
    const afterLocal = body.body.translation();
    const afterVelocity = physics.velocityOf(body);
    // Canonical pose and momentum survive; only the local frame moved.
    expect(afterWorld.x).toBeCloseTo(beforeWorld.x, 2);
    expect(afterWorld.z).toBeCloseTo(beforeWorld.z, 2);
    expect(afterLocal.x).toBeCloseTo(beforeLocal.x - 2048, 1);
    expect(afterVelocity.x).toBeCloseTo(beforeVelocity.x, 3);
    expect(afterVelocity.z).toBeCloseTo(beforeVelocity.z, 3);
    // Contacts remain valid: the body keeps sliding on the same ground.
    for (let i = 0; i < 240; i++) physics.step(STEP);
    expect(physics.positionOf(body).y).toBeCloseTo(1.5, 1);
  });

  it('caps body and collider creation instead of growing without bound', async () => {
    const bus = new EventBus();
    const exceeded: string[] = [];
    bus.on('physics:budget-exceeded', (payload) => exceeded.push(payload.limit));
    const physics = await makeWorld(bus, 3);
    physics.createSolid({ position: new Vector3(0, 10, 0) }, { type: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } });
    physics.createSolid({ position: new Vector3(2, 10, 0) }, { type: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } });
    physics.createSolid({ position: new Vector3(4, 10, 0) }, { type: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } });
    const overflow = physics.createSolid({ position: new Vector3(6, 10, 0) }, { type: 'ball', radius: 0.5 });
    expect(overflow).toBeUndefined();
    expect(physics.bodyCount).toBe(3);
    expect(exceeded).toContain('bodies');
  });

  it('publishes typed collision events for sensor triggers', async () => {
    const bus = new EventBus();
    const collisions: { a: number; b: number; started: boolean }[] = [];
    bus.on('physics:collision', (payload) => collisions.push(payload));
    const physics = await makeWorld(bus);
    physics.createSolid({ kind: 'fixed', position: new Vector3(0, 0, 0) },
      { type: 'box', halfExtents: { x: 3, y: 3, z: 3 } }, { sensor: true, events: true, layer: 'sensor' });
    physics.createSolid({ position: new Vector3(0, 0.2, 0) },
      { type: 'ball', radius: 0.4 }, { events: true, layer: 'prop' });
    for (let i = 0; i < 60; i++) physics.step(STEP);
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions.some((event) => event.started)).toBe(true);
  });

  it('prevents fast bodies from tunnelling through thin geometry with CCD', async () => {
    const physics = await makeWorld();
    physics.createSolid({ kind: 'fixed', position: new Vector3(6, 5, 0) },
      { type: 'box', halfExtents: { x: 0.05, y: 3, z: 3 } }, { material: 'concrete' });
    const projectile = physics.createSolid(
      { position: new Vector3(0, 5, 0), ccd: true, gravityScale: 0 },
      { type: 'box', halfExtents: { x: 0.2, y: 0.2, z: 0.2 } },
      { material: 'metal' },
    )!;
    projectile.body.setLinvel({ x: 180, y: 0, z: 0 }, true);
    for (let i = 0; i < 60; i++) physics.step(STEP);
    expect(physics.positionOf(projectile).x).toBeLessThan(6);
  });

  it('rejects non-finite poses instead of poisoning the world', async () => {
    const physics = await makeWorld();
    expect(() => physics.createBody({ position: new Vector3(Number.NaN, 0, 0) })).toThrow(TypeError);
    expect(physics.bodyCount).toBe(0);
  });

  it('packs collision layers into Rapier interaction groups', () => {
    const terrainOnlyVsPlayer = collisionGroups('player', ['terrain']);
    expect(terrainOnlyVsPlayer >>> 16).toBe(1 << PHYSICS_LAYER.player);
    expect(terrainOnlyVsPlayer & 0xffff).toBe(1 << PHYSICS_LAYER.terrain);
    // Eight membership layers occupy the low eight filter bits.
    const all = collisionGroups('prop');
    expect(all & 0xffff).toBe((1 << PHYSICS_LAYER_NAMES.length) - 1);
  });

  it('exposes collider wireframes for the debug overlay and frees cleanly', async () => {
    const physics = await makeWorld();
    physics.createSolid({ kind: 'fixed', position: new Vector3(0, 0, 0) },
      { type: 'box', halfExtents: { x: 1, y: 1, z: 1 } });
    physics.step(STEP);
    const lines = physics.debugLines();
    expect(lines.vertices.length).toBeGreaterThan(0);
    // Rapier emits xyz per vertex and RGBA per vertex.
    expect(lines.colors.length).toBe((lines.vertices.length / 3) * 4);
    physics.dispose();
    worlds.pop();
    expect(physics.bodyCount).toBe(0);
  });
});
