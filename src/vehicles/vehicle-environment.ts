import { CONFIG } from '../config';
import { airDensityAt } from './controllers/controller';
import { NO_VEHICLE_WATER } from './types';
import type { VehicleEnvironment, VehicleGroundSample, VehicleWaterProvider, VehicleWaterSample } from './types';
import type { WorldQueries } from '../world/world-queries';

/**
 * Adapts the world services into the narrow `VehicleEnvironment` seam the
 * controllers consume.
 *
 * Terrain comes from `WorldQueries`, which is analytic and unbounded — unlike
 * the streamed Rapier heightfields, it still answers correctly 2 km ahead of
 * the player, which a 90 m/s aircraft reaches in twenty seconds.
 *
 * Water is a *provider* rather than a hard dependency because the water and
 * weather systems are Phase 9 work owned elsewhere. Until one is installed the
 * null provider reports no water anywhere, and boats simply rest on the
 * terrain instead of crashing or pretending to float.
 */
export class WorldVehicleEnvironment implements VehicleEnvironment {
  readonly gravity: number;
  readonly wind = { x: 0, y: 0, z: 0 };
  readonly airDensity = airDensityAt;
  private waterProvider: VehicleWaterProvider;

  constructor(private readonly queries: WorldQueries, waterProvider: VehicleWaterProvider = NO_VEHICLE_WATER) {
    this.gravity = CONFIG.physics.gravity;
    this.waterProvider = waterProvider;
  }

  /** Install the Phase 9 water system once it exists, without touching physics. */
  setWaterProvider(provider: VehicleWaterProvider | undefined): void {
    this.waterProvider = provider ?? NO_VEHICLE_WATER;
  }

  /** Install a weather-driven wind vector; defaults to still air. */
  setWind(x: number, y: number, z: number): void {
    this.wind.x = Number.isFinite(x) ? x : 0;
    this.wind.y = Number.isFinite(y) ? y : 0;
    this.wind.z = Number.isFinite(z) ? z : 0;
  }

  ground(x: number, z: number, out: VehicleGroundSample): VehicleGroundSample {
    // `groundFast` carries a short-range cache, which matters because every
    // wheel raycasts several times per fixed step.
    const sample = this.queries.groundFast(x, z);
    out.height = sample.height;
    out.nx = sample.nx;
    out.ny = sample.ny;
    out.nz = sample.nz;
    out.surface = sample.surface;
    return out;
  }

  water(x: number, z: number): VehicleWaterSample | undefined {
    return this.waterProvider(x, z);
  }
}
