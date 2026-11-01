import { hashSeed } from '../utils/random';
import { lerp, smoothstep } from '../utils/math';
import { SimplexNoise } from './noise';
import { BiomeField, createClimateSample } from './biomes';
import type { ClimateSample } from './biomes';
import { RoadNetwork } from './road-network';
import { BuildingPlacementField } from './buildings/placement';
import type { Earthwork } from './road-network';

/**
 * Continuous world-space height field, independent of chunk boundaries or LOD.
 * Phase 3 grades a deterministic road formation into the natural landform.
 * `naturalHeight` remains the untouched Phase 1/2 field for centreline profiles.
 */
export class TerrainField {
  private readonly warp: SimplexNoise;
  private readonly relief: SimplexNoise;
  private readonly detail: SimplexNoise;
  /** Low-frequency canopy / ground-cover clustering, independent of climate. */
  readonly cover: SimplexNoise;
  readonly biomes: BiomeField;
  readonly roads: RoadNetwork;
  readonly buildings: BuildingPlacementField;
  private readonly roadWork: Earthwork = { corridor: 0, station: 0, lateral: 0, tangentX: 1, tangentZ: 0, normalX: 0, normalZ: 1, curvature: 0, pullout: 0, height: 0, weight: 0 };

  constructor(public readonly seed: string) {
    const hash = hashSeed(seed);
    this.warp = new SimplexNoise(hash ^ 0x1234567);
    this.relief = new SimplexNoise(hash ^ 0x7f4a7c15);
    this.detail = new SimplexNoise(hash ^ 0x6a09e667);
    this.cover = new SimplexNoise(hash ^ 0x1b873593);
    this.biomes = new BiomeField(seed);
    this.roads = new RoadNetwork(seed, (x, z) => this.naturalHeight(x, z));
    this.buildings = new BuildingPlacementField(seed, this);
  }

  naturalHeight(x: number, z: number): number {
    const wx = x + this.warp.fbm(x * 0.00016 + 31, z * 0.00016, 3) * 380;
    const wz = z + this.warp.fbm(x * 0.00016, z * 0.00016 - 17, 3) * 380;
    const continent = this.relief.fbm(wx * 0.000095, wz * 0.000095, 4);
    const mask = smoothstep(-0.38, 0.5, this.warp.fbm(x * 0.000085 + 80, z * 0.000085, 3));
    const ridge = this.relief.ridged(wx * 0.00024, wz * 0.00024, 4);
    const valleyNoise = Math.abs(this.detail.fbm(wx * 0.00019 + 7, wz * 0.00019 - 11, 3));
    const valley = smoothstep(0.035, 0.36, valleyNoise);
    const broadMass = this.relief.fbm(wx * 0.00032 + 19, wz * 0.00032, 3) * 220 * mask;
    const mountains = (Math.pow(ridge, 1.65) * (480 + 920 * mask) + broadMass) * valley;
    const rolling = this.detail.fbm(wx * 0.00085, wz * 0.00085, 3) * 60;
    const gullies = (1 - Math.abs(this.detail.noise(wx * 0.006, wz * 0.006))) * 7;
    const fine = this.detail.fbm(x * 0.014, z * 0.014, 2) * 2.8;
    return 48 + continent * 95 + mountains + (rolling + gullies + fine) * lerp(0.35, 1, valley);
  }

  height(x: number, z: number): number {
    const natural = this.naturalHeight(x, z);
    const work = this.roads.earthwork(x, z, this.roadWork);
    // Only the road formation is altered; climate and biome fields stay continuous.
    return work.weight > 0 ? lerp(natural, work.height, work.weight) : natural;
  }

  sample(x: number, z: number, height: number, slope: number, out = createClimateSample()): ClimateSample {
    return this.biomes.sample(x, z, height, slope, out);
  }

  /** Compatibility entry point used by field tests and independent tools. */
  color(x: number, z: number, height: number, slope: number, out: Float32Array, offset: number): void {
    this.biomes.color(x, z, this.sample(x, z, height, slope), out, offset);
  }
}
