import { buildingToWorld } from './coordinates';
import type { BuildingCollider, BuildingDescriptor, BuildingDoor, BuildingPart, Point3 } from './types';

export interface BuildingHit { collider: BuildingCollider; fraction: number; normal: Point3 }
const EPSILON = 1e-5;

export function partCollider(building: BuildingDescriptor, part: BuildingPart): BuildingCollider {
  return { id: `${building.id}/part/${part.id}`, buildingId: building.id, center: buildingToWorld(building, part.center), half: { x: part.size.x / 2, y: part.size.y / 2, z: part.size.z / 2 }, yaw: building.yaw + (part.rotation?.y ?? 0), material: part.material, kind: 'static', walkable: part.walkable ?? false };
}
export function doorCollider(building: BuildingDescriptor, door: BuildingDoor, angle: number): BuildingCollider {
  const yaw = door.yaw + angle;
  const local = { x: door.hinge.x + Math.cos(yaw) * door.width / 2, y: door.hinge.y + door.height / 2, z: door.hinge.z - Math.sin(yaw) * door.width / 2 };
  return { id: `${building.id}/door/${door.id}`, buildingId: building.id, center: buildingToWorld(building, local), half: { x: door.width / 2, y: door.height / 2, z: door.thickness / 2 }, yaw: building.yaw + yaw, material: 'timber', kind: 'kinematic', walkable: false };
}

function localPoint(point: Point3, box: BuildingCollider): Point3 {
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw), x = point.x - box.center.x, z = point.z - box.center.z;
  return { x: c * x - s * z, y: point.y - box.center.y, z: s * x + c * z };
}
/** Slab sweep against an expanded OBB, including the entire segment (no tunnelling).
 * Radius expansion is conservative at corners, suitable for camera avoidance.
 * The host physics engine should use the supplied exact box shapes for actors.
 */
export function sweepBox(from: Point3, to: Point3, radius: number, box: BuildingCollider, halfHeight = radius): BuildingHit | undefined {
  const a = localPoint(from, box), b = localPoint(to, box);
  const half = { x: box.half.x + radius, y: box.half.y + halfHeight, z: box.half.z + radius };
  let enter = 0, leave = 1;
  let normal: Point3 = { x: 0, y: 0, z: 0 };
  const inside = Math.abs(a.x) < half.x - EPSILON && Math.abs(a.y) < half.y - EPSILON && Math.abs(a.z) < half.z - EPSILON;
  if (inside) {
    // Let an initially-overlapping camera escape, but not move deeper into a box.
    const distance = (p: Point3) => Math.max(Math.abs(p.x) - half.x, Math.abs(p.y) - half.y, Math.abs(p.z) - half.z);
    if (distance(b) > distance(a)) return undefined;
    const gaps = [half.x - Math.abs(a.x), half.y - Math.abs(a.y), half.z - Math.abs(a.z)];
    const axis = gaps.indexOf(Math.min(...gaps));
    normal = { x: axis === 0 ? Math.sign(a.x) || 1 : 0, y: axis === 1 ? Math.sign(a.y) || 1 : 0, z: axis === 2 ? Math.sign(a.z) || 1 : 0 };
  } else for (const axis of ['x', 'y', 'z'] as const) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < EPSILON) { if (a[axis] < -half[axis] || a[axis] > half[axis]) return undefined; continue; }
    let near = (-half[axis] - a[axis]) / delta, far = (half[axis] - a[axis]) / delta;
    const sign = delta > 0 ? -1 : 1;
    if (near > far) [near, far] = [far, near];
    if (near >= enter) { enter = near; normal = { x: 0, y: 0, z: 0 }; normal[axis] = sign; }
    leave = Math.min(leave, far);
    if (enter > leave || leave < 0 || enter > 1) return undefined;
  }
  if (normal.x === 0 && normal.y === 0 && normal.z === 0) return undefined;
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  return { collider: box, fraction: Math.max(0, enter), normal: { x: c * normal.x + s * normal.z, y: normal.y, z: -s * normal.x + c * normal.z } };
}
export function distanceToBox(point: Point3, box: BuildingCollider): number {
  const local = localPoint(point, box);
  const dx = Math.abs(local.x) - box.half.x, dy = Math.abs(local.y) - box.half.y, dz = Math.abs(local.z) - box.half.z;
  return Math.hypot(Math.max(0, dx), Math.max(0, dy), Math.max(0, dz)) + Math.min(0, Math.max(dx, dy, dz));
}
export function overlapsSphere(point: Point3, radius: number, box: BuildingCollider): boolean {
  return distanceToBox(point, box) < radius;
}

/** Bounded by streamed colliders. No meshes, physics engine or origin dependency. */
export class BuildingCollisionIndex {
  private readonly colliders = new Map<string, BuildingCollider>();
  upsert(collider: BuildingCollider): void { this.colliders.set(collider.id, collider); }
  remove(id: string): void { this.colliders.delete(id); }
  removeBuilding(id: string): void { for (const [key, collider] of this.colliders) if (collider.buildingId === id) this.colliders.delete(key); }
  sweep(from: Point3, to: Point3, radius = 0, halfHeight = radius, ignore?: string): BuildingHit | undefined {
    let closest: BuildingHit | undefined;
    for (const collider of this.colliders.values()) {
      if (collider.id === ignore) continue;
      const reach = Math.hypot(collider.half.x, collider.half.z) + radius;
      if (Math.max(from.x, to.x) < collider.center.x - reach || Math.min(from.x, to.x) > collider.center.x + reach || Math.max(from.z, to.z) < collider.center.z - reach || Math.min(from.z, to.z) > collider.center.z + reach) continue;
      const hit = sweepBox(from, to, radius, collider, halfHeight);
      if (hit && (!closest || hit.fraction < closest.fraction)) closest = hit;
    }
    return closest;
  }
  moveSphere(from: Point3, to: Point3, radius: number): Point3 {
    let current = { ...from }, destination = { ...to };
    for (let iteration = 0; iteration < 4; iteration++) {
      const hit = this.sweep(current, destination, radius);
      if (!hit) return destination;
      const dx = destination.x - current.x, dy = destination.y - current.y, dz = destination.z - current.z;
      const travel = Math.max(0, hit.fraction - 0.0001);
      current = { x: current.x + dx * travel, y: current.y + dy * travel, z: current.z + dz * travel };
      const remain = 1 - travel;
      const dot = (dx * hit.normal.x + dy * hit.normal.y + dz * hit.normal.z) * remain;
      destination = { x: current.x + dx * remain - Math.min(0, dot) * hit.normal.x, y: current.y + dy * remain - Math.min(0, dot) * hit.normal.y, z: current.z + dz * remain - Math.min(0, dot) * hit.normal.z };
    }
    return current;
  }
  supportHeight(position: Point3, maxStep = 0.25): number | undefined {
    let highest: number | undefined;
    for (const box of this.colliders.values()) {
      if (!box.walkable) continue;
      const local = localPoint(position, box), top = box.center.y + box.half.y;
      if (Math.abs(local.x) <= box.half.x && Math.abs(local.z) <= box.half.z && top <= position.y + maxStep && top >= position.y - 1.1 && (highest === undefined || top > highest)) highest = top;
    }
    return highest;
  }
  get values(): readonly BuildingCollider[] { return [...this.colliders.values()]; }
  get size(): number { return this.colliders.size; }
  clear(): void { this.colliders.clear(); }
}
