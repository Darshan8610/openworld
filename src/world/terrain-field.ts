import { hashSeed } from '../utils/random';
import { clamp, lerp, smoothstep } from '../utils/math';
import { SimplexNoise } from './noise';

/**
 * Continuous world-space height field, independent of chunk boundaries or LOD.
 * Phase 1 is an alpine material study; climate-driven biomes arrive in Phase 2.
 */
export class TerrainField {
  private readonly warp: SimplexNoise;
  private readonly relief: SimplexNoise;
  private readonly detail: SimplexNoise;

  constructor(public readonly seed: string) {
    const hash = hashSeed(seed);
    this.warp = new SimplexNoise(hash ^ 0x1234567);
    this.relief = new SimplexNoise(hash ^ 0x7f4a7c15);
    this.detail = new SimplexNoise(hash ^ 0x6a09e667);
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
    // Low-amplitude, slope-aligned gullies suggest erosion without a costly fluid solve.
    const gullies = (1 - Math.abs(this.detail.noise(wx * 0.006, wz * 0.006))) * 7;
    const fine = this.detail.fbm(x * 0.014, z * 0.014, 2) * 2.8;
    return 48 + continent * 95 + mountains + (rolling + gullies + fine) * lerp(0.35, 1, valley);
  }

  /** Linear albedo. Slope exposes rock; noisy altitude transitions avoid contour bands. */
  color(x: number, z: number, height: number, slope: number, out: Float32Array, offset: number): void {
    const variation = this.detail.fbm(x * 0.0018, z * 0.0018, 3);
    const meadow = smoothstep(-0.5, 0.6, variation);
    let r = lerp(0.105, 0.23, meadow), g = lerp(0.16, 0.265, meadow), b = lerp(0.075, 0.105, meadow);
    const dry = smoothstep(260, 700, height + variation * 100);
    r = lerp(r, 0.235, dry); g = lerp(g, 0.235, dry); b = lerp(b, 0.17, dry);
    const rock = clamp(smoothstep(0.23, 0.53, slope) + smoothstep(650, 1100, height) * 0.65, 0, 1);
    const strata = this.detail.noise(x * 0.024, height * 0.035 + z * 0.009) * 0.035;
    r = lerp(r, 0.265 + strata, rock); g = lerp(g, 0.275 + strata, rock); b = lerp(b, 0.26 + strata, rock);
    const snow = smoothstep(920, 1220, height + variation * 150) * (1 - smoothstep(0.48, 0.85, slope));
    out[offset] = lerp(r, 0.8, snow);
    out[offset + 1] = lerp(g, 0.85, snow);
    out[offset + 2] = lerp(b, 0.88, snow);
  }
}
