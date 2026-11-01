import { describe, it, expect } from 'vitest';
import { TerrainField } from '../src/world/terrain-field';
import { vehicleWaterProvider } from '../src/vehicles/water-adapter';

const terrain = new TerrainField('hydrology-seed');
function findPoint(wet: boolean) {
  for (let i = 0; i < 4000; i++) {
    const x = (i % 80) * 140 - 5600, z = Math.floor(i / 80) * 140 - 5600;
    if (!!terrain.water.sampleAt(x, z) === wet) return { x, z };
  }
  throw new Error(`No ${wet ? 'wet' : 'dry'} fixture`);
}
describe('Phase 9 → Phase 10 water bridge', () => {
  it('does not invent water on dry ground', () => {
    const p = findPoint(false);
    expect(vehicleWaterProvider(terrain.water, () => 0)(p.x, p.z)).toBeUndefined();
  });
  it('shares displaced elevation, currents and normalized slope with hydrology', () => {
    const p = findPoint(true), t = 12.5;
    const sample = terrain.water.sampleAt(p.x, p.z)!;
    const result = vehicleWaterProvider(terrain.water, () => t)(p.x, p.z)!;
    expect(result.surfaceY).toBe(terrain.water.displacedSurface(p.x, p.z, t));
    expect(result.flowX).toBe(sample.flowX);
    expect(result.flowZ).toBe(sample.flowZ);
    expect(Math.hypot(result.nx, result.ny, result.nz)).toBeCloseTo(1, 10);
    expect(result.depth).toBeCloseTo(sample.depth + result.surfaceY - sample.surfaceY, 10);
  });
  it('reads the live clock, not a captured timestamp', () => {
    const p = findPoint(true); let t = 0;
    const provider = vehicleWaterProvider(terrain.water, () => t);
    for (const time of [0, 2, 70]) {
      t = time;
      expect(provider(p.x, p.z)!.surfaceY).toBe(terrain.water.displacedSurface(p.x, p.z, t));
    }
  });
});
