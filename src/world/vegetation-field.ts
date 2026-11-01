import { CONFIG } from '../config';
import { smoothstep } from '../utils/math';
import { hashSeed } from '../utils/random';
import { createClimateSample } from './biomes';
import type { TerrainField } from './terrain-field';
import { tileSize } from './tiles';
import type { TileCoord } from './tiles';

export const PLANT_KINDS = ['pine', 'aspen', 'shrub', 'grass', 'rock', 'spruce', 'birch', 'fern', 'flowers', 'cliff'] as const;
/** Root embedding keeps trunks planted and hides the flat bases of boulders. */
export const PLANT_EMBED = [0.12, 0.12, 0.12, 0.12, 0.18, 0.12, 0.12, 0.08, 0.08, 0.9] as const;
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
  { spacing: 14, minLevel: 3, salt: 0x714a, maximum: 0.82 },
  { spacing: 17, minLevel: 3, salt: 0x2b91, maximum: 0.38 },
  { spacing: 7, minLevel: 4, salt: 0x61c7, maximum: 0.58 },
  { spacing: 2.4, minLevel: 5, salt: 0x3a19, maximum: 0.9 },
  { spacing: 20, minLevel: 3, salt: 0x5d23, maximum: 0.78 },
  { spacing: 18, minLevel: 3, salt: 0x7e13, maximum: 0.62 },
  { spacing: 20, minLevel: 3, salt: 0x19c5, maximum: 0.46 },
  { spacing: 5, minLevel: 5, salt: 0x4bc1, maximum: 0.68 },
  { spacing: 6, minLevel: 5, salt: 0x2fd7, maximum: 0.62 },
  { spacing: 88, minLevel: 3, salt: 0x60a9, maximum: 0.58 },
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
  const roadSample = { corridor: 0, station: 0, lateral: 0, tangentX: 1, tangentZ: 0, normalX: 0, normalZ: 1, curvature: 0, pullout: 0 };
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
      // Keep the carriageway, shoulders, pullouts and cut/fill slopes clear.
      const corridor = Math.round((z - field.roads.center(0, x)) / CONFIG.roads.corridorSpacing);
      if (Math.abs(z - field.roads.center(corridor, x)) < 72) {
        field.roads.sample(x, z, roadSample);
        const clearance = (kind >= 4 && kind !== 7 && kind !== 8 ? 24 : 10) + roadSample.pullout * 12;
        if (Math.abs(roadSample.lateral) < clearance) continue;
      }
      const y = surfaceHeight ? surfaceHeight(x, z) : field.height(x, z);
      const dx = (field.height(x + 2, z) - field.height(x - 2, z)) / 4;
      const dz = (field.height(x, z + 2) - field.height(x, z - 2)) / 4;
      const slope = 1 - 1 / Math.hypot(dx, 1, dz);
      field.biomes.sample(x, z, y, slope, climate);
      const w = climate.weights;
      const stable = 1 - smoothstep(0.25, 0.52, slope);
      // Seeded grove / meadow clustering: dense stands alternate with open ground
      // instead of a uniform Poisson scatter that reads as sparse dots.
      const grove = smoothstep(-0.18, 0.5, field.cover.fbm(x * 0.0035, z * 0.0035, 2));
      const meadow = smoothstep(-0.3, 0.55, field.cover.fbm(x * 0.006 + 40, z * 0.006 - 19, 2));
      let probability = 0;
      if (kind === 0) probability = (w[1] * 0.78 + w[0] * 0.05 + w[3] * 0.03) * stable * (1 - climate.snow) * (0.2 + grove * 1.6);
      if (kind === 1) probability = (w[0] * 0.30 + w[1] * 0.14) * stable * (1 - smoothstep(550, 850, y)) * (0.3 + grove * 1.3);
      if (kind === 2) probability = (w[2] * 0.55 + w[0] * 0.30 + w[3] * 0.18 + w[1] * 0.16) * stable * (1 - climate.snow) * (0.4 + meadow * 1.1);
      if (kind === 3) probability = (w[0] * 0.92 + w[2] * 0.56 + w[1] * 0.48 + w[3] * 0.16) * stable * (1 - climate.snow) * (0.45 + meadow * 1.05);
      if (kind === 4) probability = (0.09 + climate.rock * 0.4 + w[3] * 0.22 + climate.snow * 0.1) * (1 - smoothstep(0.65, 0.88, slope));
      if (kind === 5) probability = (w[1] * 0.52 + w[3] * 0.18 + w[0] * 0.04) * stable * (1 - climate.snow) * (0.2 + grove * 1.5);
      if (kind === 6) probability = (w[0] * 0.34 + w[1] * 0.16) * stable * (1 - smoothstep(500, 820, y)) * (0.25 + grove * 1.4);
      if (kind === 7) probability = (w[0] * 0.62 + w[1] * 0.55 + w[3] * 0.08) * stable * (1 - climate.snow) * (0.2 + meadow * 1.3);
      if (kind === 8) probability = (w[0] * 0.58 + w[2] * 0.28 + w[1] * 0.12) * stable * (1 - climate.snow) * meadow;
      if (kind === 9) probability = (climate.rock * 0.5 + smoothstep(0.18, 0.46, slope) * 0.38 + w[3] * 0.16) * (0.3 + grove * 0.9);
      if (random > probability) continue;
      const r1 = cellRandom(canonicalX, canonicalZ, seedHash, rule.salt + 3);
      const r2 = cellRandom(canonicalX, canonicalZ, seedHash, rule.salt + 4);
      const scale = kind === 0 ? 0.8 + r1 * 1.0 : kind === 1 ? 0.75 + r1 * 0.7 : kind === 4 ? 0.5 + r1 * 1.8 : kind === 3 ? 0.8 + r1 * 0.9 : kind === 5 ? 0.8 + r1 * 1.05 : kind === 6 ? 0.75 + r1 * 0.75 : kind === 9 ? 0.8 + r1 * 1.9 : kind === 7 || kind === 8 ? 0.75 + r1 * 0.7 : 0.7 + r1 * 0.9;
      records.push(x - left, y - PLANT_EMBED[kind]!, z - top, scale, r2 * Math.PI * 2, kind, 0.75 + r1 * 0.45, random);
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
