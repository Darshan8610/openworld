import type { BuildingDescriptor, Point3 } from './types';

/** Same Y-axis rotation convention as Three.js; no float buffers for world addresses. */
export function buildingToWorld(building: BuildingDescriptor, local: Point3): Point3 {
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: building.position.x + c * local.x + s * local.z, y: building.position.y + local.y, z: building.position.z - s * local.x + c * local.z };
}
export function worldToBuilding(building: BuildingDescriptor, world: Point3): Point3 {
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  const x = world.x - building.position.x, z = world.z - building.position.z;
  return { x: c * x - s * z, y: world.y - building.position.y, z: s * x + c * z };
}
export const distanceXZ = (a: Point3, b: Point3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const finitePoint = (p: Point3): boolean => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
