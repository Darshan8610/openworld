import { describe, expect, it } from 'vitest';
import { BUILDING_TEMPLATES, BuildingTemplateRegistry } from '../src/world/buildings/templates';
import { BuildingPlacementField } from '../src/world/buildings/placement';
import { buildingToWorld, worldToBuilding } from '../src/world/buildings/coordinates';
import { createBuildingSiteParts } from '../src/world/buildings/site-parts';
import { createBuildingGraph, findBuildingPath } from '../src/world/buildings/navigation';
import { BUILDING_SETTINGS } from '../src/world/buildings/settings';
import { RoadNetwork } from '../src/world/road-network';
import { TerrainField } from '../src/world/terrain-field';
import { generateVegetation, PLANT_STRIDE } from '../src/world/vegetation-field';
import { makeTile } from '../src/world/tiles';

function flat(seed = 'architecture'): BuildingPlacementField { return new BuildingPlacementField(seed, { height: () => 100, roads: new RoadNetwork(seed, () => 100) }); }

describe('Phase 7 modular content', () => {
  it('registers three actual enterable templates with furniture and apertures', () => {
    expect(BUILDING_TEMPLATES.all.map((t) => t.id)).toEqual(['cabin', 'workshop', 'lodge']);
    for (const template of BUILDING_TEMPLATES.all) {
      expect(template.parts.length).toBeGreaterThan(50);
      expect(template.rooms.length).toBeGreaterThanOrEqual(2);
      expect(template.doors.some((d) => d.rooms[0] === null)).toBe(true);
      expect(template.parts.some((p) => p.stage === 'interior' && p.solid)).toBe(true);
      expect(template.parts.some((p) => p.material === 'glass' && p.solid)).toBe(true);
      expect(template.parts.some((p) => p.material === 'light')).toBe(true);
      const front = template.parts.filter((p) => p.id.startsWith('front-0:'));
      expect(front.some((p) => Math.abs(p.center.x) < 0.7 && p.center.y < 2.4)).toBe(false);
    }
  });
  it('rejects duplicate templates, invalid dimensions, non-finite parts and dangling graph edges', () => {
    const template = BUILDING_TEMPLATES.get('cabin');
    expect(() => new BuildingTemplateRegistry([template, template])).toThrow(/duplicate/);
    expect(() => new BuildingTemplateRegistry([{ ...template, width: NaN }])).toThrow(/dimensions/);
    expect(() => new BuildingTemplateRegistry([{ ...template, parts: [{ ...template.parts[0]!, size: { x: 0, y: 1, z: 1 } }] }])).toThrow(/part/);
    expect(() => new BuildingTemplateRegistry([{ ...template, edges: [{ from: 'missing', to: 'hall', kind: 'walk' }] }])).toThrow(/navigation/);
  });
  it('has a real upper-floor stair opening and a continuous seventeen-step flight', () => {
    const template = BUILDING_TEMPLATES.get('lodge');
    const steps = template.parts.filter((p) => /^stair-\d+$/.test(p.id));
    expect(steps.length).toBe(17);
    steps.forEach((step, index) => expect(step.center.y + step.size.y / 2).toBeCloseTo((index + 1) * 0.2));
    const floor = template.parts.filter((p) => p.id.startsWith('upper-'));
    expect(floor.some((p) => Math.abs(5.4 - p.center.x) < p.size.x / 2 && Math.abs(3 - p.center.z) < p.size.z / 2)).toBe(false);
  });
});

describe('canonical building placement', () => {
  it('is deterministic across independent instances, query order and negative coordinates', () => {
    const a = flat(), b = flat();
    const first = a.nearby(0, 0, 1800);
    b.nearby(-6000, 4000, 1800);
    expect(first).toEqual(b.nearby(0, 0, 1800));
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
    for (const item of flat().nearby(-3000, -4000, 1600)) expect(flat().getById(item.id)).toEqual(item);
  });
  it('bounds the placement cache, including rejected sites, independently of travel', () => {
    const field = flat();
    const first = field.nearby(0, 0, 1000)[0]!;
    for (let i = 0; i < 400; i++) field.get(i % 3, i * 2, 1);
    expect(field.stats.cachedSites).toBeLessThanOrEqual(BUILDING_SETTINGS.siteCache);
    expect(field.getById(first.id)).toEqual(first);
    expect(field.getById(first.id.replace('b1:', 'b2:'))).toBeUndefined();
    expect(flat('another').getById(first.id)).toBeUndefined();
  });
  it('rejects impossible slopes and road-overlapping authored sites', () => {
    const roads = new RoadNetwork('slopes', () => 0);
    const steep = new BuildingPlacementField('slopes', { height: (x) => x * 2, roads });
    expect(steep.nearby(0, 0, 1200)).toEqual([]);
    const field = flat(); const road = new RoadNetwork('architecture', () => 100).point(0, 20);
    expect(() => field.registerAuthored({ id: 'on-road', template: 'cabin', x: road.x, z: road.z, yaw: 0 })).toThrow(/road/);
  });
  it('accepts authored sites, rejects overlap and reserves their entrance', () => {
    const field = flat();
    const building = field.registerAuthored({ id: 'manual', template: 'cabin', x: 1000, z: 700, yaw: 0.3 });
    expect(building.position.y).toBeCloseTo(100.14);
    expect(field.getById('authored:manual')).toBe(building);
    const entrance = buildingToWorld(building, BUILDING_TEMPLATES.get('cabin').entrance);
    expect(field.reserved(entrance.x, entrance.z)).toBe(true);
    expect(() => field.registerAuthored({ id: 'overlap', template: 'workshop', x: 1001, z: 700, yaw: 0 })).toThrow(/overlap/);
    expect(() => field.registerAuthored({ id: 'buried', template: 'cabin', x: 1200, z: 700, y: 90, yaw: 0 })).toThrow(/foundation/);
    expect(() => field.registerAuthored({ id: 'unreachable', template: 'cabin', x: 1200, z: 700, y: 104.1, yaw: 0 })).toThrow(/foundation/);
  });
  it('keeps double-precision transforms and stable site identity at large coordinates', () => {
    const building = flat().nearby(-640000000, 1024000000, 2200)[0]!;
    expect(building).toBeDefined();
    const point = { x: 1.234, y: 1.7, z: -3.456 };
    const roundtrip = worldToBuilding(building, buildingToWorld(building, point));
    expect(roundtrip.x).toBeCloseTo(point.x, 6); expect(roundtrip.z).toBeCloseTo(point.z, 6);
    expect(roundtrip.y).toBeCloseTo(point.y, 10);
    const foundation = createBuildingSiteParts(building)[0]!;
    expect(building.position.y + foundation.center.y - foundation.size.y / 2).toBeCloseTo(building.foundationBottom);
  });
  it('finds real safe lots in the existing seeded landscape without altering terrain', () => {
    const field = new TerrainField('playwright');
    const before = field.height(120, 40);
    const site = field.buildings.nearest({ x: 0, y: 0, z: 0 });
    expect(site).toBeDefined();
    expect(field.height(120, 40)).toBe(before);
    const point = site!.position;
    const coord = makeTile(Math.floor(point.x / 128), Math.floor(point.z / 128), 5);
    const plants = generateVegetation(coord, field.seed, field);
    for (let i = 0; i < plants.length; i += PLANT_STRIDE) {
      const x = coord.x * 128 + plants[i]!, z = coord.z * 128 + plants[i + 2]!;
      expect(field.buildings.containsLot(site!, x, z, 3)).toBe(false);
    }
  });
});

describe('interior navigation portals', () => {
  it('gates room connections on actual door clearance and exposes a stair route', () => {
    const building = flat().nearby(0, 0, 1000)[0]!;
    const lodge = { ...building, template: 'lodge' };
    const closed = createBuildingGraph(lodge, BUILDING_TEMPLATES.get('lodge'), () => false);
    expect(findBuildingPath(closed, 'outside', 'loft')).toBeUndefined();
    const open = createBuildingGraph(lodge, BUILDING_TEMPLATES.get('lodge'), () => true);
    const path = findBuildingPath(open, 'outside', 'loft');
    expect(path).toContain('step-0'); expect(path).toContain('step-16'); expect(path).toContain('landing');
    expect(findBuildingPath(open, 'unknown', 'hall')).toBeUndefined();
    expect(open.nodes[0]!.position).toEqual(buildingToWorld(lodge, BUILDING_TEMPLATES.get('lodge').nodes[0]!.position));
  });
});

it('rejects a road through the middle of a large authored footprint even when corners are clear', () => {
  BUILDING_TEMPLATES.register({ ...BUILDING_TEMPLATES.get('cabin'), id: 'long-placement-fixture', depth: 180 });
  const field = flat(), road = new RoadNetwork('architecture', () => 100).point(0, 20);
  expect(() => field.registerAuthored({ id: 'straddles', template: 'long-placement-fixture', x: road.x, z: road.z + 50, yaw: 0 })).toThrow(/road/);
});
