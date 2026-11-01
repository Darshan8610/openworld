import { CONFIG } from '../config';
import { smoothstep } from '../utils/math';
import { hashSeed } from '../utils/random';
import { createClimateSample } from './biomes';
import type { TerrainField } from './terrain-field';
import { tileSize } from './tiles';
import type { TileCoord } from './tiles';

export const PLANT_KINDS = ['pine', 'aspen', 'shrub', 'grass', 'rock'] as const;
export type PlantKind = typeof PLANT_KINDS[number];
/** local X, world Y, local Z, scale, yaw, kind, brightness, stable random. */
export const PLANT_STRIDE = 8;
export interface PlantPlacement {
  x: number; y: number; z: number; scale: number; yaw: number;
  kind: number; brightness: number; random: number;
}

/** Integer-coordinate hash: never hash a floating-point world position. */
export function cellRandom(x: number, z: number, seed: number, salt: number): number {
  let h = seed ^ Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495) ^ salt;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const RULES = [
  { spacing: 16, minLevel: 3, salt: 0x714a, maximum: 0.67 },
  { spacing: 20, minLevel: 3, salt: 0x2b91, maximum: 0.28 },
  { spacing: 9, minLevel: 4, salt: 0x61c7, maximum: 0.47 },
  { spacing: 3.2, minLevel: 5, salt: 0x3a19, maximum: 0.76 },
  { spacing: 22, minLevel: 3, salt: 0x5d23, maximum: 0.74 },
] as const;

/**
 * Canonical world-cell placement, not random points per mesh. Coarse LODs visit
 * a deterministic subset of the same accepted cells. A tree therefore never
 * jumps to a new position or appears from nowhere when terrain LOD changes.
 * XZ is tile-local in the transferable buffer; the manager restores it in doubles.
 */
export function generateVegetation(coord: TileCoord, seed: string, field: TerrainField, surfaceHeight?: (x: number, z: number) => number): Float32Array {
  const size = tileSize(coord.level), left = coord.x * size, top = coord.z * size;
  const seedHash = hashSeed(seed), climate = createClimateSample();
  const records: number[] = [];
  for (let kind = 0; kind < RULES.length; kind++) {
    const rule = RULES[kind]!;
    if (coord.level < rule.minLevel) continue;
    const stride = 2 ** (CONFIG.terrain.maxDepth - coord.level);
    const firstX = Math.floor(left / rule.spacing), lastX = Math.ceil((left + size) / rule.spacing);
    const firstZ = Math.floor(top / rule.spacing), lastZ = Math.ceil((top + size) / rule.spacing);
    for (let canonicalZ = firstZ; canonicalZ < lastZ; canonicalZ++) for (let canonicalX = firstX; canonicalX < lastX; canonicalX++) {
      if (((canonicalX % stride) + stride) % stride !== 0 || ((canonicalZ % stride) + stride) % stride !== 0) continue;
      const random = cellRandom(canonicalX, canonicalZ, seedHash, rule.salt);
      if (random > rule.maximum) continue;
      const x = canonicalX * rule.spacing + cellRandom(canonicalX, canonicalZ, seedHash, rule.salt + 1) * rule.spacing * 0.86;
      const z = canonicalZ * rule.spacing + cellRandom(canonicalX, canonicalZ, seedHash, rule.salt + 2) * rule.spacing * 0.86;
      if (x < left || x >= left + size || z < top || z >= top + size) continue;
      const y = surfaceHeight ? surfaceHeight(x, z) : field.height(x, z);
      const dx = (field.height(x + 2, z) - field.height(x - 2, z)) / 4;
      const dz = (field.height(x, z + 2) - field.height(x, z - 2)) / 4;
      const slope = 1 - 1 / Math.hypot(dx, 1, dz);
      field.biomes.sample(x, z, y, slope, climate);
      const w = climate.weights;
      const stable = 1 - smoothstep(0.25, 0.52, slope);
      let probability = 0;
      if (kind === 0) probability = (w[1] * 0.61 + w[0] * 0.035 + w[3] * 0.025) * stable * (1 - climate.snow);
      if (kind === 1) probability = (w[0] * 0.19 + w[1] * 0.09) * stable * (1 - smoothstep(550, 850, y));
      if (kind === 2) probability = (w[2] * 0.47 + w[0] * 0.24 + w[3] * 0.16 + w[1] * 0.12) * stable * (1 - climate.snow);
      if (kind === 3) probability = (w[0] * 0.76 + w[2] * 0.43 + w[1] * 0.34 + w[3] * 0.12) * stable * (1 - climate.snow);
      if (kind === 4) probability = (0.08 + climate.rock * 0.36 + w[3] * 0.2 + climate.snow * 0.1) * (1 - smoothstep(0.65, 0.88, slope));
      if (random > probability) continue;
      const r1 = cellRandom(canonicalX, canonicalZ, seedHash, rule.salt + 3);
      const r2 = cellRandom(canonicalX, canonicalZ, seedHash, rule.salt + 4);
      const scale = kind === 0 ? 0.7 + r1 * 0.8 : kind === 1 ? 0.7 + r1 * 0.6 : kind === 4 ? 0.5 + r1 * 1.6 : 0.65 + r1 * 0.8;
      records.push(x - left, y - 0.12, z - top, scale, r2 * Math.PI * 2, kind, 0.8 + r1 * 0.35, random);
    }
  }
  return new Float32Array(records);
}

/** Read a packed worker record without allocating in the render loop. */
export function readPlant(data: Float32Array, index: number, out: PlantPlacement): PlantPlacement {
  const i = index * PLANT_STRIDE;
  out.x = data[i]!; out.y = data[i + 1]!; out.z = data[i + 2]!;
  out.scale = data[i + 3]!; out.yaw = data[i + 4]!; out.kind = data[i + 5]!;
  out.brightness = data[i + 6]!; out.random = data[i + 7]!;
  return out;
}
