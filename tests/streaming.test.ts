import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { CONFIG } from '../src/config';
import { selectTiles, tileSize, tileKey, makeTile } from '../src/world/tiles';
import { FloatingOrigin } from '../src/core/floating-origin';
import { FixedLoop } from '../src/core/fixed-loop';

describe('quadtree streaming', () => {
  it('partitions the root window exactly, without holes or overlaps', () => {
    for (const [x, z] of [[0, 0], [127.9, -0.1], [-4096, 4095], [13579, -24680]] as const) {
      const tiles = selectTiles(x, z, 2);
      expect(new Set(tiles.map(tileKey)).size).toBe(tiles.length);
      const area = tiles.reduce((sum, t) => sum + tileSize(t.level) ** 2, 0);
      expect(area).toBe((5 * CONFIG.terrain.rootSize) ** 2);
      for (const t of tiles) {
        const size = tileSize(t.level);
        expect(Number.isInteger(t.x)).toBe(true);
        expect(t.level).toBeLessThanOrEqual(CONFIG.terrain.maxDepth);
        expect(makeTile(t.x, t.z, t.level).rootX).toBe(t.rootX);
        expect(size).toBeGreaterThanOrEqual(128);
      }
    }
  });
  it('uses its finest LOD near the observer and coarse geometry at the horizon', () => {
    const tiles = selectTiles(100, 100, 2);
    expect(tiles.find(t => 100 >= t.x * tileSize(t.level) && 100 < (t.x + 1) * tileSize(t.level) && 100 >= t.z * tileSize(t.level) && 100 < (t.z + 1) * tileSize(t.level))?.level).toBe(5);
    expect(tiles.some(t => t.level === 0)).toBe(true);
  });
  it('keeps memory selection bounded while moving', () => {
    const counts = Array.from({ length: 30 }, (_, i) => selectTiles(i * 1500, i * -700, 2).length);
    expect(Math.max(...counts)).toBeLessThan(420);
  });
});

describe('floating origin', () => {
  it('preserves world-to-local coordinates through repeated rebases', () => {
    const origin = new FloatingOrigin();
    const meshWorld = new Vector3(1000000.25, 350, -2000000.75);
    const meshLocal = origin.toLocal(meshWorld);
    origin.onChange(delta => meshLocal.sub(delta));
    const player = new Vector3();
    for (let i = 0; i < 100; i++) {
      player.set(i * 3000, 350, i * -3000);
      origin.update(player);
      const local = origin.toLocal(player);
      expect(Math.max(Math.abs(local.x), Math.abs(local.z))).toBeLessThanOrEqual(CONFIG.origin.rebaseDistance);
      expect(meshLocal.clone().add(origin.absolute).distanceTo(meshWorld)).toBe(0);
    }
    expect(origin.shifts).toBeGreaterThan(90);
  });
  it('also rebases when returning toward world zero', () => {
    const origin = new FloatingOrigin();
    origin.update(new Vector3(100000, 400, -100000));
    const before = origin.shifts;
    origin.update(new Vector3(97000, 400, -97000));
    expect(origin.shifts).toBeGreaterThan(before);
    expect(Math.abs(97000 - origin.x)).toBeLessThanOrEqual(CONFIG.origin.rebaseDistance);
    expect(Math.abs(-97000 - origin.z)).toBeLessThanOrEqual(CONFIG.origin.rebaseDistance);
  });
});

describe('fixed clock', () => {
  it('steps at 120 Hz and bounds catch-up after a long frame', () => {
    const loop = new FixedLoop(); let steps = 0; let alpha = 0;
    loop.tick(1000, () => steps++, (_alpha) => { alpha = _alpha; });
    loop.tick(2000, () => steps++, (_alpha) => { alpha = _alpha; });
    expect(steps).toBe(CONFIG.physics.maxSubSteps);
    expect(alpha).toBeGreaterThanOrEqual(0); expect(alpha).toBeLessThan(1);
    expect(loop.droppedTime).toBeGreaterThan(0.9);
  });
});
