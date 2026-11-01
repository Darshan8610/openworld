import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../src/story/campaign';
import { CampaignBounds } from '../src/story/bounds';

describe('campaign bounds (walls, clamp, camera solids)', () => {
  it('builds four barrier walls with matching camera-solid meshes', () => {
    const bounds = new CampaignBounds();
    // Four edges, segmented into cheap wall meshes plus gate/tunnel dressing.
    expect(bounds.group.children.length).toBeGreaterThanOrEqual(16);
    expect(bounds.group.children.length).toBeLessThanOrEqual(64);
    bounds.dispose();
    expect(bounds.group.children.length).toBe(0);
  });

  it('clamps anything past the zone edge back inside', () => {
    const bounds = new CampaignBounds();
    const { minX, maxX, minZ, maxZ } = CAMPAIGN.bounds;
    const cases = [
      { x: minX - 50, z: 0 }, { x: maxX + 50, z: 0 },
      { x: 0, z: minZ - 1 }, { x: 0, z: maxZ + 900 },
      { x: maxX + 1, z: maxZ + 1 },
    ];
    for (const point of cases) {
      const out = bounds.clamp(point);
      expect(out.x).toBeGreaterThanOrEqual(minX);
      expect(out.x).toBeLessThanOrEqual(maxX);
      expect(out.z).toBeGreaterThanOrEqual(minZ);
      expect(out.z).toBeLessThanOrEqual(maxZ);
    }
    const inside = { x: -100, z: -100 };
    expect(bounds.clamp(inside)).toEqual(inside);
    bounds.dispose();
  });

  it('blocks wall cells for the character and leaves the interior open', () => {
    const bounds = new CampaignBounds();
    const { minX, maxX, minZ, maxZ } = CAMPAIGN.bounds;
    // Mid-edge cells on every barrier: north rock wall, east ravine,
    // west fence, south coast (boxes have tops above foot height).
    expect(bounds.blockedAt(0, minZ + 1, 0)).toBe(true);
    expect(bounds.blockedAt(maxX - 1, 0, 0)).toBe(true);
    expect(bounds.blockedAt(minX + 1, 0, 0)).toBe(true);
    expect(bounds.blockedAt(0, maxZ - 1, 0)).toBe(true);
    // The valley interior is walkable.
    expect(bounds.blockedAt(0, 0, 0)).toBe(false);
    expect(bounds.blockedAt(CAMPAIGN.arrival.x, CAMPAIGN.arrival.z, 0)).toBe(false);
    // Unknown feet height (camera-style query) treats barriers as blocking.
    expect(bounds.blockedAt(0, minZ + 1)).toBe(true);
    bounds.dispose();
  });

  it('uses the surface sampler when one is set (no hardcoded ground)', () => {
    const bounds = new CampaignBounds();
    let calls = 0;
    bounds.setSurfaceSampler(() => { calls++; return 42; });
    bounds.clamp({ x: -5000, z: 0 });
    expect(calls).toBeGreaterThan(0);
    bounds.dispose();
  });
});
