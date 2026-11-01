import type { WaterField } from '../world/water-field';
import type { VehicleWaterProvider } from './types';

/** Bridges Phase 9's canonical wave surface into the Phase 10 controller seam. */
export function vehicleWaterProvider(field: WaterField, time: () => number): VehicleWaterProvider {
  return (x, z) => {
    const sample = field.sampleAt(x, z);
    if (!sample) return undefined;
    const t = time();
    const surfaceY = field.displacedSurface(x, z, t) ?? sample.surfaceY;
    const delta = 0.5;
    const dx = ((field.displacedSurface(x + delta, z, t) ?? surfaceY) - (field.displacedSurface(x - delta, z, t) ?? surfaceY)) / (2 * delta);
    const dz = ((field.displacedSurface(x, z + delta, t) ?? surfaceY) - (field.displacedSurface(x, z - delta, t) ?? surfaceY)) / (2 * delta);
    const length = Math.hypot(dx, 1, dz);
    return { surfaceY, nx: -dx / length, ny: 1 / length, nz: -dz / length,
      flowX: sample.flowX, flowZ: sample.flowZ, depth: Math.max(0, sample.depth + surfaceY - sample.surfaceY) };
  };
}
