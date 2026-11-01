import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { BuildingManager } from '../src/world/buildings/manager';
import { BuildingPlacementField } from '../src/world/buildings/placement';
import { RoadNetwork } from '../src/world/road-network';
import { buildingToWorld } from '../src/world/buildings/coordinates';
import { doorCollider } from '../src/world/buildings/collision';
import { BUILDING_TEMPLATES } from '../src/world/buildings/templates';
import { BUILDING_QUALITY } from '../src/world/buildings/settings';
import type { BuildingCollider, BuildingEvent, BuildingInteraction } from '../src/world/buildings/types';

function setup(template = 'lodge') {
  const sites = new BuildingPlacementField('integration', { height: () => 100, roads: new RoadNetwork('integration', () => 100) });
  const site = sites.registerAuthored({ id: 'main', template, x: 1000, z: 700, yaw: 0.2 });
  const events: BuildingEvent[] = [], colliders = new Map<string, BuildingCollider>(), bindings = new Map<string, BuildingInteraction>(), graphs = new Set<string>();
  const invalidations = { count: 0 };
  const origin = new FloatingOrigin(), terrain = { heightAt: () => 100 as number | undefined, revision: 0 };
  const manager = new BuildingManager({ seed: 'integration', quality: 'low', origin, terrain, sites, onReservationsChanged: () => { invalidations.count++; }, ports: {
    events: (e) => events.push(e),
    physics: { upsertCollider: (c) => colliders.set(c.id, c), removeCollider: (id) => { colliders.delete(id); } },
    interactions: { register: (binding) => { bindings.set(binding.id, binding); return () => { bindings.delete(binding.id); }; } },
    navigation: { setBuildingGraph: (g) => { graphs.add(g.buildingId); }, removeBuildingGraph: (id) => { graphs.delete(id); } },
  } });
  const unsubscribe = origin.onChange(() => manager.rebase());
  const observer = buildingToWorld(site, { x: 0, y: 1.65, z: 9.7 });
  const update = (position = observer) => manager.update(position, 0.5, 12, true);
  const dispose = () => { unsubscribe(); manager.dispose(); };
  return { sites, site, events, colliders, bindings, graphs, origin, terrain, manager, observer, invalidations, update, dispose };
}

describe('integrated building lifecycle', () => {
  it('streams a furnished interior with the same exact collision representation sent to the physics port', () => {
    const f = setup(); f.update();
    const state = f.manager.snapshot();
    expect(state.shells).toBeGreaterThan(0); expect(state.interiors).toBe(1);
    expect(state.colliders).toBeGreaterThan(100); expect(f.colliders.size).toBe(state.colliders);
    expect(f.bindings.has('authored:main/door/entrance')).toBe(true);
    expect(state.lights).toBe(1); expect(f.graphs.has('authored:main')).toBe(true);
    f.manager.registerAuthored({ id: 'runtime', template: 'cabin', x: 1200, z: 700, yaw: 0 });
    expect(f.invalidations.count).toBe(1);
    expect(f.manager.field.isAuthoredReserved(1200, 700)).toBe(true);
    f.dispose(); expect(f.colliders.size).toBe(0); expect(f.bindings.size).toBe(0); expect(f.graphs.size).toBe(0);
  });
  it('waits for real terrain availability and refreshes when a stationary observer receives streamed terrain', () => {
    const f = setup(); f.terrain.heightAt = () => undefined;
    f.update(); expect(f.manager.stats.shells).toBe(0);
    f.terrain.heightAt = () => 100; f.terrain.revision++;
    f.manager.update(f.observer, 0.1, 12);
    expect(f.manager.stats.shells).toBeGreaterThan(0); f.dispose();
  });
  it('holds near interiors with hysteresis then unloads furniture and their collision', () => {
    const f = setup(); f.update(); const count = f.manager.stats.colliders;
    f.update({ x: f.site.position.x, y: 102, z: f.site.position.z + 35 });
    expect(f.manager.stats.interiors).toBe(1);
    f.update({ x: f.site.position.x, y: 102, z: f.site.position.z + 60 });
    expect(f.manager.stats.interiors).toBe(0); expect(f.manager.stats.colliders).toBeLessThan(count);
    f.update({ x: f.site.position.x, y: 102, z: f.site.position.z + 150 });
    expect([...f.colliders.values()].filter((c) => c.buildingId === f.site.id)).toHaveLength(0);
    f.dispose();
  });
  it('keeps room transitions and navigation in canonical coordinates across repeated origin shifts', () => {
    const f = setup(); const inside = buildingToWorld(f.site, { x: 0, y: 1.65, z: 3 }); f.update(inside);
    const original = f.manager.snapshot().buildings.find((b) => b.id === f.site.id)!;
    const shapes = [...f.colliders.values()].filter((c) => c.buildingId === f.site.id).map((c) => ({ ...c, center: { ...c.center } }));
    for (let i = 1; i < 20; i++) f.origin.update(new Vector3(i * 3000, 100, -i * 4000));
    const after = f.manager.snapshot().buildings.find((b) => b.id === f.site.id)!;
    expect(after.position).toEqual(original.position); expect(after.doors).toEqual(original.doors);
    expect([...f.colliders.values()].filter((c) => c.buildingId === f.site.id)).toEqual(shapes);
    const root = f.manager.group.children.find((c) => c.name === `building ${f.site.id}`)!;
    expect(root.position.x + f.origin.x).toBe(f.site.position.x);
    f.update(inside);
    expect(f.events.filter((e) => e.type === 'PlayerEnteredBuilding')).toHaveLength(1);
    f.dispose();
  });
  it('interacts through standard bindings, animates at fixed time and updates navigation only when passable', () => {
    const f = setup(); f.update();
    const binding = f.bindings.get('authored:main/door/entrance')!;
    expect(binding.interact({ x: 0, y: 0, z: 0 })).toBe(false);
    expect(binding.interact(f.observer)).toBe(true);
    expect(binding.interact(f.observer)).toBe(false);
    expect(f.manager.graph(f.site.id)!.edges.find((e) => e.door === 'entrance')!.blocked).toBe(true);
    for (let i = 0; i < 140; i++) f.manager.fixedUpdate(1 / 120, f.observer);
    const door = f.manager.snapshot().buildings.find((b) => b.id === f.site.id)!.doors[0]!;
    expect(door.open).toBe(true); expect(door.angle).toBeCloseTo(BUILDING_TEMPLATES.get('lodge').doors[0]!.openAngle);
    expect(f.manager.graph(f.site.id)!.edges.find((e) => e.door === 'entrance')!.blocked).toBe(false);
    f.dispose();
  });
  it('opens away from an observer already touching the closed door', () => {
    const f = setup(); f.update();
    const actor = buildingToWorld(f.site, { x: 0, y: 1.65, z: 7.285 });
    expect(f.bindings.get('authored:main/door/entrance')!.interact(actor)).toBe(true);
    for (let i = 0; i < 160; i++) f.manager.fixedUpdate(1 / 120, actor);
    expect(f.manager.snapshot().buildings.find((b) => b.id === f.site.id)!.doors[0]!.angle).toBeGreaterThan(1.5);
    f.dispose();
  });
  it('reopens a closing door when the observer occupies its swept leaf', () => {
    const f = setup(); f.update(); const binding = f.bindings.get('authored:main/door/entrance')!;
    binding.interact(f.observer);
    for (let i = 0; i < 150; i++) f.manager.fixedUpdate(1 / 120, f.observer);
    expect(binding.interact(f.observer)).toBe(true);
    const hinge = BUILDING_TEMPLATES.get('lodge').doors[0]!.hinge;
    const occupied = buildingToWorld(f.site, { x: hinge.x + 0.3, y: 1.4, z: hinge.z - 0.5 });
    for (let i = 0; i < 150; i++) f.manager.fixedUpdate(1 / 120, occupied);
    expect(f.events.some((e) => e.type === 'BuildingDoorBlocked')).toBe(true);
    expect(f.manager.snapshot().buildings.find((b) => b.id === f.site.id)!.doors[0]!.open).toBe(true);
    f.dispose();
  });
  it('enforces quality limits over long travel and completely cleans adapters on seed reset', () => {
    const f = setup();
    for (let i = 0; i < 40; i++) {
      f.update({ x: i * 2000, y: 102, z: 100 });
      expect(f.manager.stats.shells).toBeLessThanOrEqual(BUILDING_QUALITY.low.shells);
      expect(f.manager.stats.interiors).toBeLessThanOrEqual(BUILDING_QUALITY.low.interiors);
      expect(f.manager.stats.cachedSites).toBeLessThanOrEqual(256);
      expect(f.manager.stats.sharedGeometryBatches).toBeLessThan(65);
    }
    f.manager.reset('new-seed');
    expect(f.colliders.size).toBe(0); expect(f.bindings.size).toBe(0); expect(f.manager.stats.shells).toBe(0);
    f.dispose(); f.dispose();
  });
  it('shares merged geometry between instances and disposes owned foundation buffers', () => {
    const f = setup(); f.update();
    const root = f.manager.group.children.find((c) => c.name === `building ${f.site.id}`)!;
    expect(root.children.length).toBeLessThan(30);
    let disposals = 0;
    root.traverse((object) => { const geometry = (object as import('three/webgpu').Mesh).geometry; geometry?.addEventListener('dispose', () => disposals++); });
    f.dispose(); expect(disposals).toBeGreaterThan(0);
  });
  it('targets rotated closed leaves correctly and opens negative-swing navigation portals', () => {
    const base = BUILDING_TEMPLATES.get('lodge');
    const definition = { ...base.doors[0]!, yaw: Math.PI / 2, openAngle: -1.65 };
    // A mechanics-only test fixture, never registered in production content.
    BUILDING_TEMPLATES.register({ ...base, id: 'door-mechanics-fixture', parts: [], doors: [definition], edges: base.edges.filter((edge) => !edge.door || edge.door === 'entrance') });
    const f = setup('door-mechanics-fixture'); f.update();
    const binding = f.bindings.get('authored:main/door/entrance')!;
    expect(binding.position).toEqual(doorCollider(f.site, definition, 0).center);
    const actor = buildingToWorld(f.site, { x: definition.hinge.x + 2, y: 1.65, z: definition.hinge.z - definition.width / 2 });
    expect(binding.interact(actor)).toBe(true);
    for (let i = 0; i < 160; i++) f.manager.fixedUpdate(1 / 120, actor);
    expect(f.manager.snapshot().buildings.find((b) => b.id === f.site.id)!.doors[0]!.angle).toBeLessThan(-1.5);
    expect(f.manager.graph(f.site.id)!.edges.find((edge) => edge.door === 'entrance')!.blocked).toBe(false);
    f.dispose();
  });

});
