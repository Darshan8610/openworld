/**
 * Shared analytic test world for the Phase 10 vehicle suites.
 *
 * Vehicles take their terrain and water through narrow provider seams
 * (`VehicleEnvironment`), so the tests can drive them against an exact
 * closed-form world instead of booting the streaming terrain. That keeps the
 * physics assertions about physics rather than about world generation.
 */
import { Vehicle } from '../../src/vehicles/vehicle';
import { vehicleSpecOrThrow } from '../../src/vehicles/catalog';
import { airDensityAt } from '../../src/vehicles/controllers/controller';
import type { SurfaceKind } from '../../src/physics/surfaces';
import type { VehicleEnvironment, VehicleGroundSample, VehicleWaterSample } from '../../src/vehicles/types';

/** Matches `CONFIG.physics.fixedStep`; physics is never FPS-coupled. */
export const STEP = 1 / 120;

export interface EnvOptions {
  height?: number | ((x: number, z: number) => number);
  surface?: SurfaceKind;
  waterLevel?: number;
  wind?: { x: number; y: number; z: number };
  flow?: { x: number; z: number };
}

/** Flat or sloped ground, optional water plane, optional wind and current. */
export function makeEnv(options: EnvOptions = {}): VehicleEnvironment {
  const { height = 0, surface = 'asphalt', waterLevel, wind = { x: 0, y: 0, z: 0 }, flow } = options;
  const heightAt = typeof height === 'function' ? height : () => height;
  return {
    gravity: -9.81,
    ground(x: number, z: number, out: VehicleGroundSample): VehicleGroundSample {
      out.height = heightAt(x, z);
      // Central-difference normal so slopes produce a correct contact normal.
      const e = 0.5;
      const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
      const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const len = Math.hypot(dx, 1, dz);
      out.nx = -dx / len; out.ny = 1 / len; out.nz = -dz / len;
      out.surface = surface;
      return out;
    },
    water(x: number, z: number): VehicleWaterSample | undefined {
      if (waterLevel === undefined) return undefined;
      const bed = heightAt(x, z);
      if (bed >= waterLevel) return undefined;
      return {
        surfaceY: waterLevel, nx: 0, ny: 1, nz: 0,
        flowX: flow?.x ?? 0, flowZ: flow?.z ?? 0, depth: waterLevel - bed,
      };
    },
    airDensity: airDensityAt,
    wind,
  };
}

export function spawn(key: string, y = 0.9, yaw = 0): Vehicle {
  return new Vehicle(`test-${key}`, vehicleSpecOrThrow(key), { x: 0, y, z: 0 }, yaw);
}

export function simulate(vehicle: Vehicle, env: VehicleEnvironment, seconds: number): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) vehicle.fixedUpdate(STEP, env);
}

/** Launch a vehicle already trimmed for flight: airborne, at speed, level. */
export function launch(vehicle: Vehicle, altitude: number, speed: number): void {
  vehicle.body.place(0, altitude, 0, 0);
  vehicle.body.velocity.set(0, 0, speed);
  vehicle.body.wake();
}
