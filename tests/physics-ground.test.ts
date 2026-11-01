import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { PhysicsGroundStreamer } from '../src/physics/ground-streamer';
import type { GroundTile } from '../src/physics/ground-streamer';
import { PhysicsWorld } from '../src/physics/physics-world';
import { TerrainField } from '../src/world/terrain-field';
import { generateTile } from '../src/world/terrain-generator';
import { makeTile, tileSize } from '../src/world/tiles';
import type { TileRequest } from '../src/world/tiles';

const STEP = 1 / 120;
const field = new TerrainField('ground-seed');
const coord = makeTile(0, 0, 4);
const segments = 12;
const request: TileRequest = { type: 'generate', id: 1, epoch: 0, seed: 'ground-seed', segments, ...coord };
const generated = generateTile(request, field);
const geometry = new BufferGeometry();
geometry.setAttribute('position', new BufferAttribute(generated.positions, 3));
const tile: GroundTile = { coord, segments, mesh: new Mesh(geometry) };
const size = tileSize(4);
const left = coord.x * size;
const top = coord.z * size;
const step = size / segments;
const stride = segments + 1;

const worlds: PhysicsWorld[] = [];
const streamers: PhysicsGroundStreamer[] = [];

async function setup(origin = new FloatingOrigin()) {
  const physics = await PhysicsWorld.create({ origin });
  worlds.push(physics);
  const streamer = new PhysicsGroundStreamer(physics, { activeTiles: [tile], revision: 0 }, {
    radius: 2000, minLevel: 4, maxTiles: 4, buildsPerUpdate: 8,
  });
  streamers.push(streamer);
  streamer.update({ x: left + size / 2, y: 0, z: top + size / 2 }, 1);
  physics.step(STEP);
  return { physics, streamer, origin };
}

const gridHeight = (ix: number, iz: number): number => generated.positions[(iz * stride + ix) * 3 + 1]!;
const meshHeight = (ix: number, iz: number): number => gridHeight(ix, iz);

afterEach(() => {
  while (streamers.length > 0) streamers.pop()?.dispose();
  while (worlds.length > 0) worlds.pop()?.dispose();
});

describe('physics ground streaming', () => {
  it('builds a bounded heightfield collider for streamed terrain tiles', async () => {
    const { physics, streamer } = await setup();
    expect(streamer.stats.tiles).toBe(1);
    expect(physics.stats.bodies).toBe(1);
    expect(physics.stats.colliders).toBe(1);
    expect(physics.stats.fixed).toBe(1);
    expect(streamer.stats.vertices).toBe(stride * stride);
  });

  it('matches the rendered terrain grid at every sampled vertex', async () => {
    const { physics } = await setup();
    let worst = 0;
    for (let iz = 1; iz < segments; iz += 2) {
      for (let ix = 1; ix < segments; ix += 3) {
        const worldX = left + ix * step;
        const worldZ = top + iz * step;
        const expected = gridHeight(ix, iz);
        const hit = physics.raycast(new Vector3(worldX, expected + 100, worldZ), new Vector3(0, -1, 0), 300);
        expect(hit).toBeDefined();
        worst = Math.max(worst, Math.abs(hit!.point.y - expected));
      }
    }
    // Collider and visual grid are the same samples, so agreement is near exact.
    expect(worst).toBeLessThan(0.05);
  });

  it('stays within the mesh triangle shape between grid samples', async () => {
    const { physics } = await setup();
    let worst = 0;
    for (let iz = 0; iz < segments; iz += 2) {
      for (let ix = 0; ix < segments; ix += 2) {
        const worldX = left + (ix + 0.35) * step;
        const worldZ = top + (iz + 0.65) * step;
        const a = meshHeight(ix, iz), b = meshHeight(ix + 1, iz);
        const c = meshHeight(ix, iz + 1), d = meshHeight(ix + 1, iz + 1);
        const u = 0.35, v = 0.65;
        // Same diagonal split as the terrain index buffer (a-c-b / b-c-d).
        const triangle = u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
        const hit = physics.raycast(new Vector3(worldX, triangle + 100, worldZ), new Vector3(0, -1, 0), 300)!;
        worst = Math.max(worst, Math.abs(hit.point.y - triangle));
      }
    }
    // Measured agreement between Rapier's heightfield triangulation and the
    // rendered mesh diagonal: worst case here is under a centimetre.
    expect(worst).toBeLessThan(0.1);
  });

  it('lands rigid bodies on the streamed terrain surface', async () => {
    const { physics } = await setup();
    // Pick the flattest interior grid node so the crate cannot simply slide off.
    let bestIx = 6, bestIz = 6, bestSlope = Infinity;
    for (let iz = 2; iz < segments - 2; iz++) {
      for (let ix = 2; ix < segments - 2; ix++) {
        const here = gridHeight(ix, iz);
        const slope = Math.max(
          Math.abs(gridHeight(ix + 1, iz) - here),
          Math.abs(gridHeight(ix - 1, iz) - here),
          Math.abs(gridHeight(ix, iz + 1) - here),
          Math.abs(gridHeight(ix, iz - 1) - here),
        ) / step;
        if (slope < bestSlope) { bestSlope = slope; bestIx = ix; bestIz = iz; }
      }
    }
    const worldX = left + bestIx * step;
    const worldZ = top + bestIz * step;
    const surface = gridHeight(bestIx, bestIz);
    const body = physics.createSolid(
      { position: new Vector3(worldX, surface + 40, worldZ) },
      { type: 'box', halfExtents: { x: 0.4, y: 0.4, z: 0.4 } },
      { material: 'soil' },
    )!;
    for (let i = 0; i < 900; i++) physics.step(STEP);
    const resting = physics.positionOf(body);
    // The crate must be resting on real ground rather than falling through it.
    const beneath = physics.raycast(new Vector3(resting.x, resting.y + 60, resting.z), new Vector3(0, -1, 0), 200);
    expect(beneath).toBeDefined();
    expect(Math.abs(resting.y - beneath!.point.y)).toBeLessThan(0.8);
    expect(resting.y).toBeLessThan(surface + 3);
  });

  it('keeps colliders aligned through a floating-origin rebase', async () => {
    const origin = new FloatingOrigin();
    const { physics } = await setup(origin);
    const ix = 4, iz = 7;
    const worldX = left + ix * step;
    const worldZ = top + iz * step;
    const surface = gridHeight(ix, iz);
    const before = physics.raycast(new Vector3(worldX, surface + 100, worldZ), new Vector3(0, -1, 0), 300)!;
    origin.update(new Vector3(3000, 450, 0));
    expect(physics.stats.rebases).toBeGreaterThan(0);
    // Rapier rebuilds its broad-phase during a step; the game steps immediately
    // after streaming, so one step is the documented query-refresh point.
    physics.step(STEP);
    const after = physics.raycast(new Vector3(worldX, surface + 100, worldZ), new Vector3(0, -1, 0), 300)!;
    expect(after.point.y).toBeCloseTo(before.point.y, 2);
    expect(after.point.x).toBeCloseTo(worldX, 2);
    expect(after.point.z).toBeCloseTo(worldZ, 2);
  });

  it('drops colliders when the observer leaves the tile, staying within budget', async () => {
    const { physics, streamer } = await setup();
    expect(streamer.stats.tiles).toBe(1);
    streamer.update({ x: left + 20000, y: 0, z: top + 20000 }, 1);
    expect(streamer.stats.tiles).toBe(0);
    expect(physics.bodyCount).toBe(0);
  });

  it('caps colliders to the nearest tiles when the source overflows', async () => {
    const physics = await PhysicsWorld.create({ origin: new FloatingOrigin() });
    worlds.push(physics);
    const many: GroundTile[] = [];
    for (let i = 0; i < 5; i++) {
      const c = makeTile(i, 0, 4);
      const result = generateTile({ ...request, ...c }, field);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(result.positions, 3));
      many.push({ coord: c, segments, mesh: new Mesh(g) });
    }
    const streamer = new PhysicsGroundStreamer(physics, { activeTiles: many, revision: 0 }, {
      radius: 4000, minLevel: 4, maxTiles: 2, buildsPerUpdate: 8,
    });
    streamers.push(streamer);
    streamer.update({ x: left, y: 0, z: top }, 1);
    expect(streamer.stats.tiles).toBe(2);
    expect(streamer.stats.budgetReached).toBe(true);
    expect(physics.bodyCount).toBe(2);
  });
});
