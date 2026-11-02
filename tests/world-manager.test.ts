import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { EventBus } from '../src/game/events';
import { WorldManager } from '../src/game/world-manager';
import type { RoadStreamSource, TerrainStreamSource, WorldStreamLayer } from '../src/game/world-manager';
import { PhysicsDebugRenderer } from '../src/physics/debug-renderer';
import { PhysicsGroundStreamer } from '../src/physics/ground-streamer';
import type { GroundTile } from '../src/physics/ground-streamer';
import { PhysicsWorld } from '../src/physics/physics-world';
import { TerrainField } from '../src/world/terrain-field';
import { generateTile } from '../src/world/terrain-generator';
import { makeTile, tileSize } from '../src/world/tiles';

/**
 * Integration coverage for the composition layer: terrain streaming, physics
 * ground, the fixed step and entity streaming must all run in one order, with
 * real Rapier bodies behind the developer crate sandbox. The browser specs cover
 * the same wiring in a real frame; this keeps it verifiable without a GPU.
 */

const STEP = 1 / 120;
const SEED = 'manager-seed';
const field = new TerrainField(SEED);
const coord = makeTile(0, 0, 4);
const segments = 12;
const size = tileSize(4);
const stride = segments + 1;
const left = coord.x * size;
const top = coord.z * size;
const cell = size / segments;
const centre = new Vector3(left + size / 2, 0, top + size / 2);

const generated = generateTile(
  { type: 'generate', id: 1, epoch: 0, seed: SEED, segments, ...coord },
  field,
);
const geometry = new BufferGeometry();
geometry.setAttribute('position', new BufferAttribute(generated.positions, 3));
const tile: GroundTile = { coord, segments, mesh: new Mesh(geometry) };

const gridHeight = (ix: number, iz: number): number => generated.positions[(iz * stride + ix) * 3 + 1]!;

function makeTerrain(revision = 0): TerrainStreamSource {
  return {
    revision,
    activeTiles: [tile],
    update: () => undefined,
    heightAt: (x, z) => field.height(x, z),
    biomeAt: () => 0,
  };
}

const vegetation: WorldStreamLayer = { update: () => undefined };
const roads: RoadStreamSource = { network: field.roads, update: () => undefined };

/** `PhysicsWorld.stats` is cached for 150 ms; wait it out before asserting counters. */
const freshStats = async (physics: PhysicsWorld) => {
  await new Promise((resolve) => setTimeout(resolve, 170));
  return physics.stats;
};

const teardown: (() => void)[] = [];
afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
});

async function makeWorld(options: { maxSandboxProps?: number } = {}) {
  const origin = new FloatingOrigin();
  const events = new EventBus();
  const physics = await PhysicsWorld.create({ origin, events });
  const ground = new PhysicsGroundStreamer(physics, makeTerrain(), {
    radius: 2000, minLevel: 4, maxTiles: 4, buildsPerUpdate: 8,
  });
  const debug = new PhysicsDebugRenderer(physics);
  const world = new WorldManager({
    origin,
    terrain: makeTerrain(),
    vegetation,
    roads,
    events,
    ...(options.maxSandboxProps !== undefined ? { maxSandboxProps: options.maxSandboxProps } : {}),
  });
  world.setPhysics(physics, ground, debug);
  world.setReady(true);
  teardown.push(() => {
    world.dispose();
    ground.dispose();
    debug.dispose();
    physics.dispose();
  });
  return { world, physics, ground, events, origin };
}

/** The flattest interior node, so a dropped crate rests instead of sliding away. */
function flattestNode(): { x: number; z: number } {
  let best = { x: left + size / 2, z: top + size / 2, slope: Infinity };
  for (let iz = 2; iz < segments - 2; iz++) {
    for (let ix = 2; ix < segments - 2; ix++) {
      const h = gridHeight(ix, iz);
      const slope = Math.max(
        Math.abs(gridHeight(ix + 1, iz) - h),
        Math.abs(gridHeight(ix - 1, iz) - h),
        Math.abs(gridHeight(ix, iz + 1) - h),
        Math.abs(gridHeight(ix, iz - 1) - h),
      );
      if (slope < best.slope) best = { x: left + ix * cell, z: top + iz * cell, slope };
    }
  }
  return best;
}

describe('world manager', () => {
  it('runs one ordered update: layers, ground colliders, fixed step, entities', async () => {
    const { world, physics } = await makeWorld();
    const ticks: number[] = [];
    world.events.on('world:tick', (payload) => ticks.push(payload.fixedSteps));
    world.update(STEP, centre);
    expect(ticks).toEqual([1]);
    expect(world.stats.ground!.tiles).toBe(1);
    // Ground collider exists before the step that consumes it.
    const stats = await freshStats(physics);
    expect(stats.fixed).toBe(1);
    expect(stats.bodies).toBe(1);
    expect(stats.colliders).toBe(1);
  });

  it('does not step physics until the world reports ready', async () => {
    const { world, physics } = await makeWorld();
    world.setReady(false);
    world.update(STEP, centre);
    expect((await freshStats(physics)).substeps).toBe(0);
    world.setReady(true);
    world.update(STEP, centre);
    expect((await freshStats(physics)).substeps).toBe(1);
  });

  it('spawns a real rigid-body prop and keeps its visual on the body pose', async () => {
    const { world, physics } = await makeWorld();
    world.update(STEP, centre);
    const node = flattestNode();
    const surface = gridHeight(Math.round((node.x - left) / cell), Math.round((node.z - top) / cell));
    const entity = world.spawnCrate(new Vector3(node.x, surface + 40, node.z))!;
    expect(entity.physics).toBeDefined();
    expect(entity.visual).toBeDefined();
    expect(world.stats.entities.kinds.prop).toBe(1);
    expect(physics.bodyCount).toBe(2);

    for (let i = 0; i < 900; i++) world.update(STEP, centre);

    const record = physics.bodyById(entity.physics!.bodyId)!;
    const pose = record.body.translation();
    expect(entity.visual!.position.x).toBeCloseTo(pose.x, 5);
    expect(entity.visual!.position.y).toBeCloseTo(pose.y, 5);
    // It fell and stayed on the streamed terrain instead of tunnelling through
    // it. A crate on a level-4 cell (170 m) rolls downhill, so "on the surface"
    // is measured against the ground beneath it, not the drop point. Exact
    // resting height is covered by tests/physics-ground.test.ts.
    expect(pose.y).toBeLessThan(surface + 35);
    const beneath = physics.raycast(
      new Vector3(pose.x, pose.y + 60, pose.z),
      new Vector3(0, -1, 0),
      200,
      { layers: ['terrain'] },
    );
    expect(beneath).toBeDefined();
    expect(pose.y).toBeGreaterThan(beneath!.point.y - 0.5);
    expect(pose.y).toBeLessThan(beneath!.point.y + 15);
    expect(entity.position.y).toBeCloseTo(pose.y, 4);
    expect(world.stats.entities.kinds.prop).toBe(1);
  });

  it('caps sandbox props, removes them in order and destroys their bodies', async () => {
    const { world, physics, events } = await makeWorld({ maxSandboxProps: 3 });
    const removed: string[] = [];
    events.on('entity:removed', (payload) => removed.push(payload.id));
    world.update(STEP, centre);
    for (let i = 0; i < 5; i++) {
      world.spawnCrate(new Vector3(centre.x, gridHeight(6, 6) + 20 + i, centre.z));
    }
    expect(world.sandboxPropCount).toBe(3);
    expect(world.stats.props).toBe(3);
    expect(removed).toHaveLength(2);
    expect(physics.bodyCount).toBe(4);
    world.clearSandboxProps();
    expect(world.sandboxPropCount).toBe(0);
    expect(world.stats.entities.total).toBe(0);
    expect(physics.bodyCount).toBe(1);
  });

  it('drops sandbox props with the seed and rebuilds ground colliders cleanly', async () => {
    const { world, physics } = await makeWorld();
    world.update(STEP, centre);
    world.spawnCrate(new Vector3(centre.x, gridHeight(6, 6) + 20, centre.z));
    expect(world.stats.entities.total).toBe(1);
    world.reset();
    expect(world.stats.entities.total).toBe(0);
    expect(physics.bodyCount).toBe(0);
    expect(world.stats.ground!.tiles).toBe(0);
    world.update(STEP, centre);
    expect(world.stats.ground!.tiles).toBe(1);
    expect(physics.bodyCount).toBe(1);
  });

  it('freezes simulation when physics is disabled without unloading the world', async () => {
    const { world } = await makeWorld();
    world.update(STEP, centre);
    const entity = world.spawnCrate(new Vector3(centre.x, gridHeight(6, 6) + 30, centre.z))!;
    const before = entity.position.y;
    world.setEnabled(false);
    expect(world.stats.enabled).toBe(false);
    for (let i = 0; i < 120; i++) world.update(STEP, centre);
    expect(entity.position.y).toBeCloseTo(before, 6);
    expect(world.stats.ground!.tiles).toBe(1);
    world.setEnabled(true);
    for (let i = 0; i < 120; i++) world.update(STEP, centre);
    expect(entity.position.y).toBeLessThan(before);
  });

  it('keeps origin-relative visuals aligned across a floating-origin rebase', async () => {
    const { world, physics, origin } = await makeWorld();
    world.update(STEP, centre);
    const entity = world.spawnCrate(new Vector3(centre.x, gridHeight(6, 6) + 5, centre.z))!;
    for (let i = 0; i < 60; i++) world.update(STEP, centre);
    const canonicalBefore = { ...entity.position };
    const localBefore = { ...entity.visual!.position };
    origin.update(new Vector3(6100, 0, -6100));
    const delta = origin.absolute.clone();
    expect(origin.shifts).toBe(1);
    for (let i = 0; i < 5; i++) world.update(STEP, centre);
    // Canonical position is preserved, the visual moved into the new local frame.
    expect(entity.position.x).toBeCloseTo(canonicalBefore.x, 0);
    expect(entity.position.z).toBeCloseTo(canonicalBefore.z, 0);
    expect(entity.visual!.position.x).toBeCloseTo(localBefore.x - delta.x, 0);
    expect(entity.visual!.position.z).toBeCloseTo(localBefore.z - delta.z, 0);
    // Terrain colliders survive the shift instead of being rebuilt.
    expect(world.stats.ground!.tiles).toBe(1);
    expect((await freshStats(physics)).bodies).toBe(2);
  });
});
