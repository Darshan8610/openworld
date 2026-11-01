import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { EventBus } from '../src/game/events';
import { WorldManager } from '../src/game/world-manager';
import type { RoadStreamSource, TerrainStreamSource, WaterStreamSource, WorldStreamLayer } from '../src/game/world-manager';
import { PhysicsDebugRenderer } from '../src/physics/debug-renderer';
import { PhysicsGroundStreamer } from '../src/physics/ground-streamer';
import type { GroundTile } from '../src/physics/ground-streamer';
import { PhysicsWorld } from '../src/physics/physics-world';
import { BuoyancySolver } from '../src/physics/buoyancy';
import { WaterField } from '../src/world/water-field';
import { TerrainField } from '../src/world/terrain-field';
import { generateTile } from '../src/world/terrain-generator';
import { makeTile, tileSize } from '../src/world/tiles';

/**
 * Phase 9 wiring *inside the real composition layer*: the water surface streams
 * with the world, the gameplay query answers from it, and Rapier bodies receive
 * buoyancy on their own fixed substep. Nothing here is a standalone demo — this
 * is the same WorldManager the game runs.
 */

const STEP = 1 / 120;
const SEED = 'phase9-manager';
const field = new TerrainField(SEED);
const coord = makeTile(0, 0, 4);
const size = tileSize(4);
const centre = new Vector3(coord.x * size + size / 2, 0, coord.z * size + size / 2);
const groundY = field.height(centre.x, centre.z);

const generated = generateTile(
  { type: 'generate', id: 1, epoch: 0, seed: SEED, segments: 12, ...coord },
  field,
);
const geometry = new BufferGeometry();
geometry.setAttribute('position', new BufferAttribute(generated.positions, 3));
const tile: GroundTile = { coord, segments: 12, mesh: new Mesh(geometry) };

const terrain: TerrainStreamSource = {
  revision: 0,
  activeTiles: [tile],
  update: () => undefined,
  heightAt: (x, z) => field.height(x, z),
  biomeAt: () => 0,
};
const vegetation: WorldStreamLayer = { update: () => undefined };
const roads: RoadStreamSource = { network: field.roads, update: () => undefined };

/** A flat, believable body of water standing 30 m above the tile centre. */
const SURFACE = groundY + 30;
interface FakeWater extends WaterStreamSource {
  updates: number;
  rebases: number;
}

const fakeWater: FakeWater = {
  group: new Mesh(),
  updates: 0,
  rebases: 0,
  update() { this.updates++; },
  rebase() { this.rebases++; },
  setEnabled() { /* always on in this test */ },
  isEnabled: true,
  stats: {
    tiles: 1, emptyTiles: 0, triangles: 2, budget: 64, truncated: false,
    bodiesNear: 1, underwater: false, builds: 1, buildMs: 0.1, enabled: true,
  },
  query: (x: number, z: number) => (Math.hypot(x - centre.x, z - centre.z) < 220
    ? {
      bodyId: 'lake:test', surfaceHeight: SURFACE, depth: 6,
      flowX: 0.4, flowZ: 0, kind: 'lake' as const, waveAmplitude: 0.2, shoreline: 0.7,
    }
    : undefined),
};

/**
 * The solver is given the same water the provider reports. A constant field keeps
 * this test about *wiring* (WorldManager → Rapier substep); the hydrology itself
 * is covered by the water-field suite and the solver's physics by buoyancy.test.
 */
const flatField = { sampleAt: () => ({ surfaceY: SURFACE, depth: 6 }), waveOffset: () => 0 } as unknown as WaterField;
const solver = new BuoyancySolver(flatField);

const teardown: (() => void)[] = [];
afterEach(() => { while (teardown.length > 0) teardown.pop()?.(); });

async function makeWorld() {
  const origin = new FloatingOrigin();
  const events = new EventBus();
  const physics = await PhysicsWorld.create({ origin, events });
  const ground = new PhysicsGroundStreamer(physics, terrain, {
    radius: 2000, minLevel: 4, maxTiles: 4, buildsPerUpdate: 8,
  });
  const debug = new PhysicsDebugRenderer(physics);
  const world = new WorldManager({ origin, terrain, vegetation, roads, events, water: fakeWater });
  world.setPhysics(physics, ground, debug);
  world.setBuoyancy(solver);
  world.setReady(true);
  teardown.push(() => { world.dispose(); ground.dispose(); debug.dispose(); physics.dispose(); });
  return { world, physics, ground, events, origin };
}

describe('phase 9 world integration', () => {
  it('streams water with the world and answers the gameplay query', async () => {
    const { world, origin } = await makeWorld();
    const before = fakeWater.updates;
    world.update(STEP, centre);
    expect(fakeWater.updates).toBe(before + 1);
    const hit = world.query.sampleAt(centre.x, centre.z);
    expect(hit.water?.bodyId).toBe('lake:test');
    expect(hit.water?.surfaceHeight).toBeCloseTo(SURFACE, 6);
    const dry = world.query.sampleAt(centre.x + 900, centre.z);
    expect(dry.water).toBeUndefined();
    // ...but the same field answers everywhere the rest of the game asks.
    const far = world.query.sampleAt(centre.x + 30_000, centre.z);
    expect(far.water).toBeUndefined();

    // The floating origin move is forwarded to the water layer.
    origin.update(centre.clone().add(new Vector3(4200, 0, 0)));
    world.update(STEP, centre.clone().add(new Vector3(4200, 0, 0)));
    expect(fakeWater.rebases).toBeGreaterThan(0);
  });

  it('floats a rapier body inside the world step', async () => {
    const { world, physics, origin } = await makeWorld();
    const body = physics.createSolid(
      { position: new Vector3(centre.x, SURFACE + 12, centre.z), linearDamping: 0.2, angularDamping: 0.5 },
      { type: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      { material: 'wood' },
    );
    expect(body).not.toBeNull();
    for (let i = 0; i < 120 * 8; i++) world.update(STEP, centre);
    const position = physics.positionOf(body!, new Vector3());
    // Wood floats: it settles near the waterline instead of falling to the bed.
    expect(position.y).toBeLessThan(SURFACE + 1);
    expect(position.y).toBeGreaterThan(SURFACE - 1);
    expect(solver.stats.bodiesInWater).toBe(1);
    expect(origin.shifts).toBe(0);
  });

  it('carries surface conditions from weather into the ground query', async () => {
    const { world } = await makeWorld();
    world.setCondition({ wetness: 0.9, snowCover: 0.8 });
    // Ask on dry ground: water wins over snow where the player is standing in it.
    const dry = centre.x + 600;
    expect(world.query.sampleAt(dry, centre.z).surface).toBe('snow');
    world.setCondition({ wetness: 0.9, snowCover: 0 });
    expect(world.query.sampleAt(dry, centre.z).surface).not.toBe('snow');
  });
});
