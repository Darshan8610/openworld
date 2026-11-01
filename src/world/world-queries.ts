import { TerrainField } from './terrain-field';
import { createClimateSample } from './biomes';
import type { ClimateSample, BiomeId } from './biomes';
import { createRoadSample } from './road-network';
import type { RoadSample } from './road-network';
import { clamp } from '../utils/math';
import { physicalMaterial } from '../physics/surfaces';
import type { PhysicalMaterial, SurfaceKind } from '../physics/surfaces';
import type { WorldPoint } from '../core/coordinates';
import type { WaterSample } from './water-field';

export interface RoadQuery {
  corridor: number;
  station: number;
  /** Signed distance from the centreline in metres (positive = right-hand side). */
  lateral: number;
  pullout: number;
  /** True inside the paved carriageway (|lateral| ≤ 5 m). */
  onCarriageway: boolean;
  /** True inside the gravel shoulder or an overlook pullout. */
  onShoulder: boolean;
}

export interface GroundSample {
  height: number;
  nx: number;
  ny: number;
  nz: number;
  /** Slope magnitude (0 = flat, 1 = 45°). */
  slope: number;
  surface: SurfaceKind;
  friction: number;
  restitution: number;
  onRoad: boolean;
  biome: BiomeId;
}

interface CacheEntry { height: number; surface: SurfaceKind; nx: number; ny: number; nz: number; slope: number }

/**
 * The single world-query facade.
 *
 * Terrain, objects, props, physics, NPCs, vehicles and traffic all ask this
 * class instead of re-deriving heights, surface types or road positions. It
 * wraps the authoritative `TerrainField` (the same field the workers stream),
 * so gameplay state never disagrees with the rendered mesh or with a different
 * terrain LOD.
 */
export class WorldQueries {
  readonly field: TerrainField;
  private readonly climate: ClimateSample = createClimateSample();
  private readonly roadSample: RoadSample = createRoadSample();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheLimit: number;

  constructor(public readonly seed: string, cacheLimit = 4096) {
    this.field = new TerrainField(seed);
    this.cacheLimit = cacheLimit;
  }

  /** Ground height including the graded road formation. */
  height(x: number, z: number): number { return this.field.height(x, z); }

  /** Height of the untouched landform, ignoring roads. */
  naturalHeight(x: number, z: number): number { return this.field.naturalHeight(x, z); }

  slope(x: number, z: number, sampleStep = 2): number {
    const dx = (this.height(x + sampleStep, z) - this.height(x - sampleStep, z)) / (2 * sampleStep);
    const dz = (this.height(x, z + sampleStep) - this.height(x, z - sampleStep)) / (2 * sampleStep);
    // atan of the gradient magnitude = slope angle; normalize to 0..1 over 45°.
    return Math.min(1, Math.atan(Math.hypot(dx, dz)) / (Math.PI / 4));
  }

  normal(x: number, z: number, out: WorldPoint = { x: 0, y: 1, z: 0 }, sampleStep = 2): WorldPoint {
    const dx = (this.height(x + sampleStep, z) - this.height(x - sampleStep, z)) / (2 * sampleStep);
    const dz = (this.height(x, z + sampleStep) - this.height(x, z - sampleStep)) / (2 * sampleStep);
    const length = Math.hypot(dx, 1, dz) || 1;
    out.x = -dx / length; out.y = 1 / length; out.z = -dz / length;
    return out;
  }

  climateAt(x: number, z: number, out = createClimateSample()): ClimateSample {
    const height = this.height(x, z);
    return this.field.sample(x, z, height, 1 - 1 / Math.hypot(1, this.slope(x, z) * 2), out);
  }

  biome(x: number, z: number): BiomeId { return this.climateAt(x, z).dominant; }

  /** Road-space query; `lateral` tells you how far off the centreline you are. */
  road(x: number, z: number, out: RoadQuery = { corridor: 0, station: 0, lateral: 0, pullout: 0, onCarriageway: false, onShoulder: false }): RoadQuery {
    this.field.roads.sample(x, z, this.roadSample);
    const lateral = Math.abs(this.roadSample.lateral);
    out.corridor = this.roadSample.corridor;
    out.station = this.roadSample.station;
    out.lateral = this.roadSample.lateral;
    out.pullout = this.roadSample.pullout;
    out.onCarriageway = lateral <= 5;
    out.onShoulder = lateral > 5 && lateral <= 7.2 + this.roadSample.pullout * 10;
    return out;
  }

  /** Closest point on the nearest carriageway centreline. */
  nearestRoadPoint(x: number, z: number): { x: number; z: number; corridor: number; station: number; lateral: number } {
    const road = this.road(x, z);
    const point = this.field.roads.point(road.corridor, road.station);
    return { ...point, corridor: road.corridor, station: road.station, lateral: road.lateral };
  }

  /**
   * Water at a canonical position (Phase 9). Objects, vegetation clearance and
   * placement all ask here instead of probing the hydrology themselves.
   */
  water(x: number, z: number, out?: WaterSample): WaterSample | undefined {
    return this.field.water.sampleAt(x, z, out);
  }

  /** Water surface elevation (waves excluded) or undefined on dry land. */
  waterSurface(x: number, z: number): number | undefined {
    return this.field.water.sampleAt(x, z)?.surfaceY;
  }

  /**
   * Surface classification for grip, footsteps, splashes and audio. Road
   * formation wins over climate, then snowline, exposed rock, dry steppe soil.
   */
  surface(x: number, z: number): SurfaceKind {
    const cached = this.cached(x, z);
    return cached.surface;
  }

  ground(x: number, z: number, out: GroundSample = blankGround()): GroundSample {
    const cached = this.cached(x, z);
    out.height = cached.height;
    out.nx = cached.nx; out.ny = cached.ny; out.nz = cached.nz;
    out.slope = cached.slope;
    out.surface = cached.surface;
    const material: PhysicalMaterial = physicalMaterial(cached.surface);
    out.friction = material.friction;
    out.restitution = material.restitution;
    out.onRoad = cached.surface === 'asphalt' || cached.surface === 'gravel';
    out.biome = this.biome(x, z);
    return out;
  }

  /**
   * Cheap hot-path sample (physics substeps). Quantized to 1.25 m and memoized,
   * which keeps noise evaluation out of the 120 Hz loop while staying well below
   * the scale of any prop.
   */
  groundFast(x: number, z: number): CacheEntry {
    const qx = Math.round(x / 1.25), qz = Math.round(z / 1.25);
    const key = `${qx}:${qz}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const entry = this.compute(qx * 1.25, qz * 1.25);
    if (this.cache.size >= this.cacheLimit) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, entry);
    return entry;
  }

  private cached(x: number, z: number): CacheEntry { return this.groundFast(x, z); }

  private compute(x: number, z: number): CacheEntry {
    const height = this.height(x, z);
    const step = 1.6;
    const dx = (this.height(x + step, z) - this.height(x - step, z)) / (2 * step);
    const dz = (this.height(x, z + step) - this.height(x, z - step)) / (2 * step);
    const length = Math.hypot(dx, 1, dz) || 1;
    const slope = Math.min(1, Math.atan(Math.hypot(dx, dz)) / (Math.PI / 4));

    const road = this.road(x, z);
    const lateral = Math.abs(road.lateral);
    let surface: SurfaceKind;
    if (lateral <= 5) surface = 'asphalt';
    else if (lateral <= 7.2 + road.pullout * 10 + 0.4) surface = 'gravel';
    else {
      const climate = this.field.sample(x, z, height, slope, this.climate);
      if (climate.snow > 0.55) surface = 'snow';
      else if (climate.rock > 0.5 || slope > 0.62) surface = 'rock';
      else if (climate.weights[2] > 0.45) surface = 'soil';
      else if (climate.weights[1] > 0.5) surface = 'grass';
      else surface = 'grass';
    }
    return { height, surface, nx: -dx / length, ny: 1 / length, nz: -dz / length, slope };
  }

  clearCache(): void { this.cache.clear(); }
}

export const blankGround = (): GroundSample => ({
  height: 0, nx: 0, ny: 1, nz: 0, slope: 0, surface: 'grass', friction: 0.72, restitution: 0.04, onRoad: false, biome: 0,
});

/** Height difference helper used by placement (keeps foundations buried correctly). */
export function terrainRelief(queries: WorldQueries, x: number, z: number, radius: number): { min: number; max: number; mean: number } {
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const height = queries.height(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    min = Math.min(min, height); max = Math.max(max, height); sum += height; count++;
  }
  const center = queries.height(x, z);
  min = Math.min(min, center); max = Math.max(max, center); sum += center; count++;
  return { min, max, mean: sum / count };
}

/** Kept for callers that only need a clamped height lookup. */
export function safeHeight(queries: WorldQueries, x: number, z: number): number {
  return clamp(queries.height(x, z), -2000, 8000);
}
