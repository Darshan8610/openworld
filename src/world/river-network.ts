import { CONFIG } from '../config';
import { hashSeed } from '../utils/random';
import { clamp, smoothstep } from '../utils/math';

/**
 * Deterministic river network.
 *
 * Rivers are generated exactly like the Phase 3 road corridors — an analytic,
 * seed-warped centreline repeated every `riverSpacing` metres in Z, with a
 * random-access Newton projection — but their vertical profile is *hydrological*
 * rather than engineered: the channel floor is a monotone Hermite curve through
 * the natural landform sampled along the centreline, so water always runs
 * downhill and never pools on a crest.
 *
 * Every river sample is a pure function of `(seed, x, z)`. There is no path
 * accumulation and no chunk-local state, so a river is identical in a terrain
 * worker, in a water mesh built on the main thread, and in a physics query.
 */

export interface RiverSample {
  corridor: number;
  station: number;
  /** Signed distance from the centreline in metres. */
  lateral: number;
  tangentX: number;
  tangentZ: number;
  /** Half-width of the wetted channel, metres. */
  halfWidth: number;
  /** Water depth at the deepest point of the cross-section, metres. */
  depth: number;
  /** Water surface height at this station. */
  surfaceY: number;
  /** Signd flow speed along the tangent (negative = upstream direction). */
  flow: number;
  /** Downhill unit direction in world XZ. */
  flowX: number;
  flowZ: number;
}

export function createRiverSample(): RiverSample {
  return {
    corridor: 0, station: 0, lateral: 0, tangentX: 1, tangentZ: 0,
    halfWidth: 0, depth: 0, surfaceY: 0, flow: 0, flowX: 1, flowZ: 0,
  };
}

interface ChannelShape {
  halfWidth: number;
  depth: number;
  /** Bed height at the centreline (water surface minus depth). */
  floor: number;
  surfaceY: number;
  /** d(floor)/d(station) — negative means the river runs with +station. */
  slope: number;
}

const PROFILE_STEP = 48;

export class RiverNetwork {
  private readonly phaseA: number;
  private readonly phaseB: number;
  private readonly phaseW: number;
  private readonly phaseD: number;
  private readonly nodeCache = new Map<string, number>();
  private readonly channelCache = new Map<string, ChannelShape>();

  constructor(
    public readonly seed: string,
    private readonly naturalHeight: (x: number, z: number) => number,
  ) {
    const hash = hashSeed(seed);
    this.phaseA = (hash & 0xffff) / 0xffff * Math.PI * 2;
    this.phaseB = ((hash >>> 8) & 0xffff) / 0xffff * Math.PI * 2;
    this.phaseW = ((hash >>> 16) & 0xffff) / 0xffff * Math.PI * 2;
    this.phaseD = ((hash >>> 22) & 0xff) / 0xff * Math.PI * 2;
  }

  get spacing(): number { return CONFIG.water.riverSpacing; }

  center(corridor: number, station: number): number {
    return corridor * this.spacing
      + Math.sin(station * 0.00041 + this.phaseA) * 430
      + Math.sin(station * 0.00113 + this.phaseB) * 145
      + Math.sin(station * 0.0029 + this.phaseA * 0.5) * 38;
  }

  private derivative(station: number): number {
    return Math.cos(station * 0.00041 + this.phaseA) * 430 * 0.00041
      + Math.cos(station * 0.00113 + this.phaseB) * 145 * 0.00113
      + Math.cos(station * 0.0029 + this.phaseA * 0.5) * 38 * 0.0029;
  }

  private secondDerivative(station: number): number {
    return -Math.sin(station * 0.00041 + this.phaseA) * 430 * 0.00041 ** 2
      - Math.sin(station * 0.00113 + this.phaseB) * 145 * 0.00113 ** 2
      - Math.sin(station * 0.0029 + this.phaseA * 0.5) * 38 * 0.0029 ** 2;
  }

  /**
   * Cheap rejection first (two centreline evaluations), then Newton projection.
   * Returns `undefined` outside the river floodplain, which is the common case.
   */
  sample(x: number, z: number, out: RiverSample = createRiverSample()): RiverSample | undefined {
    const corridor = Math.round((z - this.center(0, x)) / this.spacing);
    if (Math.abs(z - this.center(corridor, x)) > CONFIG.water.riverReach) return undefined;
    let station = x;
    for (let i = 0; i < 3; i++) {
      const offset = z - this.center(corridor, station);
      const slope = this.derivative(station);
      const denominator = 1 + slope * slope - offset * this.secondDerivative(station);
      station = clamp(station - (station - x - offset * slope) / Math.max(0.5, denominator), x - 600, x + 600);
    }
    const slope = this.derivative(station);
    const inverse = 1 / Math.hypot(1, slope);
    out.corridor = corridor;
    out.station = station;
    out.lateral = (z - this.center(corridor, station)) * inverse;
    out.tangentX = inverse;
    out.tangentZ = slope * inverse;
    if (Math.abs(out.lateral) > CONFIG.water.riverReach) return undefined;
    const channel = this.channel(corridor, station);
    out.halfWidth = channel.halfWidth;
    out.depth = channel.depth;
    out.surfaceY = channel.surfaceY;
    out.flow = -channel.slope;
    // Water runs down the gradient of the channel floor.
    const direction = channel.slope <= 0 ? 1 : -1;
    out.flowX = out.tangentX * direction;
    out.flowZ = out.tangentZ * direction;
    return out;
  }

  /** Channel shape at a station; widths and depths vary slowly and smoothly. */
  private channel(corridor: number, station: number): ChannelShape {
    const key = `${corridor}:${Math.round(station / 8)}`;
    const cached = this.channelCache.get(key);
    if (cached) return cached;
    const bucket = Math.round(station / 8) * 8;
    const floor = this.floorAt(corridor, bucket);
    const upper = this.floorAt(corridor, bucket + PROFILE_STEP);
    const slope = (upper - floor) / PROFILE_STEP;
    const [minWidth, maxWidth] = CONFIG.water.riverHalfWidth;
    const [minDepth, maxDepth] = CONFIG.water.riverDepth;
    const widthWave = 0.5 + 0.5 * Math.sin(bucket * 0.0009 + this.phaseW);
    const widthWave2 = 0.5 + 0.5 * Math.sin(bucket * 0.0031 + this.phaseW * 1.7);
    const halfWidth = clamp(minWidth + (maxWidth - minWidth) * (widthWave * 0.7 + widthWave2 * 0.3), minWidth, maxWidth);
    const depthWave = 0.5 + 0.5 * Math.sin(bucket * 0.0017 + this.phaseD);
    // Fast water in the steep reaches is shallower and narrower; this is an
    // approximation of hydraulic geometry, not a solved flow model.
    const steepness = clamp(Math.abs(slope), 0, 1);
    const depth = clamp(
      minDepth + (maxDepth - minDepth) * (depthWave * 0.75 + (1 - steepness) * 0.25),
      minDepth, maxDepth,
    );
    const shape: ChannelShape = {
      halfWidth, depth,
      floor,
      surfaceY: floor + depth,
      slope,
    };
    this.bound(this.channelCache, 4096);
    this.channelCache.set(key, shape);
    return shape;
  }

  /** Monotone Hermite floor through the landform along the centreline. */
  private floorAt(corridor: number, station: number): number {
    const node = Math.floor(station / PROFILE_STEP);
    const t = station / PROFILE_STEP - node;
    const h0 = this.nodeHeight(corridor, node), h1 = this.nodeHeight(corridor, node + 1);
    const before = (h0 - this.nodeHeight(corridor, node - 1)) / PROFILE_STEP;
    const middle = (h1 - h0) / PROFILE_STEP;
    const after = (this.nodeHeight(corridor, node + 2) - h1) / PROFILE_STEP;
    const tangent = (a: number, b: number): number => {
      if (a * b <= 0) return 0;
      const mean = (a + b) * 0.5, limit = 3 * Math.min(Math.abs(a), Math.abs(b));
      return Math.sign(mean) * Math.min(Math.abs(mean), limit);
    };
    const m0 = tangent(before, middle) * PROFILE_STEP, m1 = tangent(middle, after) * PROFILE_STEP;
    const t2 = t * t, t3 = t2 * t;
    const height = (2 * t3 - 3 * t2 + 1) * h0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * h1 + (t3 - t2) * m1;
    // Sit the channel slightly below the monotone floor so the bed is always wet.
    return height - CONFIG.water.riverInset;
  }

  private nodeHeight(corridor: number, node: number): number {
    const key = `${corridor}:${node}`;
    const cached = this.nodeCache.get(key);
    if (cached !== undefined) return cached;
    const station = node * PROFILE_STEP;
    const height = this.naturalHeight(station, this.center(corridor, station));
    this.bound(this.nodeCache, 8192);
    this.nodeCache.set(key, height);
    return height;
  }

  /** Bound a cache without clearing it; workers are long-lived. */
  private bound(cache: Map<string, unknown>, limit: number): void {
    if (cache.size < limit) return;
    let removed = 0;
    for (const key of cache.keys()) { cache.delete(key); if (++removed >= limit / 2) break; }
  }

  /** Slow-varying floodplain width used for bank shaping and clearance tests. */
  bankWidth(halfWidth: number): number {
    return halfWidth + 16 + halfWidth * 0.9;
  }

  /** Normalised cross-section depth factor: 1 at the thalweg, 0 at the bank. */
  crossSection(lateral: number, halfWidth: number): number {
    const t = clamp(Math.abs(lateral) / Math.max(0.001, halfWidth), 0, 1);
    return 1 - t * t;
  }

  /** Weight of the carved channel at a lateral offset. */
  carveWeight(lateral: number, halfWidth: number): number {
    return 1 - smoothstep(halfWidth, this.bankWidth(halfWidth), Math.abs(lateral));
  }
}
