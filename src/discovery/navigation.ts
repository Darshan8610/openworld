import { createRoadSample } from '../world/road-network';
import type { RoadNetwork } from '../world/road-network';

/**
 * Phase 11 — honest route planning over the existing analytic road network.
 *
 * Roads in this world are parallel corridors, not an intersection graph, so a
 * route can only be one of two things:
 *
 *  - `corridor` — both endpoints snap to the same corridor within `snapRadius`
 *    metres; the route follows that corridor between their stations, and the
 *    distance is the real along-road length plus the lateral access walks;
 *  - `direct`   — endpoints are on different corridors (or too far off-road);
 *    the result is an explicitly-labelled straight-line distance. It is never
 *    presented as a calculated drivable/walkable route.
 *
 * Everything is canonical metres; floating-origin shifts cannot affect it.
 */

export interface MapPoint { x: number; z: number }

export type RoutePlan =
  | {
      kind: 'corridor';
      corridor: number;
      fromStation: number;
      toStation: number;
      /** Lateral distance from each endpoint to the corridor centreline. */
      fromLateral: number;
      toLateral: number;
      /** |station delta| + |laterals| — a real upper bound of corridor travel. */
      distanceM: number;
      points: readonly MapPoint[];
    }
  | { kind: 'direct'; distanceM: number };

export interface RouteOptions {
  /** How far an endpoint may sit from a corridor and still count as on-road. */
  snapRadius?: number;
  /** Max samples along a corridor route; bounds memory and drawing cost. */
  maxPoints?: number;
}

const DEFAULTS: Required<RouteOptions> = { snapRadius: 120, maxPoints: 96 };

/** Plan a route between two canonical points using the real road field. */
export function planRoute(
  roads: RoadNetwork,
  from: MapPoint,
  to: MapPoint,
  options: RouteOptions = {},
): RoutePlan {
  const { snapRadius, maxPoints } = { ...DEFAULTS, ...options };
  const roadA = nearestOnRoad(roads, from, snapRadius);
  const roadB = nearestOnRoad(roads, to, snapRadius);
  if (roadA && roadB && roadA.corridor === roadB.corridor) {
    const fromStation = roadA.station;
    const toStation = roadB.station;
    const along = Math.abs(toStation - fromStation);
    const distanceM = along + Math.abs(roadA.lateral) + Math.abs(roadB.lateral);
    const steps = Math.max(2, Math.min(maxPoints, Math.ceil(along / 64) + 2));
    const points: MapPoint[] = [];
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const station = fromStation + (toStation - fromStation) * t;
      points.push(roads.point(roadA.corridor, station));
    }
    return { kind: 'corridor', corridor: roadA.corridor, fromStation, toStation,
      fromLateral: roadA.lateral, toLateral: roadB.lateral, distanceM, points };
  }
  return { kind: 'direct', distanceM: Math.hypot(to.x - from.x, to.z - from.z) };
}

interface OnRoad { corridor: number; station: number; lateral: number }

/** Nearest point on a corridor centreline, or undefined beyond `snapRadius`. */
export function nearestOnRoad(roads: RoadNetwork, p: MapPoint, snapRadius = DEFAULTS.snapRadius): OnRoad | undefined {
  const road = roads.sample(p.x, p.z, createRoadSample());
  if (Math.abs(road.lateral) > snapRadius) return undefined;
  return { corridor: road.corridor, station: road.station, lateral: road.lateral };
}

/** Snap a point onto the nearest corridor centreline within `snapRadius`. */
export function snapToRoad(roads: RoadNetwork, p: MapPoint, snapRadius = DEFAULTS.snapRadius): MapPoint | undefined {
  const on = nearestOnRoad(roads, p, snapRadius);
  if (!on) return undefined;
  return roads.point(on.corridor, on.station);
}

/** Human-readable one-liner for a plan — honest about what it is. */
export function describeRoute(plan: RoutePlan): string {
  return plan.kind === 'corridor'
    ? `route ${plan.distanceM.toFixed(0)} m along corridor ${plan.corridor} (plus lateral access)`
    : `direct line ${plan.distanceM.toFixed(0)} m (no shared corridor — not a road route)`;
}
