import { CONFIG } from '../config';
import { hashSeed } from '../utils/random';
import { clamp, mod, smoothstep } from '../utils/math';
import type { BiomeId } from './biomes';

export interface RoadSample {
  corridor: number;
  station: number;
  lateral: number;
  tangentX: number;
  tangentZ: number;
  normalX: number;
  normalZ: number;
  curvature: number;
  pullout: number;
}
export interface Earthwork extends RoadSample { height: number; weight: number }
export interface ScenicRoute { id: string; name: string; description: string; corridor: number; station: number; biome: BiomeId }

/** Three launch points into the same infinite, seed-warped corridor network. */
export const SCENIC_ROUTES: readonly ScenicRoute[] = [
  { id: 'cedar', name: 'Cedar Pass', description: 'Forested slopes & sheltered valleys', corridor: 0, station: -900, biome: 1 },
  { id: 'golden', name: 'Golden Ridge', description: 'Open meadows & long horizons', corridor: 1, station: 600, biome: 2 },
  { id: 'snowline', name: 'Snowline Run', description: 'Rock walls & high country', corridor: -1, station: 1800, biome: 3 },
];
const ROUTE_NAMES = ['Cedar Pass', 'Golden Ridge', 'Snowline Run', 'Larch Valley', 'Moraine Way', 'Aspen Loop'];
const PROFILE_STEP = 64;

export function createRoadSample(): RoadSample {
  return { corridor: 0, station: 0, lateral: 0, tangentX: 1, tangentZ: 0, normalX: 0, normalZ: 1, curvature: 0, pullout: 0 };
}

/**
 * Random-access scenic highway network. Corridors are analytic functions of
 * world X, repeated every 2048 m in Z; no chunk-local randomness or accumulated
 * path state. The centreline profile is a cached monotone cubic through the
 * natural height field, so every LOD agrees on the same graded road bed.
 */
export class RoadNetwork {
  private readonly phaseA: number;
  private readonly phaseB: number;
  private readonly profileCache = new Map<string, number>();

  constructor(public readonly seed: string, private readonly naturalHeight: (x: number, z: number) => number) {
    const hash = hashSeed(seed);
    this.phaseA = (hash & 0xffff) / 0xffff * Math.PI * 2;
    this.phaseB = ((hash >>> 16) & 0xffff) / 0xffff * Math.PI * 2;
  }

  center(corridor: number, station: number): number {
    return corridor * CONFIG.roads.corridorSpacing
      + Math.sin(station * 0.00062 + this.phaseA) * 185
      + Math.sin(station * 0.00163 + this.phaseB) * 58;
  }
  private derivative(station: number): number {
    return Math.cos(station * 0.00062 + this.phaseA) * 185 * 0.00062
      + Math.cos(station * 0.00163 + this.phaseB) * 58 * 0.00163;
  }
  private secondDerivative(station: number): number {
    return -Math.sin(station * 0.00062 + this.phaseA) * 185 * 0.00062 ** 2
      - Math.sin(station * 0.00163 + this.phaseB) * 58 * 0.00163 ** 2;
  }

  pullout(station: number): number {
    const center = (Math.floor(station / CONFIG.roads.pulloutSpacing) + 0.5) * CONFIG.roads.pulloutSpacing;
    return 1 - smoothstep(28, 48, Math.abs(station - center));
  }

  /** Newton projection onto the nearest centreline; stable for slopes < 0.3. */
  sample(x: number, z: number, out = createRoadSample()): RoadSample {
    const corridor = Math.round((z - this.center(0, x)) / CONFIG.roads.corridorSpacing);
    let station = x;
    for (let i = 0; i < 3; i++) {
      const offset = z - this.center(corridor, station);
      const slope = this.derivative(station);
      const denominator = 1 + slope * slope - offset * this.secondDerivative(station);
      station = clamp(station - (station - x - offset * slope) / Math.max(0.5, denominator), x - 400, x + 400);
    }
    return this.at(corridor, station, z, out);
  }

  /** Fill a sample from an explicit station; `referenceZ` only supplies the sign. */
  at(corridor: number, station: number, referenceZ: number, out = createRoadSample()): RoadSample {
    const slope = this.derivative(station), inverse = 1 / Math.hypot(1, slope);
    const center = this.center(corridor, station);
    out.corridor = corridor; out.station = station;
    out.tangentX = inverse; out.tangentZ = slope * inverse;
    out.normalX = -slope * inverse; out.normalZ = inverse;
    out.lateral = (referenceZ - center) * inverse;
    out.curvature = this.secondDerivative(station) * inverse ** 3;
    out.pullout = this.pullout(station);
    return out;
  }

  point(corridor: number, station: number, lateral = 0): { x: number; z: number } {
    const slope = this.derivative(station), inverse = 1 / Math.hypot(1, slope);
    return { x: station - slope * inverse * lateral, z: this.center(corridor, station) + inverse * lateral };
  }

  private nodeHeight(corridor: number, node: number): number {
    const key = `${corridor}:${node}`;
    const cached = this.profileCache.get(key);
    if (cached !== undefined) return cached;
    const station = node * PROFILE_STEP;
    const height = this.naturalHeight(station, this.center(corridor, station));
    // Workers are long-lived: bound the cache independently of travel distance.
    if (this.profileCache.size >= 8192) {
      let removed = 0;
      for (const old of this.profileCache.keys()) { this.profileCache.delete(old); if (++removed >= 4096) break; }
    }
    this.profileCache.set(key, height);
    return height;
  }

  /** Monotone Hermite profile: C1 continuous, no tile seams, no cubic overshoot. */
  profile(corridor: number, station: number): number {
    const node = Math.floor(station / PROFILE_STEP), t = station / PROFILE_STEP - node;
    const h0 = this.nodeHeight(corridor, node), h1 = this.nodeHeight(corridor, node + 1);
    const before = (h0 - this.nodeHeight(corridor, node - 1)) / PROFILE_STEP;
    const middle = (h1 - h0) / PROFILE_STEP;
    const after = (this.nodeHeight(corridor, node + 2) - h1) / PROFILE_STEP;
    const tangent = (a: number, b: number) => {
      if (a * b <= 0) return 0;
      const mean = (a + b) * 0.5, limit = 3 * Math.min(Math.abs(a), Math.abs(b));
      return Math.sign(mean) * Math.min(Math.abs(mean), limit);
    };
    const m0 = tangent(before, middle) * PROFILE_STEP, m1 = tangent(middle, after) * PROFILE_STEP;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * h0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * h1 + (t3 - t2) * m1;
  }

  /** Graded formation plus a smooth cut/fill transition back to natural ground. */
  earthwork(x: number, z: number, out: Earthwork): Earthwork {
    // Cheap rejection before Newton projection / profile sampling for the vast
    // majority of terrain vertices that are nowhere near a road formation.
    const corridor = Math.round((z - this.center(0, x)) / CONFIG.roads.corridorSpacing);
    if (Math.abs(z - this.center(corridor, x)) > 256) { out.weight = 0; out.height = 0; return out; }
    this.sample(x, z, out);
    const distance = Math.abs(out.lateral);
    const bed = 7.2 + out.pullout * 10;
    out.weight = 1 - smoothstep(bed, bed + 18, distance);
    out.height = out.weight > 0 ? this.profile(out.corridor, out.station) - Math.max(0, distance - 5) * 0.035 : 0;
    return out;
  }

  routeInfo(corridor: number, station: number): { name: string; number: string; kilometre: number } {
    const segment = Math.floor((station + 6000) / 12000);
    const name = ROUTE_NAMES[mod(mod(corridor, 3) + segment * 3, ROUTE_NAMES.length)]!;
    return { name, number: String(mod(corridor * 7 + segment, 99) + 1).padStart(2, '0'), kilometre: station / 1000 };
  }
}
