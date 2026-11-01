import { CONFIG } from '../config';

export interface TileCoord {
  x: number;
  z: number;
  level: number;
  rootX: number;
  rootZ: number;
}
export interface TileRequest extends TileCoord {
  type: 'generate';
  id: number;
  epoch: number;
  seed: string;
  segments: number;
}
export interface TileResult {
  type: 'tile';
  id: number;
  epoch: number;
  key: string;
  coord: TileCoord;
  segments: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per-vertex rock weight, snow weight, dominant biome id. */
  surface: Float32Array;
  /** Packed canonical vegetation records in tile-local XZ coordinates. */
  vegetation: Float32Array;
  indices: Uint32Array;
  minHeight: number;
  maxHeight: number;
}
export interface TileError { type: 'error'; id: number; epoch: number; message: string }
export type TerrainResponse = TileResult | TileError;
export const tileSize = (level: number): number => CONFIG.terrain.rootSize / 2 ** level;
export const tileKey = (t: TileCoord): string => `${t.level}:${t.x}:${t.z}`;
export const rootKey = (t: TileCoord): string => `${t.rootX}:${t.rootZ}`;

export function makeTile(x: number, z: number, level: number): TileCoord {
  const scale = 2 ** level;
  return { x, z, level, rootX: Math.floor(x / scale), rootZ: Math.floor(z / scale) };
}

/** Distance to the tile's XZ bounds, not its centre: LOD is stable across edges. */
export function distanceToTile(t: TileCoord, x: number, z: number): number {
  const size = tileSize(t.level);
  const dx = Math.max(t.x * size - x, 0, x - (t.x + 1) * size);
  const dz = Math.max(t.z * size - z, 0, z - (t.z + 1) * size);
  return Math.hypot(dx, dz);
}

/** Exact partition: a square is visited once, and only at one selected depth. */
export function selectTiles(x: number, z: number, radius: number): TileCoord[] {
  const result: TileCoord[] = [];
  const rx = Math.floor(x / CONFIG.terrain.rootSize), rz = Math.floor(z / CONFIG.terrain.rootSize);
  const visit = (t: TileCoord): void => {
    const size = tileSize(t.level);
    if (t.level < CONFIG.terrain.maxDepth && distanceToTile(t, x, z) < size * CONFIG.terrain.splitDistance) {
      for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        visit(makeTile(t.x * 2 + dx, t.z * 2 + dz, t.level + 1));
      }
    } else result.push(t);
  };
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
    visit(makeTile(rx + dx, rz + dz, 0));
  }
  return result;
}
