import { describe, expect, it } from 'vitest';
import { BuildingCollisionIndex, doorCollider, partCollider, sweepBox } from '../src/world/buildings/collision';
import { BUILDING_TEMPLATES } from '../src/world/buildings/templates';
import { buildingToWorld } from '../src/world/buildings/coordinates';
import type { BuildingCollider, BuildingDescriptor } from '../src/world/buildings/types';

const building: BuildingDescriptor = { id: 'authored:test', template: 'cabin', position: { x: 0, y: 100, z: 0 }, yaw: 0, seed: 'test', source: 'authored', foundationBottom: 98 };
const wall: BuildingCollider = { id: 'wall', buildingId: building.id, center: { x: 0, y: 1.5, z: 0 }, half: { x: 5, y: 1.5, z: 0.12 }, yaw: 0, material: 'plaster', kind: 'static', walkable: false };

describe('building collision data and canonical queries', () => {
  it('sweeps the whole segment so a fast inspection camera cannot tunnel through walls', () => {
    const index = new BuildingCollisionIndex(); index.upsert(wall);
    const from = { x: 0, y: 1.6, z: 100 }, to = { x: 0, y: 1.6, z: -100 };
    const hit = index.sweep(from, to, 0.25);
    expect(hit?.fraction).toBeGreaterThan(0); expect(hit?.fraction).toBeLessThan(0.5);
    expect(index.moveSphere(from, to, 0.25).z).toBeCloseTo(0.37, 1);
  });
  it('blocks inward movement from exact contact without preventing tangent motion or retreat', () => {
    const index = new BuildingCollisionIndex(); index.upsert(wall);
    const contact = { x: 0, y: 1.6, z: wall.half.z + 0.25 };
    expect(index.sweep(contact, { ...contact, z: 0 }, 0.25)?.fraction).toBe(0);
    expect(index.moveSphere(contact, { ...contact, z: -1 }, 0.25).z).toBeCloseTo(contact.z, 14);
    expect(index.moveSphere(contact, { ...contact, x: 2 }, 0.25).x).toBe(2);
    expect(index.moveSphere(contact, { ...contact, z: 1 }, 0.25).z).toBe(1);
    let position = contact;
    for (let i = 0; i < 240; i++) position = index.moveSphere(position, { ...position, z: position.z - 0.03 }, 0.25);
    expect(position.z).toBeCloseTo(contact.z, 14);
  });
  it('slides along a wall and allows movement away from an initial overlap', () => {
    const index = new BuildingCollisionIndex(); index.upsert(wall);
    const result = index.moveSphere({ x: -2, y: 1.6, z: 2 }, { x: 2, y: 1.6, z: -2 }, 0.25);
    expect(result.x).toBeGreaterThan(1.9); expect(result.z).toBeGreaterThan(0.36);
    expect(sweepBox({ x: 0, y: 1.6, z: 0.2 }, { x: 0, y: 1.6, z: 1 }, 0.25, wall)).toBeUndefined();
  });
  it('handles rotated shapes at far world coordinates without rebasing the canonical collider', () => {
    const box = { ...wall, center: { x: 100000000.25, y: 1.5, z: -100000000.5 }, yaw: Math.PI / 2 };
    const index = new BuildingCollisionIndex(); index.upsert(box);
    const hit = index.sweep({ x: box.center.x + 20, y: 1.6, z: box.center.z }, { x: box.center.x - 20, y: 1.6, z: box.center.z }, 0.25);
    expect(hit).toBeDefined(); expect(hit?.normal.x).toBeCloseTo(1);
    expect(index.values[0]!.center).toEqual(box.center);
  });
  it('blocks a closed entrance but permits the same passage after the leaf rotates', () => {
    const template = BUILDING_TEMPLATES.get('cabin'), door = template.doors[0]!;
    const index = new BuildingCollisionIndex();
    for (const part of template.parts) if (part.solid) index.upsert(partCollider(building, part));
    const from = { x: 0, y: 101.65, z: 7 }, to = { x: 0, y: 101.65, z: 3 };
    index.upsert(doorCollider(building, door, 0));
    expect(index.sweep(from, to, 0.24)?.collider.kind).toBe('kinematic');
    index.upsert(doorCollider(building, door, door.openAngle));
    expect(index.sweep(from, to, 0.24)).toBeUndefined();
  });
  it('finds explicit floor and stair support, not the top of a table or the upper ceiling', () => {
    const lodge = { ...building, template: 'lodge' };
    const index = new BuildingCollisionIndex();
    for (const part of BUILDING_TEMPLATES.get('lodge').parts) if (part.solid) index.upsert(partCollider(lodge, part));
    expect(index.supportHeight({ x: 0, y: 100.01, z: 3 })).toBeCloseTo(100);
    for (let i = 0; i < 17; i++) {
      const world = buildingToWorld(lodge, { x: 5.4, y: i * 0.2, z: 5.7 - i * 0.34 });
      expect(index.supportHeight(world)).toBeCloseTo(100 + (i + 1) * 0.2);
    }
    expect(index.supportHeight({ x: 0, y: 103.4, z: -2 })).toBeCloseTo(103.4);
  });
  it('supports capsule-sized host queries and complete building removal', () => {
    const index = new BuildingCollisionIndex(); index.upsert(wall);
    expect(index.sweep({ x: 0, y: 3.7, z: 2 }, { x: 0, y: 3.7, z: -2 }, 0.3, 0.9)).toBeDefined();
    index.removeBuilding(building.id); expect(index.size).toBe(0);
  });
});

describe('character-scale solid test (locomotion blocked())', () => {
  const wallAt = (yaw: number): BuildingCollider => ({ ...wall, yaw });
  it('blocks mid-body probes at walls but never walkable floors', () => {
    const index = new BuildingCollisionIndex();
    index.upsert(wall);
    // Chest height (feet+0.9) inside the wall slab → solid.
    expect(index.overlaps({ x: 0, y: 1.6, z: 0 }, 0.24)).toBe(true);
    // Just clear of the slab → open.
    expect(index.overlaps({ x: 0, y: 1.6, z: 0.6 }, 0.24)).toBe(false);
    // A walkable floor under the feet is a standing surface, not a wall.
    const floor: BuildingCollider = { id: 'floor', buildingId: building.id, center: { x: 0, y: 0.15, z: 3 }, half: { x: 4, y: 0.15, z: 2 }, yaw: 0, material: 'timber', kind: 'static', walkable: true };
    index.upsert(floor);
    expect(index.overlaps({ x: 0, y: 0.3, z: 3 }, 0.24)).toBe(false);
    expect(index.overlaps({ x: 0, y: 0.3, z: 3 }, 0.24, false)).toBe(true);
  });
  it('respects collider yaw and far canonical coordinates', () => {
    const index = new BuildingCollisionIndex();
    index.upsert(wallAt(Math.PI / 2));
    // Rotated 90°: the slab now spans Z, so an X-offset probe hits it.
    expect(index.overlaps({ x: 0.1, y: 1.6, z: 0 }, 0.24)).toBe(true);
    expect(index.overlaps({ x: 3, y: 1.6, z: 0 }, 0.24)).toBe(false);
    const far = { ...wall, center: { x: 1e8, y: 1.5, z: -1e8 }, yaw: 0 };
    const farIndex = new BuildingCollisionIndex();
    farIndex.upsert(far);
    expect(farIndex.overlaps({ x: 1e8, y: 1.6, z: -1e8 }, 0.24)).toBe(true);
    expect(farIndex.overlaps({ x: 1e8 + 50, y: 1.6, z: -1e8 }, 0.24)).toBe(false);
  });
  it('never blocks on an empty index', () => {
    expect(new BuildingCollisionIndex().overlaps({ x: 0, y: 0, z: 0 }, 1)).toBe(false);
  });
});
