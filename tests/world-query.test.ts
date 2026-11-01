import { describe, expect, it } from 'vitest';
import { TerrainField } from '../src/world/terrain-field';
import { ROAD_GEOMETRY, WorldQuery } from '../src/world/world-query';
import type { TerrainSource, WaterProvider } from '../src/world/world-query';

const field = new TerrainField('query-seed');

/** Streamed-tile stand-in: computes the same authoritative field values. */
const terrain: TerrainSource = {
  heightAt: (x, z) => field.height(x, z),
  biomeAt: (x, z) => {
    const height = field.height(x, z);
    const dx = (field.height(x + 2, z) - field.height(x - 2, z)) / 4;
    const dz = (field.height(x, z + 2) - field.height(x, z - 2)) / 4;
    const slope = 1 - 1 / Math.hypot(dx, 1, dz);
    return field.sample(x, z, height, slope).dominant;
  },
};

const query = new WorldQuery(terrain, field.roads);
const station = 640, corridor = 0;
const centre = field.roads.point(corridor, station);

describe('unified world query', () => {
  it('reports height, normal, slope and biome from one authority', () => {
    const height = query.heightAt(centre.x, centre.z);
    expect(height).toBeCloseTo(field.height(centre.x, centre.z), 6);
    const normal = query.normalAt(centre.x, centre.z)!;
    expect(normal.length()).toBeCloseTo(1, 6);
    expect(normal.y).toBeGreaterThan(0);
    const slope = query.slopeAt(centre.x, centre.z)!;
    expect(slope).toBeGreaterThanOrEqual(0);
    expect(slope).toBeLessThan(1);
    expect(query.biomeAt(centre.x, centre.z)).toBeGreaterThanOrEqual(0);
    expect(query.biomeAt(centre.x, centre.z)).toBeLessThanOrEqual(4);
  });

  it('reports undefined outside the streamed window instead of inventing data', () => {
    const unstreamed = new WorldQuery({ heightAt: () => undefined, biomeAt: () => 0 });
    expect(unstreamed.heightAt(0, 0)).toBeUndefined();
    expect(unstreamed.normalAt(0, 0)).toBeUndefined();
    expect(unstreamed.slopeAt(0, 0)).toBeUndefined();
    expect(unstreamed.roadAt(0, 0)).toBeUndefined();
    expect(unstreamed.nearestRoadPoint(0, 0)).toBeUndefined();
    expect(unstreamed.waterAt(0, 0)).toBeUndefined();
  });

  it('classifies carriageway, shoulder and off-road surfaces', () => {
    const onCentre = query.roadAt(centre.x, centre.z)!;
    expect(onCentre.onCarriageway).toBe(true);
    expect(Math.abs(onCentre.lateral)).toBeLessThan(0.5);
    expect(query.surfaceAt(centre.x, centre.z)).toBe('asphalt');

    const shoulderPoint = field.roads.point(corridor, station, 6);
    const shoulder = query.roadAt(shoulderPoint.x, shoulderPoint.z)!;
    expect(shoulder.onCarriageway).toBe(false);
    expect(shoulder.onShoulder).toBe(true);
    expect(query.surfaceAt(shoulderPoint.x, shoulderPoint.z)).toBe('gravel');

    const offRoad = field.roads.point(corridor, station, ROAD_GEOMETRY.queryRange + 80);
    expect(query.roadAt(offRoad.x, offRoad.z)).toBeUndefined();
    expect(['grass', 'soil', 'rock', 'snow']).toContain(query.surfaceAt(offRoad.x, offRoad.z));
  });

  it('snaps to the nearest centreline point for navigation and resets', () => {
    const offsetPoint = field.roads.point(corridor, station, 9.5);
    const snapped = query.nearestRoadPoint(offsetPoint.x, offsetPoint.z)!;
    expect(snapped.corridor).toBe(corridor);
    expect(snapped.station).toBeCloseTo(station, 0);
    expect(Math.abs(snapped.lateral)).toBeGreaterThan(8);
    expect(Math.abs(snapped.lateral)).toBeLessThan(11);
    const expected = field.roads.point(corridor, snapped.station);
    expect(Math.hypot(snapped.x - expected.x, snapped.z - expected.z)).toBeLessThan(0.01);
  });

  it('exposes one composite sample for interaction and physics consumers', () => {
    const sample = query.sampleAt(centre.x, centre.z);
    expect(sample.height).toBeDefined();
    expect(sample.normal).toBeDefined();
    expect(sample.surface).toBe('asphalt');
    expect(sample.road?.name).toBeTruthy();
    expect(sample.road?.kilometre).toBeCloseTo(station / 1000, 3);
  });

  it('reserves water for Phase 9 without inventing a water body', () => {
    expect(query.waterAt(centre.x, centre.z)).toBeUndefined();
    expect(query.surfaceAt(centre.x, centre.z)).toBe('asphalt');
    const lake: WaterProvider = (x, z) => ({
      bodyId: 'test-lake', surfaceHeight: field.height(x, z) + 5, depth: 12, flowX: 0.2, flowZ: 0,
    });
    query.registerWater(lake);
    expect(query.waterAt(centre.x, centre.z)?.bodyId).toBe('test-lake');
    // Submerged terrain reports water; above the surface the road still wins.
    expect(query.surfaceAt(centre.x, centre.z)).toBe('water');
    query.registerWater(undefined);
    expect(query.surfaceAt(centre.x, centre.z)).toBe('asphalt');
  });
});
