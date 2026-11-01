import { describe, expect, it } from 'vitest';
import { TerrainField } from '../src/world/terrain-field';
import { generateTile } from '../src/world/terrain-generator';
import { makeTile, tileSize } from '../src/world/tiles';
import type { TileRequest } from '../src/world/tiles';

function request(level: number, x: number, z: number, segments = 12): TileRequest {
  return { type: 'generate', id: 1, epoch: 0, seed: 'mesh-test', segments, ...makeTile(x, z, level) };
}

describe('worker terrain mesh', () => {
  const field = new TerrainField('mesh-test');

  it('builds finite, indexed geometry with normals and albedo', () => {
    const result = generateTile(request(5, 0, 0), field);
    const vertices = (12 + 1) ** 2 + 4 * (12 + 1);
    expect(result.positions.length).toBe(vertices * 3);
    expect(result.indices.length).toBe(12 * 12 * 6 + 4 * 12 * 6);
    expect(result.positions.every(Number.isFinite)).toBe(true);
    expect(result.normals.every(Number.isFinite)).toBe(true);
    expect(result.maxHeight).toBeGreaterThan(result.minHeight);
    expect(Math.max(...result.indices)).toBeLessThan(vertices);
  });

  it('matches shared edge heights exactly across neighbouring tiles', () => {
    const a = generateTile(request(4, 0, 0), field);
    const b = generateTile(request(4, 1, 0), field);
    const stride = 13;
    for (let iz = 0; iz <= 12; iz++) {
      const ha = a.positions[(iz * stride + 12) * 3 + 1]!;
      const hb = b.positions[(iz * stride) * 3 + 1]!;
      expect(ha).toBe(hb);
    }
  });

  it('samples the same world height at different LOD resolutions', () => {
    const coarse = generateTile(request(2, 0, 0, 12), field);
    const fine = generateTile(request(4, 0, 0, 12), field);
    const coarseCorner = coarse.positions[1]!;
    const fineCorner = fine.positions[1]!;
    expect(coarseCorner).toBe(fineCorner);
    // GPU buffers are Float32; compare against the double-precision field within 1e-4 m.
    expect(coarseCorner).toBeCloseTo(field.height(0, 0), 4);
  });

  it('adds downward skirts around the tile border', () => {
    const result = generateTile(request(3, 2, -1), field);
    const size = tileSize(3), stride = 13, grid = stride * stride;
    const topEdgeSource = 0;
    const skirtVertex = grid;
    expect(result.positions[skirtVertex * 3 + 1]).toBeLessThan(result.positions[topEdgeSource * 3 + 1]!);
    expect(result.positions[skirtVertex * 3]).toBe(-size / 2);
  });
});
