import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { EventBus } from '../src/game/events';
import { PhysicsWorld } from '../src/physics/physics-world';
import { BuoyancySolver, shapeVolume } from '../src/physics/buoyancy';
import { PropPhysicsWorld } from '../src/physics/prop-physics';
import { boxShape, sphereShape } from '../src/physics/rigid-body';
import type { GroundContact } from '../src/physics/rigid-body';
import { WaterField } from '../src/world/water-field';
import type { WaterSample } from '../src/world/water-field';

/**
 * Phase 9 water forces.
 *
 * A synthetic flat lake at y = 0 with a 12 m bed is used so the assertions are
 * about the solver, not about the hydrology generator (covered separately).
 */

const SURFACE = 0;
const BED = -12;

function lake(): WaterField {
  const sample = (): WaterSample => ({
    bodyId: 'lake:test', kind: 'lake', surfaceY: SURFACE,
    depth: SURFACE - BED, flowX: 0.3, flowZ: 0, waveAmplitude: 0, shore: 0.6,
  });
  const fake = {
    sampleAt: () => sample(),
    waveOffset: () => 0,
  };
  return fake as unknown as WaterField;
}

const ground = (_x: number, _z: number, out: GroundContact): GroundContact => {
  out.height = BED; out.nx = 0; out.ny = 1; out.nz = 0; out.surface = 'rock';
  return out;
};

const STEP = 1 / 120;

describe('prop buoyancy', () => {
  const solver = new BuoyancySolver(lake());

  it('floats a wooden crate at the waterline', () => {
    const physics = new PropPhysicsWorld({ maxBodies: 8, fixedStep: STEP });
    const body = physics.add({ id: 'crate', position: { x: 0, y: 6, z: 0 }, shape: boxShape(0.45, 0.45, 0.45), material: 'wood' });
    expect(body).toBeDefined();
    physics.forceField = (rigid, dt) => solver.applyToPropBody(rigid, dt, 0);
    for (let i = 0; i < 120 * 6; i++) physics.step(STEP, ground);
    const crate = physics.get('crate')!;
    // Equilibrium submergence for wood (≈650 kg/m³) in 1025 kg/m³ water:
    // submerged fraction = ρ_body / ρ_water ≈ 0.63, i.e. the centre sits just
    // below the waterline.
    const fraction = (0.45 - crate.position.y) / 0.9;
    expect(fraction).toBeGreaterThan(0.45);
    expect(fraction).toBeLessThan(0.85);
    expect(Math.abs(crate.velocity.y)).toBeLessThan(0.35);
    expect(solver.stats.floating).toBeGreaterThan(0);
  });

  it('sinks a steel ball instead of faking flotation', () => {
    const physics = new PropPhysicsWorld({ maxBodies: 8, fixedStep: STEP });
    physics.add({ id: 'ball', position: { x: 0, y: 4, z: 0 }, shape: sphereShape(0.3), material: 'metal' });
    physics.forceField = (rigid, dt) => solver.applyToPropBody(rigid, dt, 0);
    for (let i = 0; i < 120 * 10; i++) physics.step(STEP, ground);
    const ball = physics.get('ball')!;
    expect(ball.position.y).toBeLessThan(SURFACE - 2);
    // Resting on the bed, not accelerating through it.
    expect(ball.position.y).toBeGreaterThan(BED - 1);
  });

  it('does nothing on dry land', () => {
    const dry = new BuoyancySolver({ sampleAt: () => undefined, waveOffset: () => 0 } as unknown as WaterField);
    const physics = new PropPhysicsWorld({ maxBodies: 4, fixedStep: STEP });
    physics.add({ id: 'crate', position: { x: 0, y: 20, z: 0 }, shape: boxShape(0.4, 0.4, 0.4), material: 'wood' });
    physics.forceField = (rigid, dt) => dry.applyToPropBody(rigid, dt, 0);
    for (let i = 0; i < 120 * 6; i++) physics.step(STEP, ground);
    // It falls to the ground under gravity, unaffected by the absent lake.
    expect(physics.get('crate')!.position.y).toBeCloseTo(BED + 0.4, 1);
    expect(dry.stats.floating).toBe(0);
  });

  it('carries floating bodies with the current', () => {
    const physics = new PropPhysicsWorld({ maxBodies: 4, fixedStep: STEP });
    physics.add({ id: 'raft', position: { x: 0, y: 0.1, z: 0 }, shape: boxShape(0.6, 0.12, 0.6), material: 'wood' });
    physics.forceField = (rigid, dt) => solver.applyToPropBody(rigid, dt, 0);
    for (let i = 0; i < 120 * 5; i++) physics.step(STEP, ground);
    expect(physics.get('raft')!.position.x).toBeGreaterThan(0.5);
  });
});

describe('rapier buoyancy', () => {
  const worlds: PhysicsWorld[] = [];
  afterEach(() => { while (worlds.length > 0) worlds.pop()?.dispose(); });

  it('floats a wood body and survives a floating-origin rebase', async () => {
    const origin = new FloatingOrigin();
    origin.update(new Vector3(0, 0, 0));
    const physics = await PhysicsWorld.create({ origin, events: new EventBus(), maxBodies: 16 });
    worlds.push(physics);
    const solver = new BuoyancySolver(lake());
    physics.preStep = (dt) => solver.applyToRapier(physics, dt, 0);
    const record = physics.createSolid(
      { position: new Vector3(0, 5, 0), linearDamping: 0.1, angularDamping: 0.4 },
      { type: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      { material: 'wood' },
    );
    expect(record).toBeDefined();
    expect(record!.volume).toBeCloseTo(1, 3);

    for (let i = 0; i < 120 * 6; i++) physics.step(STEP);
    const before = physics.positionOf(record!, new Vector3());
    expect(before.y).toBeGreaterThan(-0.5);
    expect(before.y).toBeLessThan(0.6);
    expect(solver.stats.floating).toBe(1);

    // Rebase 4 km: the world frame moves, the water forces must not.
    origin.update(new Vector3(4000, 0, 4000));
    expect(origin.shifts).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) physics.step(STEP);
    const after = physics.positionOf(record!, new Vector3());
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.2);
    expect(Math.abs(after.z - before.z)).toBeLessThan(0.2);
    // Still riding the same waterline: no teleport, no reset momentum, no launch.
    expect(Math.abs(after.y)).toBeLessThan(0.6);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.6);
  });

  it('derives collider volume for buoyancy', () => {
    expect(shapeVolume({ type: 'box', halfExtents: { x: 1, y: 2, z: 3 } })).toBeCloseTo(48, 6);
    expect(shapeVolume({ type: 'ball', radius: 1 })).toBeCloseTo(4 / 3 * Math.PI, 5);
    expect(shapeVolume({ type: 'trimesh' })).toBe(0);
  });
});
