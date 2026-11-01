import { Vector3 } from 'three/webgpu';
import { clamp } from '../utils/math';
import type { VehicleBody } from './vehicle-body';
import type { BuoyancyPoint, VehicleEnvironment, VehicleWaterSample } from './types';

/** Fresh water, kg/m³. */
export const WATER_DENSITY = 1000;

export interface BuoyancyResult {
  /** 0..1 fraction of the hull's displacement that is submerged. */
  submersion: number;
  /** Depth of the lowest sample below the surface, metres. */
  depth: number;
  /** True if any sample point is in water. */
  inWater: boolean;
  /** Mean water surface height across the submerged samples. */
  surfaceY: number;
}

export const blankBuoyancy = (): BuoyancyResult => ({ submersion: 0, depth: 0, inWater: false, surfaceY: 0 });

/**
 * Multi-point displacement buoyancy.
 *
 * Archimedes at a set of sample points rather than a single force at the centre
 * of mass. That is what makes a hull pitch when it crests a wave, heel when
 * weight shifts to one side, and right itself when it is pushed over: each
 * submerged point pushes up independently and the resulting torque is real.
 *
 * Phase 9 owns the water bodies. This solver reads whatever `env.water`
 * returns, so when real lakes, rivers and waves arrive the same code produces
 * wave-following boats with no changes here.
 */
export class BuoyancySolver {
  private readonly point = new Vector3();
  private readonly normal = new Vector3();
  private readonly velocity = new Vector3();
  private readonly force = new Vector3();
  readonly result: BuoyancyResult = blankBuoyancy();

  constructor(
    private readonly points: readonly BuoyancyPoint[],
    private readonly submersionDepth: number,
  ) {}

  /** Total displaced volume of the hull at full submersion, m³. */
  get volume(): number {
    let total = 0;
    for (const point of this.points) total += point.volume;
    return total;
  }

  /**
   * Apply buoyancy, heave damping and current drag. `extraForce` is an upward
   * bias in newtons used by the submarine's ballast system.
   */
  solve(body: VehicleBody, env: VehicleEnvironment, options: { heaveDamping: number; extraForce?: number } ): BuoyancyResult {
    const result = this.result;
    result.submersion = 0;
    result.depth = 0;
    result.inWater = false;
    result.surfaceY = 0;

    const total = this.volume;
    if (total <= 0 || this.points.length === 0) return result;

    let submergedVolume = 0;
    let surfaceSum = 0;
    let surfaceCount = 0;
    let deepest = 0;

    for (const sample of this.points) {
      body.localPoint(sample.local, this.point);
      const water: VehicleWaterSample | undefined = env.water(this.point.x, this.point.z);
      if (!water) continue;
      const depth = water.surfaceY - this.point.y;
      if (depth <= 0) continue;

      result.inWater = true;
      surfaceSum += water.surfaceY;
      surfaceCount++;
      deepest = Math.max(deepest, depth);

      const fraction = clamp(depth / Math.max(0.05, this.submersionDepth), 0, 1);
      const displaced = sample.volume * fraction;
      submergedVolume += displaced;

      this.normal.set(water.nx, water.ny, water.nz);
      if (this.normal.lengthSq() < 1e-6) this.normal.set(0, 1, 0);
      else this.normal.normalize();

      // Archimedes: ρ·g·V upward along the (possibly wave-tilted) surface normal.
      const magnitude = WATER_DENSITY * Math.abs(env.gravity) * displaced;
      this.force.copy(this.normal).multiplyScalar(magnitude);

      // Heave damping stops the hull oscillating forever on its own spring.
      body.pointVelocity(this.point, this.velocity);
      const along = this.velocity.dot(this.normal);
      this.force.addScaledVector(this.normal, -along * options.heaveDamping * fraction);

      // The current carries the hull with it.
      const flowX = water.flowX - this.velocity.x;
      const flowZ = water.flowZ - this.velocity.z;
      this.force.x += flowX * 120 * fraction;
      this.force.z += flowZ * 120 * fraction;

      body.addForceAtPoint(this.force, this.point);
    }

    if (options.extraForce && result.inWater) {
      body.addForce(0, options.extraForce, 0);
    }

    result.submersion = clamp(submergedVolume / total, 0, 1);
    result.depth = deepest;
    result.surfaceY = surfaceCount > 0 ? surfaceSum / surfaceCount : 0;
    return result;
  }
}
