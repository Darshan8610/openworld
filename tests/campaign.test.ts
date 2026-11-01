import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../src/world/road-network';
import { BuildingPlacementField } from '../src/world/buildings/placement';
import { CAMPAIGN, LANDMARKS, clampToBounds, withinBounds } from '../src/story/campaign';

/**
 * The campaign is authored against one fixed seed: this suite pins the exact
 * landmark coordinates, re-registers them on a fresh placement field and
 * asserts the invariants (clearances, span, zone size) that make the
 * 1 km² valley playable. If terrain regeneration ever shifts the contract,
 * these literals must be re-blessed — never silently adjusted.
 */
describe('Echoes of Blackwood Valley campaign layout', () => {
  const seed = CAMPAIGN.seed;

  function freshField() {
    const height = () => 100;
    return new BuildingPlacementField(seed, { height, roads: new RoadNetwork(seed, () => 100) });
  }

  it('pins the one seed the story is authored against', () => {
    expect(CAMPAIGN.seed).toBe('1k5om4l-ek66rv');
    expect(CAMPAIGN.initialHour).toBeCloseTo(19.5, 5);
    expect(CAMPAIGN.title).toBe('Echoes of Blackwood Valley');
  });

  it('registers the four authored landmarks at their exact coordinates', () => {
    const field = freshField();
    const expected = [
      { id: 'blackwood-diner', template: 'workshop', x: -441.30384339642796, z: -55.65113418110711 },
      { id: 'whispering-pines', template: 'lodge', x: -211.4256154497543, z: -220.17955079748296 },
      { id: 'forestry-station', template: 'cabin', x: 9.61108910658475, z: -30.024929148897485 },
      { id: 'radio-lookout', template: 'cabin', x: 176.32473270423412, z: -504.74385325050787 },
    ];
    expect(LANDMARKS).toHaveLength(4);
    for (const [index, want] of expected.entries()) {
      const landmark = LANDMARKS[index]!;
      expect(landmark.buildingId).toBe(want.id);
      expect(landmark.template).toBe(want.template);
      expect(landmark.x).toBe(want.x);
      expect(landmark.z).toBe(want.z);
      const site = field.registerAuthored({
        id: landmark.buildingId, template: landmark.template,
        x: landmark.x, z: landmark.z, yaw: 0,
      });
      expect(site.id).toBe(`authored:${want.id}`);
      expect(site.position.x).toBe(want.x);
      expect(site.position.z).toBe(want.z);
      // All sites sit within half a kilometre of each other (walkable acts).
      expect(Math.hypot(site.position.x, site.position.z)).toBeLessThan(700);
    }
  });

  it('keeps the landmark span and arrival inside the 1 km² bounds', () => {
    const [diner, motel, station, lookout] = LANDMARKS as [
      (typeof LANDMARKS)[0], (typeof LANDMARKS)[0], (typeof LANDMARKS)[0], (typeof LANDMARKS)[0],
    ];
    const { minX, maxX, minZ, maxZ } = CAMPAIGN.bounds;
    expect(maxX - minX).toBeCloseTo(1000, 6);
    expect(maxZ - minZ).toBeCloseTo(1000, 6);
    // Landmark clearances (metres) found by the placement search.
    expect(Math.hypot(motel.x - diner.x, motel.z - diner.z)).toBeGreaterThan(270); expect(Math.hypot(motel.x - diner.x, motel.z - diner.z)).toBeLessThan(300);
    expect(Math.hypot(station.x - motel.x, station.z - motel.z)).toBeGreaterThan(280); expect(Math.hypot(station.x - motel.x, station.z - motel.z)).toBeLessThan(305);
    expect(Math.hypot(lookout.x - station.x, lookout.z - station.z)).toBeGreaterThan(490); expect(Math.hypot(lookout.x - station.x, lookout.z - station.z)).toBeLessThan(520);
    for (const landmark of LANDMARKS) {
      expect(withinBounds(landmark.x, landmark.z, CAMPAIGN.bounds)).toBe(true);
      // 30 m clearance from every wall keeps doorways and drives reachable.
      expect(landmark.x).toBeGreaterThan(minX + 30);
      expect(landmark.x).toBeLessThan(maxX - 30);
      expect(landmark.z).toBeGreaterThan(minZ + 30);
      expect(landmark.z).toBeLessThan(maxZ - 30);
    }
    expect(withinBounds(CAMPAIGN.arrival.x, CAMPAIGN.arrival.z, CAMPAIGN.bounds)).toBe(true);
    // Arrival sits just off the diner with clear line of sight.
    expect(Math.hypot(CAMPAIGN.arrival.x - diner.x, CAMPAIGN.arrival.z - diner.z)).toBeLessThan(60);
  });

  it('clamps any point back into the zone', () => {
    const clamped = clampToBounds({ x: -5000, z: 5000 }, CAMPAIGN.bounds);
    expect(clamped.x).toBe(CAMPAIGN.bounds.minX);
    expect(clamped.z).toBe(CAMPAIGN.bounds.maxZ);
    const inside = { x: 10, z: -20 };
    expect(clampToBounds(inside, CAMPAIGN.bounds)).toEqual(inside);
  });
});
