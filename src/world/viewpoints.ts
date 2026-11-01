import { TerrainField } from './terrain-field';
import type { BiomeId } from './biomes';
import { clamp } from '../utils/math';

export interface Viewpoint { x: number; y: number; z: number; score: number }

/**
 * Deterministic, seed-local overlook search used only for survey travel. It does
 * not alter terrain or vegetation; it just finds a pleasant place to stand inside
 * a requested climate region. Coarse sampling keeps this off the streaming path.
 */
export function findBiomeViewpoint(seed: string, biome: BiomeId, nearX = 0, nearZ = 0, radius = 6000): Viewpoint {
  const field = new TerrainField(seed);
  const step = radius > 7000 ? 450 : 320;
  const count = Math.ceil(radius / step);
  let best: Viewpoint = { x: nearX, y: field.height(nearX, nearZ), z: nearZ, score: -Infinity };
  for (let iz = -count; iz <= count; iz++) for (let ix = -count; ix <= count; ix++) {
    const x = nearX + ix * step, z = nearZ + iz * step;
    const distance = Math.hypot(x - nearX, z - nearZ);
    if (distance > radius) continue;
    const y = field.height(x, z);
    const dx = (field.height(x + 12, z) - field.height(x - 12, z)) / 24;
    const dz = (field.height(x, z + 12) - field.height(x, z - 12)) / 24;
    const slope = 1 - 1 / Math.hypot(dx, 1, dz);
    const climate = field.sample(x, z, y, slope);
    const weight = climate.weights[biome];
    // Prefer the requested biome, gentle overlooks, and nearby travel.
    const score = weight * 3 - Math.abs(slope - 0.16) * 1.4 - (distance / radius) * 0.45 - (slope > 0.5 ? 2 : 0);
    if (score > best.score) best = { x, y, z, score };
  }
  best.y = clamp(best.y, -1000, 5000);
  return best;
}


/** Pick a seed-local launch station on a corridor inside the route's climate. */
export function findRouteStation(seed: string, corridor: number, biome: BiomeId, nearStation: number, radius = 3600): number {
  const field = new TerrainField(seed);
  let best = nearStation, bestScore = -Infinity;
  for (let offset = -radius; offset <= radius; offset += 180) {
    const station = nearStation + offset;
    const point = field.roads.point(corridor, station);
    const y = field.naturalHeight(point.x, point.z);
    const dx = (field.naturalHeight(point.x + 12, point.z) - field.naturalHeight(point.x - 12, point.z)) / 24;
    const dz = (field.naturalHeight(point.x, point.z + 12) - field.naturalHeight(point.x, point.z - 12)) / 24;
    const slope = 1 - 1 / Math.hypot(dx, 1, dz);
    const climate = field.sample(point.x, point.z, y, slope);
    const weight = biome >= 3 ? Math.max(climate.weights[3]!, climate.weights[4]!) : climate.weights[biome]!;
    const score = weight * 3 - Math.abs(offset) / radius * 0.45 - (slope > 0.45 ? 1.5 : 0);
    if (score > bestScore) { bestScore = score; best = station; }
  }
  return best;
}
