import { hashSeed } from '../utils/random';
import { clamp, smoothstep } from '../utils/math';
import { SimplexNoise } from './noise';

/** Surface ids are also the shader's biome-debug palette indices. */
export const BIOMES = [
  { name: 'Valley meadows', short: 'MEADOW', color: 0x83ad62, description: 'Sheltered grassland and scattered aspen' },
  { name: 'Conifer highlands', short: 'FOREST', color: 0x397c68, description: 'Cool, moist slopes with dense evergreen cover' },
  { name: 'Golden steppe', short: 'STEPPE', color: 0xc6a45e, description: 'Open, dry country with sage and weathered stone' },
  { name: 'Alpine tundra', short: 'TUNDRA', color: 0x9aa7a1, description: 'Low vegetation above the treeline' },
  { name: 'Snowline peaks', short: 'SNOWLINE', color: 0xe0edf2, description: 'Exposed summits, snow pockets and bare rock' },
] as const;
export type BiomeId = 0 | 1 | 2 | 3 | 4;
export interface ClimateSample {
  temperature: number;
  moisture: number;
  /** Normalized meadow / forest / steppe / tundra / snowline weights. */
  weights: [number, number, number, number, number];
  dominant: BiomeId;
  rock: number;
  snow: number;
}
export const createClimateSample = (): ClimateSample => ({
  temperature: 0, moisture: 0, weights: [1, 0, 0, 0, 0], dominant: 0, rock: 0, snow: 0,
});

/**
 * Continuous climate is independent of tiles, mesh resolution and render origin.
 * Height supplies the lapse-rate / treeline / snowline gradients; two slow noise
 * fields move the same boundaries horizontally. No hard biome-cell boundaries.
 */
export class BiomeField {
  private readonly climate: SimplexNoise;
  private readonly variation: SimplexNoise;

  constructor(public readonly seed: string) {
    const hash = hashSeed(seed);
    this.climate = new SimplexNoise(hash ^ 0x5163a29b);
    this.variation = new SimplexNoise(hash ^ 0x243f6a88);
  }

  sample(x: number, z: number, height: number, slope: number, out = createClimateSample()): ClimateSample {
    const temperature = clamp(0.57 - height * 0.00039 + this.climate.fbm(x * 0.000105 + 41, z * 0.000105 - 23, 3) * 0.32, 0, 1);
    const moisture = clamp(0.51 + this.climate.fbm(x * 0.00014 - 67, z * 0.00014 + 38, 3) * 0.64 + this.variation.noise(x * 0.00065, z * 0.00065) * 0.065, 0, 1);
    const alpineHeight = height + (0.5 - temperature) * 230;
    const snow = smoothstep(1080, 1390, alpineHeight + this.variation.noise(x * 0.002, z * 0.002) * 65);
    const highland = smoothstep(650, 1010, alpineHeight) * (1 - snow);
    const lowland = 1 - smoothstep(650, 1010, alpineHeight);
    const forest = smoothstep(0.43, 0.69, moisture) * smoothstep(0.16, 0.4, temperature);
    const steppe = 1 - smoothstep(0.29, 0.61, moisture);
    const meadow = Math.max(0.025, 1 - Math.max(forest, steppe));
    const sum = meadow + forest + steppe;
    out.temperature = temperature;
    out.moisture = moisture;
    out.weights[0] = meadow / sum * lowland;
    out.weights[1] = forest / sum * lowland;
    out.weights[2] = steppe / sum * lowland;
    out.weights[3] = highland;
    out.weights[4] = snow;
    out.dominant = 0;
    for (let i = 1; i < 5; i++) if (out.weights[i]! > out.weights[out.dominant]!) out.dominant = i as BiomeId;
    out.rock = clamp(smoothstep(0.25, 0.59, slope) + highland * 0.34 + snow * smoothstep(0.18, 0.48, slope), 0, 1);
    out.snow = snow * (1 - smoothstep(0.34, 0.7, slope));
    return out;
  }

  /** Linear-light macro albedo; small-scale texture is added by the renderer. */
  color(x: number, z: number, sample: ClimateSample, out: Float32Array, offset: number): void {
    const broad = this.variation.fbm(x * 0.0018, z * 0.0018, 3);
    const patch = this.variation.fbm(x * 0.0065 + 11, z * 0.0065 - 7, 2);
    const variation = 1 + broad * 0.26 + patch * 0.1;
    const w = sample.weights;
    let r = (w[0] * 0.13 + w[1] * 0.065 + w[2] * 0.33 + w[3] * 0.215 + w[4] * 0.79) * variation;
    let g = (w[0] * 0.225 + w[1] * 0.14 + w[2] * 0.26 + w[3] * 0.23 + w[4] * 0.84) * variation;
    let b = (w[0] * 0.065 + w[1] * 0.07 + w[2] * 0.11 + w[3] * 0.17 + w[4] * 0.89) * variation;
    // Forest floor: duff / needle patches under the canopy, not a flat green sheet.
    const duff = smoothstep(0.05, 0.55, patch) * w[1] * 0.55;
    r += (0.16 - r) * duff;
    g += (0.125 - g) * duff;
    b += (0.075 - b) * duff;
    // Steppe: cured grass mottling.
    const dry = smoothstep(-0.1, 0.5, broad) * w[2] * 0.35;
    r += (0.38 - r) * dry;
    g += (0.3 - g) * dry;
    b += (0.13 - b) * dry;
    const strata = this.variation.noise(x * 0.024, z * 0.009) * 0.035;
    const rock = sample.rock * (1 - sample.snow);
    r += (0.265 + strata - r) * rock;
    g += (0.275 + strata - g) * rock;
    b += (0.265 + strata - b) * rock;
    out[offset] = clamp(r, 0, 1);
    out[offset + 1] = clamp(g, 0, 1);
    out[offset + 2] = clamp(b, 0, 1);
  }
}
