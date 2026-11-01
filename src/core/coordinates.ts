/**
 * Common world-coordinate contract shared by every gameplay system.
 *
 * Canonical coordinates are absolute world metres held in JS doubles. Rendering
 * and physics-broadphase code converts to origin-relative coordinates through
 * the floating origin, never the other way around. Anything implementing
 * `WorldPoint` (including Three.js `Vector3`) can be passed directly.
 */
export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export const worldPoint = (x = 0, y = 0, z = 0): WorldPoint => ({ x, y, z });

export const distanceSqXZ = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};
export const distanceXZ = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);
export const distance3 = (a: WorldPoint, b: WorldPoint): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function copyPoint(from: WorldPoint, into: WorldPoint): WorldPoint {
  into.x = from.x; into.y = from.y; into.z = from.z;
  return into;
}

/** Canonical world position -> GPU/render-local position for the current origin. */
export function toRenderPoint(point: WorldPoint, origin: WorldPoint, into: WorldPoint): WorldPoint {
  into.x = point.x - origin.x;
  into.y = point.y - origin.y;
  into.z = point.z - origin.z;
  return into;
}

/** Normalize in place; returns the original vector for chaining. */
export function normalizePoint(point: WorldPoint): WorldPoint {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  point.x /= length; point.y /= length; point.z /= length;
  return point;
}

export const dotPoint = (a: WorldPoint, b: WorldPoint): number => a.x * b.x + a.y * b.y + a.z * b.z;
