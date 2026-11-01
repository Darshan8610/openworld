import { CONFIG } from '../config';
import { hashSeed, seededRandom } from '../utils/random';
import { clamp, lerp, smoothstep } from '../utils/math';
import { createRiverSample, RiverNetwork } from './river-network';
import type { RiverSample } from './river-network';

/**
 * Deterministic hydrology for the infinite world.
 *
 * Two families of water bodies are generated purely from `(seed, x, z)`:
 *
 *  - **Basins** (ponds, lakes, reservoirs, wetlands, seas) sit on a coarse seeded
 *    lattice. A cell only floods when the landform there is a genuine closed
 *    depression, so a lake never appears on a crest or a uniform slope. Candidate
 *    centres are searched and the largest radius that still holds water is kept.
 *    The surface is derived from the basin rim (always below the spill point) and
 *    the bed is carved into the terrain, so the rendered terrain, the streamed
 *    physics heightfield and the water surface cannot disagree.
 *  - **Rivers** follow `RiverNetwork` corridors with a monotone downhill floor.
 *
 * `carve()` is the single place that lowers terrain for water and `sampleAt()` is
 * the single place that answers "is there water here". Terrain generation
 * (workers included), water rendering, buoyancy and swimming all use these two
 * entry points, so nothing else in the game re-derives water.
 */

export type WaterKind = 'pond' | 'lake' | 'reservoir' | 'wetland' | 'river' | 'sea';

export interface WaterSample {
  bodyId: string;
  kind: WaterKind;
  /** Water surface elevation in canonical world space (metres). */
  surfaceY: number;
  /** Water column below the surface at this point, metres. */
  depth: number;
  /** Surface current in metres per second. */
  flowX: number;
  flowZ: number;
  /** Peak wave displacement of this body, metres. */
  waveAmplitude: number;
  /** 0 at the shoreline, 1 in the deepest part of the body. */
  shore: number;
}

export interface WaterCarve {
  /** Bed height: what the terrain becomes where `weight` is 1. */
  bed: number;
  /** 0 = untouched ground, 1 = fully carved bed. */
  weight: number;
}

export function createWaterSample(): WaterSample {
  return {
    bodyId: '', kind: 'lake', surfaceY: 0, depth: 0, flowX: 0, flowZ: 0,
    waveAmplitude: 0, shore: 0,
  };
}

interface BasinBody {
  id: string;
  kind: WaterKind;
  x: number;
  z: number;
  /** Semi-major axis, metres. */
  radius: number;
  /** Semi-minor / semi-major axis ratio. */
  aspect: number;
  cos: number;
  sin: number;
  /** Maximum basin depth below the surface, metres. */
  depth: number;
  surfaceY: number;
  waveAmplitude: number;
}

interface Probe {
  body?: WaterSample;
  carve?: WaterCarve;
}

/** Wave constants shared with `rendering/water-material.ts`; keep them in sync. */
export const WATER_WAVES = {
  k1x: 0.031, k1z: 0.021, w1: 1.1, a1: 0.5,
  k2x: -0.017, k2z: 0.043, w2: 0.8, a2: 0.3,
  k3x: 0.062, k3z: -0.058, w3: 1.6, a3: 0.2,
} as const;

const TAU = Math.PI * 2;
const RIM_PROBES = 12;

export class WaterField {
  readonly rivers: RiverNetwork;
  private readonly basinCache = new Map<string, BasinBody | null>();
  private readonly probeCache = new Map<number, Probe>();
  /** Bound on the memo table used by physics/rendering hot paths. */
  private readonly probeLimit = 8192;
  private readonly river: RiverSample = createRiverSample();
  private readonly nearSample: WaterSample = createWaterSample();
  private activity = 1;

  constructor(
    public readonly seed: string,
    private readonly naturalHeight: (x: number, z: number) => number,
    /**
     * Ground height *before* water is carved — the natural landform plus any
     * engineered formation. Water is contained by this surface, so a lake never
     * reports water where a road embankment stands above it. Defaults to the
     * natural landform when no engineering exists.
     */
    private readonly ground: (x: number, z: number) => number = naturalHeight,
  ) {
    this.rivers = new RiverNetwork(seed, naturalHeight);
  }

  get cellSize(): number { return CONFIG.water.basinCell; }

  /** Water at a world position, or undefined on dry land. */
  sampleAt(x: number, z: number, out: WaterSample = createWaterSample()): WaterSample | undefined {
    const probe = this.probe(x, z);
    if (!probe.body) return undefined;
    const body = probe.body;
    out.bodyId = body.bodyId;
    out.kind = body.kind;
    out.surfaceY = body.surfaceY;
    out.depth = body.depth;
    out.flowX = body.flowX;
    out.flowZ = body.flowZ;
    out.waveAmplitude = body.waveAmplitude;
    out.shore = body.shore;
    return out;
  }

  /**
   * Water surface including the analytic wave displacement used by the vertex
   * shader. Physics (buoyancy, swimming) reads this so objects ride the water
   * that is actually drawn.
   */
  displacedSurface(x: number, z: number, time: number): number | undefined {
    const sample = this.sampleAt(x, z);
    if (!sample) return undefined;
    return sample.surfaceY + this.waveOffset(x, z, time, sample.waveAmplitude, sample.depth);
  }

  /**
   * Vertical wave displacement. This is the authoritative definition: the water
   * vertex shader evaluates the identical three-wave sum with a per-vertex phase,
   * so buoyancy, swimming and the drawn surface cannot drift apart.
   */
  waveOffset(x: number, z: number, time: number, amplitude: number, depth = 10): number {
    if (amplitude <= 0) return 0;
    const scale = amplitude * this.waveScale(depth) * this.activity;
    if (scale <= 0) return 0;
    const w = WATER_WAVES;
    return scale * (
      Math.sin(x * w.k1x + z * w.k1z + time * w.w1) * w.a1
      + Math.sin(x * w.k2x + z * w.k2z - time * w.w2) * w.a2
      + Math.sin(x * w.k3x + z * w.k3z + time * w.w3) * w.a3
    );
  }

  /** Waves are damped as water thins; mirrors the shader's depth mix exactly. */
  waveScale(depth: number): number {
    return 0.35 + 0.65 * clamp(depth * 0.5, 0, 1);
  }

  /** Sea state from the weather system (0 = glassy, 1 = calm, >1 = rough). */
  setActivity(value: number): void { this.activity = clamp(value, 0, 1.6); }
  get seaState(): number { return this.activity; }

  /**
   * Surface elevation of the nearest water body, searched in expanding rings.
   * The water renderer uses it to place shoreline vertices exactly on the local
   * water plane: a quad that spans the bank stays horizontal, so its visible edge
   * is the true intersection of the surface with the terrain instead of a ragged
   * grid-aligned cut. Returns undefined when nothing is within `maxRadius`.
   */
  surfaceNear(x: number, z: number, maxRadius = 32): number | undefined {
    const sample = this.sampleAt(x, z, this.nearSample);
    if (sample) return sample.surfaceY;
    for (let radius = 4; radius <= maxRadius; radius *= 2) {
      for (let i = 0; i < 8; i++) {
        const angle = i / 8 * TAU;
        const found = this.sampleAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius, this.nearSample);
        if (found) return found.surfaceY;
      }
    }
    return undefined;
  }

  /**
   * Ground height *before* carving (natural landform + engineering). The water
   * renderer uses it to sink dry vertices below the bank, so the drawn shoreline
   * is the real intersection of the surface with the terrain.
   */
  groundAt(x: number, z: number): number { return this.ground(x, z); }

  /** Terrain height after water carving at this position. */
  carvedHeight(x: number, z: number): number {
    const base = this.ground(x, z);
    const carve = this.probe(x, z).carve;
    return carve ? lerp(base, carve.bed, carve.weight) : base;
  }

  /** Terrain carving for a world position, or undefined when no water is near. */
  carve(x: number, z: number): WaterCarve | undefined { return this.probe(x, z).carve; }

  /** Basins currently cached (diagnostics/tests). */
  get cachedBasins(): number { return this.basinCache.size; }

  /**
   * Composite probe: which body (if any) covers this XZ, and how the bed is
   * shaped. Memoised on a 4 m grid — buoyancy asks this per body per substep.
   */
  private probe(x: number, z: number): Probe {
    const key = (Math.round(x / 4) + 32768) * 262144 + (Math.round(z / 4) + 32768);
    const cached = this.probeCache.get(key);
    if (cached) return cached;
    const probe = this.computeProbe(x, z);
    if (this.probeCache.size >= this.probeLimit) {
      const oldest = this.probeCache.keys().next();
      if (!oldest.done) this.probeCache.delete(oldest.value);
    }
    this.probeCache.set(key, probe);
    return probe;
  }

  private computeProbe(x: number, z: number): Probe {
    const base = this.ground(x, z);
    const probe: Probe = {};
    /** Lowest carved bed found so far (water bodies only ever lower terrain). */
    let bed = base;
    let weight = 0;
    let bestSurface = -Infinity;

    const cell = this.cellSize;
    const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const body = this.basin(ix + dx, iz + dz);
      if (!body) continue;
      const ox = x - body.x, oz = z - body.z;
      const lx = (ox * body.cos + oz * body.sin) / body.radius;
      const lz = (-ox * body.sin + oz * body.cos) / (body.radius * body.aspect);
      const t2 = lx * lx + lz * lz;
      if (t2 >= 1) continue;
      const t = Math.sqrt(t2);
      // Bed profile: deepest at the centre, meeting the landform at the rim.
      const bedShape = body.surfaceY - body.depth * (1 - t * t);
      const rim = 1 - smoothstep(0.68, 1, t);
      const shape = Math.min(base, bedShape);
      if (rim > weight && shape < bed) { bed = shape; weight = rim; }
      const carved = lerp(base, shape, rim);
      const depth = body.surfaceY - carved;
      if (depth > 0 && body.surfaceY > bestSurface) {
        bestSurface = body.surfaceY;
        probe.body = {
          bodyId: body.id, kind: body.kind, surfaceY: body.surfaceY, depth,
          flowX: 0, flowZ: 0, waveAmplitude: body.waveAmplitude, shore: clamp(1 - t, 0, 1),
        };
      }
    }

    const river = this.rivers.sample(x, z, this.river);
    if (river) {
      const lateral = Math.abs(river.lateral);
      if (lateral <= this.rivers.bankWidth(river.halfWidth)) {
        const section = this.rivers.crossSection(river.lateral, river.halfWidth);
        const bedShape = river.surfaceY - river.depth * section;
        const riverWeight = this.rivers.carveWeight(river.lateral, river.halfWidth);
        const shape = Math.min(base, bedShape);
        if (riverWeight > weight && shape < bed) { bed = shape; weight = riverWeight; }
        if (lateral <= river.halfWidth) {
          const carved = lerp(base, shape, riverWeight);
          const depth = river.surfaceY - carved;
          if (depth > 0 && river.surfaceY > bestSurface) {
            bestSurface = river.surfaceY;
            const flowLength = Math.hypot(river.flowX, river.flowZ) || 1;
            const speed = clamp(Math.abs(river.flow) * 60, 0.3, 2.2);
            probe.body = {
              bodyId: `river:${river.corridor}:${Math.round(river.station / 32)}`,
              kind: 'river',
              surfaceY: river.surfaceY,
              depth,
              flowX: river.flowX / flowLength * speed,
              flowZ: river.flowZ / flowLength * speed,
              waveAmplitude: CONFIG.water.riverWaveAmplitude,
              shore: clamp(1 - lateral / Math.max(0.001, river.halfWidth), 0, 1),
            };
          }
        }
      }
    }

    if (weight > 0.001 && bed < base - 0.01) probe.carve = { bed, weight };
    if (probe.body && probe.body.depth <= CONFIG.water.minSampleDepth) delete probe.body;
    return probe;
  }

  /**
   * Basin bodies for one lattice cell. A body is only created when the cell holds
   * a real depression: several candidate centres are probed against the landform
   * and the largest radius that still holds water wins. Cached per cell; a basin
   * is a pure function of the seed, so eviction only costs recomputation.
   */
  private basin(ix: number, iz: number): BasinBody | null {
    const key = `${ix}:${iz}`;
    const cached = this.basinCache.get(key);
    if (cached !== undefined) return cached;
    const body = this.createBasin(ix, iz);
    if (this.basinCache.size >= CONFIG.water.basinCacheLimit) {
      let removed = 0;
      for (const old of this.basinCache.keys()) {
        this.basinCache.delete(old);
        if (++removed >= CONFIG.water.basinCacheLimit / 2) break;
      }
    }
    this.basinCache.set(key, body);
    return body;
  }

  private createBasin(ix: number, iz: number): BasinBody | null {
    const cell = this.cellSize;
    const hash = hashSeed(this.seed);
    const random = seededRandom((hash ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1)) | 0);
    const roll = random();
    const sea = roll < CONFIG.water.seaChance;
    const wet = sea || roll < CONFIG.water.seaChance + CONFIG.water.lakeChance;
    const candidates: [number, number][] = [];
    for (let i = 0; i < 4; i++) candidates.push([random(), random()]);
    const radiusRoll = random(), aspectRoll = random(), rotationRoll = random();
    const depthRoll = random(), kindRoll = random();
    if (!wet) return null;
    const aspect = sea ? lerp(0.72, 1, aspectRoll) : lerp(0.55, 1, aspectRoll);
    const rotation = rotationRoll * TAU;

    const [seaMin, seaMax] = CONFIG.water.seaRadius;
    const [lakeMin, lakeMax] = CONFIG.water.lakeRadius;
    // Radius comes from the seed, not from a search: a cell that can hold a small
    // pond is not silently inflated into a two-kilometre sea just because one rim
    // probe happened to be low. A single smaller fallback keeps wet cells wet.
    const base = sea
      ? lerp(seaMin, seaMax, radiusRoll)
      : lerp(lakeMin, lakeMax, radiusRoll ** 1.2);
    const radii = [base, base * 0.55];

    let best: BasinBody | null = null;
    for (const [jx, jz] of candidates) {
      const x = (ix + 0.17 + jx * 0.66) * cell;
      const z = (iz + 0.17 + jz * 0.66) * cell;
      const centreHeight = this.naturalHeight(x, z);
      for (const radius of radii) {
        // Rim statistics decide whether this is a believable bowl: the surface is
        // kept below the *lowest* rim probe, and the mean rim must stand well
        // above the centre so we never excavate a lake into a hillside.
        let rimMin = Infinity, rimSum = 0;
        for (let i = 0; i < RIM_PROBES; i++) {
          const angle = i / RIM_PROBES * TAU;
          const height = this.naturalHeight(
            x + Math.cos(angle) * radius * 1.04,
            z + Math.sin(angle) * radius * aspect * 1.04,
          );
          rimMin = Math.min(rimMin, height);
          rimSum += height;
        }
        const rimMean = rimSum / RIM_PROBES;
        const basin = rimMin - centreHeight;
        if (basin < CONFIG.water.minBasinDepth) continue;
        if (rimMean - centreHeight < CONFIG.water.minBasinDepth * 1.6) continue;
        const big = radius >= CONFIG.water.seaRadius[0] * 0.62;
        const [minDepth, maxDepth] = big ? CONFIG.water.seaDepth : CONFIG.water.lakeDepth;
        const depth = clamp(lerp(minDepth, maxDepth, depthRoll), minDepth, Math.max(minDepth, basin * 1.15));
        const surfaceY = Math.min(centreHeight + basin * CONFIG.water.fill, rimMin - CONFIG.water.freeboard);
        const kind: WaterKind = big ? 'sea'
          : radius < 150 ? 'pond'
            : depth < 1.8 ? 'wetland'
              : kindRoll > 0.78 ? 'reservoir' : 'lake';
        best = {
          id: `${kind}:${ix}:${iz}`,
          kind, x, z, radius, aspect,
          cos: Math.cos(rotation), sin: Math.sin(rotation),
          depth, surfaceY,
          waveAmplitude: big ? CONFIG.water.seaWaveAmplitude
            : kind === 'pond' ? CONFIG.water.pondWaveAmplitude : CONFIG.water.lakeWaveAmplitude,
        };
        break;
      }
      if (best) break;
    }
    return best;
  }
}
