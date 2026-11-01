import { Vector3 } from 'three/webgpu';
import type { BiomeId } from './biomes';
import { createRoadSample } from './road-network';
import type { RoadNetwork, RoadSample } from './road-network';

/**
 * Gameplay-facing surface classes. `world/materials` maps these to physics
 * friction/restitution, and later phases map them to footsteps, tyre grip,
 * particles and audio — one classification, many consumers.
 */
export type SurfaceKind =
  | 'asphalt' | 'gravel' | 'grass' | 'soil' | 'rock' | 'snow' | 'ice' | 'water';

/** Bounds of the road formation, shared by queries and surface classification. */
export const ROAD_GEOMETRY = {
  asphaltHalfWidth: 5.0,
  shoulderHalfWidth: 7.2,
  pulloutExtraWidth: 10,
  /** No road entity is reported beyond this lateral distance from a centreline. */
  queryRange: 64,
} as const;

export interface RoadQuery {
  corridor: number;
  station: number;
  lateral: number;
  pullout: number;
  curvature: number;
  onCarriageway: boolean;
  onShoulder: boolean;
  name: string;
  number: string;
  kilometre: number;
}

export interface RoadPoint {
  x: number;
  z: number;
  station: number;
  corridor: number;
  lateral: number;
}

/** Implemented by Phase 9 (lakes/rivers/ocean). Absent until water exists. */
export interface WaterProvider {
  (x: number, z: number): WaterQuery | undefined;
}

export interface WaterQuery {
  bodyId: string;
  surfaceHeight: number;
  depth: number;
  flowX: number;
  flowZ: number;
}

export interface WorldSample {
  /** Terrain height; undefined outside the streamed window. */
  height?: number;
  normal?: Vector3;
  /** 0 flat, 1 vertical. Derived from the height field gradient. */
  slope?: number;
  biome: BiomeId;
  surface: SurfaceKind;
  road?: RoadQuery;
  water?: WaterQuery;
}

export interface TerrainSource {
  heightAt(x: number, z: number): number | undefined;
  biomeAt(x: number, z: number): number;
}

/**
 * The single authoritative answer to "what is at this world position?".
 * Terrain height/biome come from the streamed tiles (not a second noise copy),
 * roads come from the analytic road network, and water arrives later through a
 * registered provider. Nothing else in the game may re-derive these values.
 */
export class WorldQuery {
  private readonly sample: RoadSample = createRoadSample();
  private readonly terrain: TerrainSource;
  private readonly roads?: RoadNetwork;
  private water?: WaterProvider;

  constructor(terrain: TerrainSource, roads?: RoadNetwork) {
    this.terrain = terrain;
    if (roads) this.roads = roads;
  }

  registerWater(provider: WaterProvider | undefined): void { this.water = provider; }

  heightAt(x: number, z: number): number | undefined { return this.terrain.heightAt(x, z); }

  biomeAt(x: number, z: number): BiomeId { return this.terrain.biomeAt(x, z) as BiomeId; }

  slopeAt(x: number, z: number, delta = 1.5): number | undefined {
    const left = this.terrain.heightAt(x - delta, z), right = this.terrain.heightAt(x + delta, z);
    const down = this.terrain.heightAt(x, z - delta), up = this.terrain.heightAt(x, z + delta);
    if (left === undefined || right === undefined || down === undefined || up === undefined) return undefined;
    const dx = (right - left) / (2 * delta), dz = (up - down) / (2 * delta);
    return 1 - 1 / Math.hypot(dx, 1, dz);
  }

  normalAt(x: number, z: number, target = new Vector3(), delta = 1.5): Vector3 | undefined {
    const left = this.terrain.heightAt(x - delta, z), right = this.terrain.heightAt(x + delta, z);
    const down = this.terrain.heightAt(x, z - delta), up = this.terrain.heightAt(x, z + delta);
    if (left === undefined || right === undefined || down === undefined || up === undefined) return undefined;
    const dx = (right - left) / (2 * delta), dz = (up - down) / (2 * delta);
    return target.set(-dx, 1, -dz).normalize();
  }

  /** Road formation under (x, z), or undefined when no corridor is within range. */
  roadAt(x: number, z: number): RoadQuery | undefined {
    const roads = this.roads;
    if (!roads) return undefined;
    const corridor = Math.round((z - roads.center(0, x)) / 2048);
    if (Math.abs(z - roads.center(corridor, x)) > ROAD_GEOMETRY.queryRange) return undefined;
    roads.sample(x, z, this.sample);
    const lateral = Math.abs(this.sample.lateral);
    const shoulder = ROAD_GEOMETRY.shoulderHalfWidth + this.sample.pullout * ROAD_GEOMETRY.pulloutExtraWidth;
    if (lateral > shoulder) return undefined;
    const info = roads.routeInfo(this.sample.corridor, this.sample.station);
    return {
      corridor: this.sample.corridor,
      station: this.sample.station,
      lateral: this.sample.lateral,
      pullout: this.sample.pullout,
      curvature: this.sample.curvature,
      onCarriageway: lateral <= ROAD_GEOMETRY.asphaltHalfWidth,
      onShoulder: lateral > ROAD_GEOMETRY.asphaltHalfWidth,
      name: info.name,
      number: info.number,
      kilometre: info.kilometre,
    };
  }

  /** Nearest point on the road centreline; used for navigation and resets. */
  nearestRoadPoint(x: number, z: number): RoadPoint | undefined {
    const roads = this.roads;
    if (!roads) return undefined;
    const sample = roads.sample(x, z, createRoadSample());
    const point = roads.point(sample.corridor, sample.station);
    return { x: point.x, z: point.z, station: sample.station, corridor: sample.corridor, lateral: sample.lateral };
  }

  surfaceAt(x: number, z: number): SurfaceKind {
    const water = this.water?.(x, z);
    const height = this.terrain.heightAt(x, z);
    if (water && height !== undefined && height < water.surfaceHeight) return 'water';
    const road = this.roadAt(x, z);
    if (road) return road.onCarriageway ? 'asphalt' : 'gravel';
    const biome = this.biomeAt(x, z);
    const slope = this.slopeAt(x, z) ?? 0;
    if (height !== undefined && biome === 4 && slope < 0.62) return 'snow';
    if (slope > 0.5) return 'rock';
    if (biome === 3) return 'rock';
    if (biome === 2) return 'soil';
    return 'grass';
  }

  waterAt(x: number, z: number): WaterQuery | undefined { return this.water?.(x, z); }

  /** One composite sample for systems that need several answers at once. */
  sampleAt(x: number, z: number): WorldSample {
    const height = this.terrain.heightAt(x, z);
    const road = this.roadAt(x, z);
    const water = this.water?.(x, z);
    const result: WorldSample = { biome: this.biomeAt(x, z), surface: this.surfaceAt(x, z) };
    if (height !== undefined) result.height = height;
    const normal = this.normalAt(x, z);
    if (normal) result.normal = normal;
    const slope = this.slopeAt(x, z);
    if (slope !== undefined) result.slope = slope;
    if (road) result.road = road;
    if (water) result.water = water;
    return result;
  }
}
