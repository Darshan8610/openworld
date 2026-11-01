import { describe, expect, it } from 'vitest';
import { TerrainField } from '../src/world/terrain-field';
import { RoadNetwork, createRoadSample } from '../src/world/road-network';
import { generateRoadTile, PROP_KINDS, PROP_STRIDE } from '../src/world/road-geometry';
import { generateTile } from '../src/world/terrain-generator';
import { makeTile, tileSize } from '../src/world/tiles';
import { PLANT_STRIDE, readPlant } from '../src/world/vegetation-field';
import type { PlantPlacement } from '../src/world/vegetation-field';
import type { TileRequest } from '../src/world/tiles';

const field = new TerrainField('roads');
const station = -900, corridor = 0;
const point = field.roads.point(corridor, station);
const coord = makeTile(Math.floor(point.x / 128), Math.floor(point.z / 128), 5);
const request: TileRequest = { type: 'generate', id: 1, epoch: 0, seed: 'roads', segments: 12, ...coord };
const blank: PlantPlacement = { x: 0, y: 0, z: 0, scale: 1, yaw: 0, kind: 0, brightness: 1, random: 0 };

describe('Phase 3 road network', () => {
  it('is deterministic, origin-independent and cache-stable', () => {
    const a = new RoadNetwork('roads', (x, z) => field.naturalHeight(x, z));
    const b = new RoadNetwork('roads', (x, z) => field.naturalHeight(x, z));
    expect(a.center(0, 123.4)).toBe(b.center(0, 123.4));
    const before = a.profile(0, station + 0.25);
    for (let i = 0; i < 10000; i++) a.profile(3, i * 64);
    expect(a.profile(0, station + 0.25)).toBe(before);
    const sample = createRoadSample();
    a.sample(point.x + 6000, point.z + 6000, sample);
    expect(Number.isFinite(sample.lateral)).toBe(true);
  });
  it('grades a continuous formation into the natural height field', () => {
    const work = { ...createRoadSample(), height: 0, weight: 0 };
    field.roads.earthwork(point.x, point.z, work);
    expect(work.weight).toBe(1);
    expect(field.height(point.x, point.z)).toBeCloseTo(field.roads.profile(corridor, station), 3);
    field.roads.earthwork(point.x, point.z + 600, work);
    expect(work.weight).toBe(0);
    const h0 = field.roads.profile(corridor, station), h1 = field.roads.profile(corridor, station + 0.01);
    expect(Math.abs(h1 - h0)).toBeLessThan(0.1);
  });
  it('builds deterministic draped asphalt, shoulders and painted markings', () => {
    const a = generateRoadTile(coord, field.roads, (x, z) => field.height(x, z));
    const b = generateRoadTile(coord, field.roads, (x, z) => field.height(x, z));
    expect(a.positions).toEqual(b.positions);
    expect(a.indices).toEqual(b.indices);
    expect(a.positions.length).toBeGreaterThan(0);
    expect(a.positions.every(Number.isFinite)).toBe(true);
    expect(a.normals.length).toBe(a.positions.length);
    const kinds = new Set(Array.from(a.surface));
    expect(kinds.has(0)).toBe(true); expect(kinds.has(1)).toBe(true); expect(kinds.has(2)).toBe(true);
    const size = tileSize(5);
    for (let i = 0; i < a.positions.length; i += 3) {
      expect(a.positions[i]!).toBeGreaterThanOrEqual(-40); expect(a.positions[i]!).toBeLessThanOrEqual(size + 40);
      // Centreline ownership is half-open; widened pullout shoulders may cross the tile edge.
      expect(a.positions[i + 2]!).toBeGreaterThanOrEqual(-24); expect(a.positions[i + 2]!).toBeLessThanOrEqual(size + 24);
    }
  });
  it('keeps vegetation out of the carriageway, shoulders and pullouts', () => {
    const tile = generateTile(request, field);
    expect(tile.road.positions.length).toBeGreaterThan(0);
    const size = tileSize(5), left = coord.x * size, top = coord.z * size;
    const sample = createRoadSample();
    for (let i = 0; i < tile.vegetation.length / PLANT_STRIDE; i++) {
      const p = readPlant(tile.vegetation, i, blank);
      const x = left + p.x, z = top + p.z;
      field.roads.sample(x, z, sample);
      const clearance = (p.kind >= 4 && p.kind !== 7 && p.kind !== 8 ? 24 : 10) + sample.pullout * 12;
      expect(Math.abs(sample.lateral)).toBeGreaterThanOrEqual(clearance - 0.01);
    }
  });
  it('packs canonical roadside props into bounded species and transfers road buffers', () => {
    const tile = generateTile(request, field);
    const data = tile.road.props;
    expect(data.length % PROP_STRIDE).toBe(0);
    const size = tileSize(5);
    for (let i = 0; i < data.length / PROP_STRIDE; i++) {
      const o = i * PROP_STRIDE;
      expect(data[o]!).toBeGreaterThanOrEqual(0); expect(data[o]!).toBeLessThan(size);
      expect(data[o + 2]!).toBeGreaterThanOrEqual(0); expect(data[o + 2]!).toBeLessThan(size);
      expect(data[o + 4]!).toBeGreaterThanOrEqual(0); expect(data[o + 4]!).toBeLessThan(PROP_KINDS.length);
    }
    expect(tile.road.positions.buffer).not.toBe(tile.positions.buffer);
    expect(tile.road.props.buffer).not.toBe(tile.vegetation.buffer);
    expect(tile.road.indices.buffer).not.toBe(tile.indices.buffer);
  });
});
