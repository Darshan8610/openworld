import { describe, expect, it } from 'vitest';
import { findBiomeViewpoint } from '../src/world/viewpoints';
import { TerrainField } from '../src/world/terrain-field';

describe('seed-local biome overlooks', () => {
  it('are deterministic and return finite, climate-appropriate coordinates', () => {
    const a = findBiomeViewpoint('overlook', 1, 0, 0, 4800);
    const b = findBiomeViewpoint('overlook', 1, 0, 0, 4800);
    expect(a).toEqual(b);
    expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)).toBe(true);
    expect(Math.hypot(a.x, a.z)).toBeLessThanOrEqual(4800 + 1e-6);
    const field = new TerrainField('overlook');
    const climate = field.sample(a.x, a.z, a.y, 0.1);
    expect(climate.weights[1]).toBeGreaterThan(0.2);
  });
});
