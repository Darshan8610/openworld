import type { BiomeId } from '../world/biomes';
import { clamp01 } from './types';
import type { AmbienceZone, ZoneWeights } from './types';

/**
 * Ambience zones.
 *
 * A zone is a looping bed, not a one-shot: wind at altitude, foliage rustle in
 * cover, a thin ridge howl, and the quiet "hush" of open or night air. The mix is
 * derived from data the simulation already owns — biome, altitude, time of day
 * and the player's wind setting — so a sheltered meadow never sounds like a
 * summit. Nothing here invents wildlife: every bed is moving air or moving cover.
 */

export interface AmbienceInput {
  readonly biome: BiomeId;
  /** Metres above sea level. */
  readonly altitude: number;
  /** World clock, hours 0..24. */
  readonly hour: number;
  /** The vegetation wind toggle; off means still air. */
  readonly windEnabled: boolean;
  /** Sheltered interior (Phase 7) or dense cover reduces exposure. */
  readonly sheltered?: boolean;
}

/** Per-biome cover and exposure, 0..1. */
const BIOME_PROFILE: Record<BiomeId, { cover: number; exposure: number }> = {
  0: { cover: 0.55, exposure: 0.35 }, // valley meadows
  1: { cover: 0.95, exposure: 0.3 },  // conifer highlands
  2: { cover: 0.25, exposure: 0.7 },  // golden steppe
  3: { cover: 0.15, exposure: 0.85 }, // alpine tundra
  4: { cover: 0.05, exposure: 1 },    // snowline peaks
};

/** Night factor: 1 at midnight, 0 through the middle of the day. */
export function nightFactor(hour: number): number {
  const wrapped = ((hour % 24) + 24) % 24;
  const distanceFromNoon = Math.abs(wrapped - 12);
  // 0 at 12:00, 1 at 00:00, with a soft dusk/dawn shoulder.
  return clamp01((distanceFromNoon - 4) / 8);
}

/** Altitude exposure: nothing below 900 m, fully exposed by ~2200 m. */
export function altitudeExposure(altitude: number): number {
  return clamp01((altitude - 900) / 1300);
}

export function ambienceWeights(input: AmbienceInput): ZoneWeights {
  if (!input.windEnabled) return { wind: 0, foliage: 0, ridge: 0, hush: 1 };
  const profile = BIOME_PROFILE[input.biome] ?? BIOME_PROFILE[0];
  const night = nightFactor(input.hour);
  const exposed = clamp01(profile.exposure * 0.6 + altitudeExposure(input.altitude) * 0.7);
  const cover = input.sheltered ? 0 : profile.cover;
  // Air is always moving a little; night air is calmer.
  const wind = clamp01((0.22 + exposed * 0.78) * (1 - night * 0.35));
  const foliage = clamp01(cover * (0.55 + 0.45 * wind) * (1 - night * 0.25));
  const ridge = clamp01((exposed - 0.45) * 1.8 * (1 - night * 0.2));
  const hush = clamp01(0.25 + night * 0.6 + (1 - cover) * 0.2 - exposed * 0.15);
  return { wind, foliage, ridge, hush };
}

/**
 * Move `current` towards `target` at a bounded rate, so zone changes cross-fade
 * instead of stepping audibly when a biome boundary is crossed.
 */
export function smoothWeights(
  current: ZoneWeights,
  target: ZoneWeights,
  dt: number,
  secondsToFull = 2.5,
): ZoneWeights {
  const step = Number.isFinite(dt) && dt > 0 ? dt / Math.max(0.1, secondsToFull) : 1;
  const blend = (a: number, b: number): number => {
    const delta = b - a;
    if (Math.abs(delta) <= step) return b;
    return a + Math.sign(delta) * step;
  };
  return {
    wind: blend(current.wind, target.wind),
    foliage: blend(current.foliage, target.foliage),
    ridge: blend(current.ridge, target.ridge),
    hush: blend(current.hush, target.hush),
  };
}

export const ZERO_WEIGHTS: ZoneWeights = { wind: 0, foliage: 0, ridge: 0, hush: 0 };

/** The loudest zone, for diagnostics and captioning. */
export function dominantZone(weights: ZoneWeights): AmbienceZone {
  let best: AmbienceZone = 'wind';
  let bestValue = -1;
  for (const zone of ['wind', 'foliage', 'ridge', 'hush'] as const) {
    if (weights[zone] > bestValue) { bestValue = weights[zone]; best = zone; }
  }
  return best;
}
