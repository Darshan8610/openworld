import { CONFIG } from '../config';
import { hashSeed, seededRandom } from '../utils/random';
import { clamp, lerp, smoothstep } from '../utils/math';
import { SimplexNoise } from '../world/noise';

/**
 * Phase 9 weather controller.
 *
 * Weather is a *field*, not a global switch: a seeded front moves through
 * canonical world space, so two places 20 km apart can see different weather at
 * the same moment, and the local state eases toward its target instead of
 * snapping. The controller owns numbers only — light, fog, water, particles,
 * surface wetness and audio all read `state` and this file never touches a
 * renderer, so it is fully unit-testable.
 *
 * Snow versus rain is decided from the local climate temperature (the same
 * `BiomeField` the terrain uses) plus a night-time cooling term, which is why a
 * storm on a snowline peak arrives as a blizzard while the valleys below get rain.
 */

export type WeatherKind =
  | 'clear' | 'partly-cloudy' | 'cloudy' | 'overcast'
  | 'rain' | 'heavy-rain' | 'storm' | 'fog' | 'snow' | 'blizzard' | 'windy';

export interface WeatherState {
  kind: WeatherKind;
  label: string;
  /** 0..1 cloud cover and density driving the sky. */
  cloudCoverage: number;
  cloudDensity: number;
  cloudSpeed: number;
  /** Multipliers applied to the sun and the ambient light. */
  sunScale: number;
  ambientScale: number;
  /** Multiplier applied to the far fog distance. */
  fogScale: number;
  /** Precipitation intensity 0..1 (one of the two is non-zero). */
  rain: number;
  snow: number;
  /** Metres per second. */
  windSpeed: number;
  /** Radians; direction the wind blows *toward*. */
  windDirection: number;
  /** 0..1 ground wetness and snow accumulation. */
  wetness: number;
  snowCover: number;
  /** Wave activity multiplier for the water surface (1 = calm). */
  seaState: number;
  /** 0..1 how strongly the front is expressing itself (for audio/presentation). */
  intensity: number;
}

export function createWeatherState(): WeatherState {
  return {
    kind: 'clear', label: 'Clear',
    cloudCoverage: 0.28, cloudDensity: 0.4, cloudSpeed: 1,
    sunScale: 1, ambientScale: 1, fogScale: 1,
    rain: 0, snow: 0, windSpeed: 2.4, windDirection: 0.6,
    wetness: 0, snowCover: 0, seaState: 1, intensity: 0,
  };
}

export const WEATHER_LABELS: Record<WeatherKind, string> = {
  clear: 'Clear', 'partly-cloudy': 'Partly cloudy', cloudy: 'Cloudy', overcast: 'Overcast',
  rain: 'Rain', 'heavy-rain': 'Heavy rain', storm: 'Thunderstorm', fog: 'Fog',
  snow: 'Snow', blizzard: 'Blizzard', windy: 'Windy',
};

export interface WeatherSample {
  /** Climate temperature at the player, 0..1 (BiomeField convention). */
  temperature: number;
  /** Climate moisture at the player, 0..1. */
  moisture: number;
  /** Altitude in metres, used for the rain-to-snow transition. */
  height: number;
}

export interface WeatherOptions {
  /** Overrides the generated front (still eased); `null` returns to the front. */
  override?: WeatherKind | null;
}

const KINDS_BY_INTENSITY: readonly [number, WeatherKind][] = [
  [-0.42, 'clear'],
  [-0.16, 'partly-cloudy'],
  [0.08, 'cloudy'],
  [0.3, 'overcast'],
  [0.5, 'rain'],
  [0.68, 'heavy-rain'],
  [1.01, 'storm'],
];

export class WeatherSystem {
  readonly state: WeatherState = createWeatherState();
  private readonly target: WeatherState = createWeatherState();
  private readonly front: SimplexNoise;
  private readonly gustNoise: SimplexNoise;
  private readonly fogNoise: SimplexNoise;
  private readonly phase: number;
  private override: WeatherKind | null = null;
  /** Seconds since the controller started; drives the advecting front. */
  private elapsed = 0;
  private lastTemperature = 0.6;
  private lastHeight = 400;

  constructor(public readonly seed: string, options: WeatherOptions = {}) {
    const hash = hashSeed(seed);
    this.front = new SimplexNoise(hash ^ 0x2f1e3d4c);
    this.gustNoise = new SimplexNoise(hash ^ 0x7a3b19c5);
    this.fogNoise = new SimplexNoise(hash ^ 0x51ab77e3);
    this.phase = seededRandom(hash ^ 0x1d872b41)() * 1000;
    this.override = options.override ?? null;
  }

  /** Force a weather kind (developer/settings/URL); `null` restores the front. */
  setOverride(kind: WeatherKind | null): void { this.override = kind; }
  get overridden(): WeatherKind | null { return this.override; }

  get kind(): WeatherKind { return this.state.kind; }
  get label(): string { return this.state.label; }

  /**
   * Advance the front and ease the local state. `hour` is the sky clock,
   * `sample` the local climate. Returns the state (same object, mutated).
   */
  update(dt: number, hour: number, x: number, z: number, sample: WeatherSample): WeatherState {
    this.elapsed += dt;
    this.lastTemperature = sample.temperature;
    this.lastHeight = sample.height;
    this.computeTarget(hour, x, z, sample);
    this.ease(dt);
    return this.state;
  }

  /** Evaluate the front without easing — the weather a place is heading toward. */
  sampleTarget(hour: number, x: number, z: number, sample: WeatherSample): WeatherState {
    const previous = this.target.kind;
    this.computeTarget(hour, x, z, sample);
    const copy = { ...this.target };
    this.target.kind = previous;
    return copy;
  }

  private computeTarget(hour: number, x: number, z: number, sample: WeatherSample): void {
    const t = this.elapsed / CONFIG.weather.secondsPerCycle;
    // Two advecting fields: the front itself and a slower moisture bias.
    const drift = t * 0.35;
    const front = this.front.fbm(x * 0.000055 + drift, z * 0.000055 - drift * 0.7, 3);
    const moistureBias = (sample.moisture - 0.5) * 0.9;
    const altitudeBias = smoothstep(700, 1500, sample.height) * 0.22;
    let severity = clamp(front * 1.25 + moistureBias + altitudeBias, -1, 1);
    // Night air is calmer and clears from below; midday fronts build faster.
    const dayFactor = 0.5 - 0.5 * Math.cos((hour - 3) / 24 * Math.PI * 2);
    severity = severity * lerp(0.82, 1.12, dayFactor);

    const fogField = this.fogNoise.fbm(x * 0.00014 - drift * 0.5, z * 0.00014, 2);
    const gust = this.gustNoise.fbm(x * 0.0009 + this.phase, z * 0.0009 - this.phase, 2);

    let kind: WeatherKind = 'clear';
    for (const [limit, candidate] of KINDS_BY_INTENSITY) {
      if (severity < limit) { kind = candidate; break; }
    }
    // Dense, still, cold morning air: radiation fog in valleys.
    if (fogField > 0.42 && severity > -0.2 && severity < 0.34 && dayFactor < 0.3) kind = 'fog';

    // Rain becomes snow when the local air is cold enough, or high enough.
    const chilly = sample.temperature < CONFIG.weather.snowTemperature || sample.height > 1250;
    if (chilly) {
      if (kind === 'rain') kind = 'snow';
      else if (kind === 'heavy-rain') kind = 'snow';
      else if (kind === 'storm') kind = 'blizzard';
    }
    const windSpeed = clamp(
      CONFIG.weather.windSpeed[0] + (CONFIG.weather.windSpeed[1] - CONFIG.weather.windSpeed[0])
      * clamp((severity + 0.6) / 1.6, 0, 1) + gust * 2.4,
      CONFIG.weather.windSpeed[0], CONFIG.weather.windSpeed[1],
    );
    if (kind === 'clear' && windSpeed > 12.5) kind = 'windy';
    if (this.override) kind = this.override;

    const intensity = clamp((severity + 0.42) / 1.42, 0, 1);
    const rain = kind === 'rain' ? 0.45 : kind === 'heavy-rain' ? 0.8 : kind === 'storm' ? 1 : 0;
    const snow = kind === 'snow' ? 0.5 : kind === 'blizzard' ? 1 : 0;
    this.target.kind = kind;
    this.target.label = WEATHER_LABELS[kind];
    this.target.intensity = intensity;
    this.target.cloudCoverage = clamp(
      kind === 'clear' ? 0.16 + gust * 0.06
        : kind === 'partly-cloudy' ? 0.42
          : kind === 'windy' ? 0.5
            : kind === 'fog' ? 0.7
              : kind === 'snow' ? 0.86
                : 0.92,
      0, 1,
    );
    this.target.cloudDensity = clamp(
      kind === 'clear' ? 0.3
        : kind === 'partly-cloudy' ? 0.5
          : kind === 'fog' ? 0.75
            : 0.72 + intensity * 0.28,
      0, 1,
    );
    this.target.cloudSpeed = clamp(0.6 + windSpeed * 0.22, 0.6, 4);
    this.target.rain = rain;
    this.target.snow = snow;
    this.target.sunScale = clamp(1 - this.target.cloudCoverage * 0.72 - rain * 0.35 - snow * 0.22, 0.12, 1);
    this.target.ambientScale = clamp(0.85 + this.target.cloudCoverage * 0.45, 0.7, 1.45);
    this.target.fogScale = clamp(
      kind === 'fog' ? 0.18
        : kind === 'blizzard' ? 0.3
          : kind === 'heavy-rain' ? 0.55
            : kind === 'storm' ? 0.58
              : kind === 'rain' ? 0.72
                : kind === 'snow' ? 0.66
                  : kind === 'overcast' ? 0.9 : 1,
      0.12, 1,
    );
    this.target.windSpeed = windSpeed;
    this.target.windDirection = Math.atan2(
      this.gustNoise.noise(x * 0.0002 + this.phase, z * 0.0002),
      this.front.noise(x * 0.0002, z * 0.0002 + this.phase),
    );
    this.target.seaState = clamp(
      0.45 + windSpeed / 14 + (kind === 'storm' || kind === 'blizzard' ? 0.5 : 0),
      0.35, 1.6,
    );
  }

  private ease(dt: number): void {
    // Exponential approach: half-life in seconds, independent of frame rate.
    const rate = 1 - Math.exp(-dt * Math.LN2 / CONFIG.weather.transitionHalfLife);
    const s = this.state, t = this.target;
    s.cloudCoverage = lerp(s.cloudCoverage, t.cloudCoverage, rate);
    s.cloudDensity = lerp(s.cloudDensity, t.cloudDensity, rate);
    s.cloudSpeed = lerp(s.cloudSpeed, t.cloudSpeed, rate);
    s.sunScale = lerp(s.sunScale, t.sunScale, rate);
    s.ambientScale = lerp(s.ambientScale, t.ambientScale, rate);
    s.fogScale = lerp(s.fogScale, t.fogScale, rate);
    s.rain = lerp(s.rain, t.rain, rate);
    s.snow = lerp(s.snow, t.snow, rate);
    s.windSpeed = lerp(s.windSpeed, t.windSpeed, rate);
    s.seaState = lerp(s.seaState, t.seaState, rate);
    s.intensity = lerp(s.intensity, t.intensity, rate);
    // Direction wraps, so ease the shortest arc instead of through north.
    let delta = t.windDirection - s.windDirection;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    s.windDirection += delta * rate;

    // Ground state accumulates and dries out; it never snaps.
    const raining = t.rain > 0.02 || t.kind === 'fog';
    s.wetness = clamp(
      raining
        ? s.wetness + CONFIG.weather.rainWetnessRate * t.rain * dt
        : s.wetness - CONFIG.weather.dryWetnessRate * dt * (0.5 + 0.5 * Math.max(0, t.sunScale)),
      0, 1,
    );
    const freezing = t.snow > 0.02;
    if (freezing) {
      s.snowCover = clamp(s.snowCover + CONFIG.weather.snowCoverRate * t.snow * dt, 0, 1);
    } else {
      // Melt slower at night and at altitude, faster in warm daylight.
      const melt = CONFIG.weather.snowMeltRate * dt * (0.4 + 0.6 * Math.max(0, t.sunScale))
        * clamp(1.4 - this.lastTemperature, 0.2, 1.4);
      s.snowCover = clamp(s.snowCover - melt, 0, 1);
    }
    s.kind = t.kind;
    s.label = t.label;
  }

  /** Wind velocity vector in world XZ (m/s). */
  windVector(out = { x: 0, z: 0 }): { x: number; z: number } {
    out.x = Math.cos(this.state.windDirection) * this.state.windSpeed;
    out.z = Math.sin(this.state.windDirection) * this.state.windSpeed;
    return out;
  }

  /** Diagnostics snapshot (HUD/tests). */
  snapshot(): WeatherState & { overridden: WeatherKind | null; temperature: number; height: number } {
    return { ...this.state, overridden: this.override, temperature: this.lastTemperature, height: this.lastHeight };
  }
}
