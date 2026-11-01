import { CONFIG } from '../config';
import { mod } from '../utils/math';
import { tileSize } from './tiles';
import type { TileCoord } from './tiles';
import type { RoadNetwork, RoadSample } from './road-network';
import { createRoadSample } from './road-network';

export const PROP_KINDS = ['guardrail', 'reflector', 'route-sign', 'direction-sign', 'bench', 'kiosk', 'bollard'] as const;
export type PropKind = typeof PROP_KINDS[number];
/** tile-local X, world Y, tile-local Z, yaw, kind, scale, stable random, reserved. */
export const PROP_STRIDE = 8;
export interface RoadTileData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  /** 0 asphalt, 1 gravel shoulder, 2 painted marking. */
  surface: Float32Array;
  indices: Uint32Array;
  props: Float32Array;
}
export const emptyRoadTile = (): RoadTileData => ({
  positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0),
  colors: new Float32Array(0), surface: new Float32Array(0), indices: new Uint32Array(0), props: new Float32Array(0),
});

// Linear-space albedo. Markings are geometry strips, not a stretched decal.
const ASPHALT = [0.052, 0.058, 0.064], GRAVEL = [0.23, 0.215, 0.18], WHITE = [0.86, 0.85, 0.76], YELLOW = [0.82, 0.56, 0.09];
const STRIPS: readonly { a: number; b: number; type: number; color: readonly number[] }[] = [
  { a: -7.2, b: -5.0, type: 1, color: GRAVEL },
  { a: -5.0, b: -3.55, type: 0, color: ASPHALT },
  { a: -3.55, b: -3.40, type: 2, color: WHITE },
  { a: -3.40, b: -0.20, type: 0, color: ASPHALT },
  { a: -0.20, b: -0.08, type: 2, color: YELLOW },
  { a: -0.08, b: 0.08, type: 0, color: ASPHALT },
  { a: 0.08, b: 0.20, type: 2, color: YELLOW },
  { a: 0.20, b: 3.40, type: 0, color: ASPHALT },
  { a: 3.40, b: 3.55, type: 2, color: WHITE },
  { a: 3.55, b: 5.0, type: 0, color: ASPHALT },
  { a: 5.0, b: 7.2, type: 1, color: GRAVEL },
];

/**
 * Clip analytic corridors to a tile by centreline ownership, then drape every
 * lane/marking strip on that tile's actual triangles. Fine tiles resolve the
 * graded formation; coarse tiles keep a continuous distant road silhouette.
 */
export function generateRoadTile(coord: TileCoord, roads: RoadNetwork, surfaceHeight: (x: number, z: number) => number): RoadTileData {
  const size = tileSize(coord.level), left = coord.x * size, top = coord.z * size, right = left + size, bottom = top + size;
  const step = coord.level >= 5 ? 8 : coord.level === 4 ? 16 : Math.max(32, size / 48);
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [], surface: number[] = [], indices: number[] = [];
  const sample: RoadSample = createRoadSample();
  const k0 = Math.floor((top - roads.center(0, left)) / CONFIG.roads.corridorSpacing) - 1;
  const k1 = Math.ceil((bottom - roads.center(0, right)) / CONFIG.roads.corridorSpacing) + 1;
  const inside = (k: number, x: number) => { const z = roads.center(k, x); return z >= top && z < bottom; };
  const crossing = (k: number, a: number, b: number) => {
    const ca = roads.center(k, a), cb = roads.center(k, b);
    const target = Math.min(ca, cb) < top ? top : bottom;
    const sign = ca - target;
    for (let i = 0; i < 12; i++) {
      const mid = (a + b) / 2;
      if ((roads.center(k, mid) - target) * sign > 0) a = mid; else b = mid;
    }
    return (a + b) / 2;
  };

  const vertex = (k: number, station: number, lateral: number, type: number, color: readonly number[]) => {
    const point = roads.point(k, station, lateral);
    const crown = Math.max(0, 1 - Math.abs(lateral) / 5) * 0.045;
    const y = surfaceHeight(point.x, point.z) + 0.075 + crown + (type === 2 ? 0.012 : 0);
    positions.push(point.x - left, y, point.z - top);
    uvs.push(mod(lateral, 1024) * 0.5, mod(station, 1024) * 0.5);
    colors.push(color[0]!, color[1]!, color[2]!);
    surface.push(type);
  };

  for (let k = k0; k <= k1; k++) {
    const stations: number[] = [];
    let previous = left, wasInside = inside(k, left);
    if (wasInside) stations.push(left);
    for (let x = left + step; x <= right + 0.001; x = Math.min(right, x + step)) {
      const current = Math.min(right, x), isInside = inside(k, current);
      if (isInside !== wasInside) stations.push(crossing(k, previous, current));
      if (isInside) stations.push(current);
      previous = current; wasInside = isInside;
      if (current === right) break;
    }
    stations.sort((a, b) => a - b);
    for (let i = 0; i < stations.length - 1; i++) {
      const a = stations[i]!, b = stations[i + 1]!;
      if (b - a < 0.01 || !inside(k, (a + b) / 2)) continue;
      const pullA = roads.pullout(a) * 10, pullB = roads.pullout(b) * 10;
      for (const strip of STRIPS) {
        const base = positions.length / 3;
        const leftA = strip.a === -7.2 ? strip.a : strip.a === 7.2 ? strip.a + pullA : strip.a;
        const leftB = strip.a === -7.2 ? strip.a : strip.a === 7.2 ? strip.a + pullB : strip.a;
        const rightA = strip.b === 7.2 ? strip.b + pullA : strip.b;
        const rightB = strip.b === 7.2 ? strip.b + pullB : strip.b;
        vertex(k, a, leftA, strip.type, strip.color); vertex(k, a, rightA, strip.type, strip.color);
        vertex(k, b, leftB, strip.type, strip.color); vertex(k, b, rightB, strip.type, strip.color);
        // +Y facing winding in the XZ plane.
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
      // Mark the outer pullout edge with a white line on the widened shoulder.
      if (pullA > 0.5 || pullB > 0.5) {
        const base = positions.length / 3;
        vertex(k, a, 6.8 + pullA, 2, WHITE); vertex(k, a, 6.95 + pullA, 2, WHITE);
        vertex(k, b, 6.8 + pullB, 2, WHITE); vertex(k, b, 6.95 + pullB, 2, WHITE);
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }

  const props = coord.level === CONFIG.terrain.maxDepth ? generateRoadProps(coord, roads, surfaceHeight, sample) : new Float32Array(0);
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { normals[v]! += nx; normals[v + 1]! += ny; normals[v + 2]! += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i]! /= length; normals[i + 1]! /= length; normals[i + 2]! /= length;
  }
  return { positions: new Float32Array(positions), normals, uvs: new Float32Array(uvs), colors: new Float32Array(colors), surface: new Float32Array(surface), indices: new Uint32Array(indices), props };
}

function generateRoadProps(coord: TileCoord, roads: RoadNetwork, surfaceHeight: (x: number, z: number) => number, sample: RoadSample): Float32Array {
  const size = tileSize(coord.level), left = coord.x * size, top = coord.z * size;
  const records: number[] = [];
  const k0 = Math.floor((top - roads.center(0, left)) / CONFIG.roads.corridorSpacing) - 1;
  const k1 = Math.ceil((top + size - roads.center(0, left + size)) / CONFIG.roads.corridorSpacing) + 1;
  const put = (k: number, station: number, lateral: number, kind: number, yawOffset: number, scale: number, random: number) => {
    const point = roads.point(k, station, lateral);
    if (point.x < left || point.x >= left + size || point.z < top || point.z >= top + size) return;
    roads.at(k, station, point.z, sample);
    const yaw = Math.atan2(sample.tangentX, sample.tangentZ) + yawOffset;
    records.push(point.x - left, surfaceHeight(point.x, point.z) - 0.04, point.z - top, yaw, kind, scale, random, 0);
  };
  for (let k = k0; k <= k1; k++) {
    const first = Math.floor(left / 4), last = Math.ceil((left + size) / 4);
    for (let n = first; n < last; n++) {
      const station = n * 4;
      if (station < left || station >= left + size) continue;
      roads.at(k, station, roads.center(k, station), sample);
      const exposed = Math.abs(sample.curvature) > 0.00055 || sample.pullout > 0.2;
      if (exposed) for (const side of [-1, 1]) put(k, station, side * (6.3 + (side > 0 ? sample.pullout * 9.5 : 0)), 0, 0, 1, mod(n * 13 + k * 7, 100) / 100);
      if (mod(n, 8) === 0) for (const side of [-1, 1]) put(k, station, side * 5.35, 1, 0, 1, mod(n * 17 + k * 3, 100) / 100);
      if (mod(n, 64) === 16) put(k, station, (mod(n / 64, 2) === 0 ? -1 : 1) * 8.6, 2, Math.PI, 1, mod(n + k, 100) / 100);
      if (mod(n, 128) === 48) put(k, station, -9.2, 3, Math.PI, 1, mod(n * 3 + k, 100) / 100);
    }
    const firstPullout = Math.floor(left / CONFIG.roads.pulloutSpacing) - 1;
    const lastPullout = Math.ceil((left + size) / CONFIG.roads.pulloutSpacing) + 1;
    for (let n = firstPullout; n <= lastPullout; n++) {
      const center = (n + 0.5) * CONFIG.roads.pulloutSpacing;
      put(k, center - 8, 12.2, 4, -Math.PI / 2, 1, 0.3);
      put(k, center + 8, 12.2, 4, -Math.PI / 2, 1, 0.6);
      put(k, center + 16, 11.8, 5, -Math.PI / 2, 1, 0.5);
      for (let b = -3; b <= 3; b++) put(k, center + b * 8, 15.6, 6, 0, 1, (b + 3) / 6);
    }
  }
  return new Float32Array(records);
}
