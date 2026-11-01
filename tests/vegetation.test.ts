import { describe, expect, it } from 'vitest';
import { TerrainField } from '../src/world/terrain-field';
import { generateTile } from '../src/world/terrain-generator';
import { generateVegetation, PLANT_STRIDE, readPlant } from '../src/world/vegetation-field';
import type { PlantPlacement } from '../src/world/vegetation-field';
import { makeTile, tileSize } from '../src/world/tiles';
import type { TileRequest } from '../src/world/tiles';
import { createPlantGeometry } from '../src/rendering/vegetation-geometry';
import { PLANT_KINDS } from '../src/world/vegetation-field';
import { QUALITY } from '../src/config';

const request = (level: number, x: number, z: number): TileRequest => ({ type: 'generate', id: 1, epoch: 0, seed: 'plants', segments: 12, ...makeTile(x, z, level) });
const blank: PlantPlacement = { x: 0, y: 0, z: 0, scale: 1, yaw: 0, kind: 0, brightness: 1, random: 0 };

describe('canonical vegetation placement', () => {
  const field = new TerrainField('plants');
  it('is deterministic, finite, tile-local and within budgeted species', () => {
    const coord = makeTile(-1, 2, 5), a = generateVegetation(coord, 'plants', field), b = generateVegetation(coord, 'plants', field);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length % PLANT_STRIDE).toBe(0);
    expect(a.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < a.length / PLANT_STRIDE; i++) {
      const p = readPlant(a, i, blank);
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThan(128);
      expect(p.z).toBeGreaterThanOrEqual(0); expect(p.z).toBeLessThan(128);
      expect(p.kind).toBeGreaterThanOrEqual(0); expect(p.kind).toBeLessThan(5);
      expect(p.scale).toBeGreaterThan(0);
    }
  });
  it('keeps the same canonical XZ positions when terrain LOD changes', () => {
    const coarse = generateVegetation(makeTile(0, 0, 4), 'plants', field);
    const positions: { kind: number; x: number; z: number }[] = [];
    // One level-4 tile covers four level-5 tiles, not just the origin child.
    for (const [fx, fz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const fine = generateVegetation(makeTile(fx, fz, 5), 'plants', field);
      for (let i = 0; i < fine.length / PLANT_STRIDE; i++) {
        const p = readPlant(fine, i, blank);
        if (p.kind === 0 || p.kind === 1 || p.kind === 4) positions.push({ kind: p.kind, x: p.x + fx * 128, z: p.z + fz * 128 });
      }
    }
    let checked = 0;
    for (let i = 0; i < coarse.length / PLANT_STRIDE; i++) {
      const p = readPlant(coarse, i, blank);
      if (p.kind === 0 || p.kind === 1 || p.kind === 4) {
        // Local Float32 roundoff differs with tile size; compare restored doubles.
        expect(positions.some((q) => q.kind === p.kind && Math.abs(q.x - p.x) < 0.001 && Math.abs(q.z - p.z) < 0.001)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
  it('does not duplicate boundary cells between neighbouring tiles', () => {
    const a = generateVegetation(makeTile(0, 0, 5), 'plants', field), b = generateVegetation(makeTile(1, 0, 5), 'plants', field);
    const keys = new Set<string>();
    for (const [data, offset] of [[a, 0], [b, 128]] as const) for (let i = 0; i < data.length / PLANT_STRIDE; i++) {
      const p = readPlant(data, i, blank), key = `${p.kind}:${p.x + offset}:${p.z}`;
      expect(keys.has(key)).toBe(false); keys.add(key);
    }
  });
  it('roots transferred instances on the rendered terrain triangles', () => {
    const tile = generateTile(request(5, 0, 0), field);
    expect(tile.vegetation.length).toBeGreaterThan(0);
    const size = tileSize(5), n = 12, stride = 13;
    for (let i = 0; i < tile.vegetation.length / PLANT_STRIDE; i++) {
      const p = readPlant(tile.vegetation, i, blank);
      const fx = p.x / size * n, fz = p.z / size * n, ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
      const h = (x: number, z: number) => tile.positions[(z * stride + x) * 3 + 1]!;
      const a = h(ix, iz), b = h(ix + 1, iz), c = h(ix, iz + 1), d = h(ix + 1, iz + 1);
      const expected = u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
      expect(p.y).toBeCloseTo(expected - 0.12, 4);
    }
  });
  it('transfers surface masks and plant buffers with the mesh', () => {
    const tile = generateTile(request(5, 0, 0), field);
    expect(tile.surface.length).toBe(tile.colors.length);
    expect(tile.surface.every(Number.isFinite)).toBe(true);
    expect(tile.vegetation.buffer).not.toBe(tile.positions.buffer);
  });
});

describe('vegetation rendering assets', () => {
  it('builds five finite vertex-colored meshes and fixed quality budgets', () => {
    for (const kind of PLANT_KINDS) {
      const geometry = createPlantGeometry(kind);
      expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
      expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count);
      expect(Array.from(geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
      geometry.dispose();
    }
    expect(QUALITY.low.instanceBudgets.reduce((a, b) => a + b, 0)).toBeLessThan(10000);
    expect(QUALITY.high.instanceBudgets.reduce((a, b) => a + b, 0)).toBeLessThan(40000);
  });
});
