import { hashSeed } from '../utils/random';
import { lerp, smoothstep } from '../utils/math';
import { SimplexNoise } from './noise';
import { BiomeField, createClimateSample } from './biomes';
import type { ClimateSample } from './biomes';

/**
 * Continuous world-space height field, independent of chunk boundaries or LOD.
 * Phase 2 keeps the Phase 1 landform intact and adds continuous climate blending.
 */
export class TerrainField {
  private readonly warp: SimplexNoise;
  private readonly relief: SimplexNoise;
  private readonly detail: SimplexNoise;
  readonly biomes: BiomeField;

  constructor(public readonly seed: string) {
    const hash = hashSeed(seed);
    this.warp = new SimplexNoise(hash ^ 0x1234567);
    this.relief = new SimplexNoise(hash ^ 0x7f4a7c15);
    this.detail = new SimplexNoise(hash ^ 0x6a09e667);
    this.biomes = new BiomeField(seed);
  }

  height(x: number, z: number): number {
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

  sample(x: number, z: number, height: number, slope: number, out = createClimateSample()): ClimateSample {
    return this.biomes.sample(x, z, height, slope, out);
  }

  /** Compatibility entry point used by field tests and independent tools. */
  color(x: number, z: number, height: number, slope: number, out: Float32Array, offset: number): void {
    this.biomes.color(x, z, this.sample(x, z, height, slope), out, offset);
  }
}
