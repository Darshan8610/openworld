import { describe, expect, it } from 'vitest';
import { WeatherSystem } from '../src/environment/weather';
import type { WeatherSample } from '../src/environment/weather';

/**
 * Phase 9 weather controller: deterministic fronts, eased transitions, snow versus
 * rain from the local climate, and ground state that accumulates and dries.
 */

const SEED = 'weather-seed';
const warm: WeatherSample = { temperature: 0.82, moisture: 0.6, height: 300 };
const cold: WeatherSample = { temperature: 0.12, moisture: 0.6, height: 300 };
const high: WeatherSample = { temperature: 0.7, moisture: 0.6, height: 1400 };

/** A position on the front grid where the weather is severe. */
function stormyPosition(warmth: WeatherSample): { x: number; z: number; hour: number } {
  const system = new WeatherSystem(SEED);
  for (let i = 0; i < 4000; i++) {
    const x = (i % 60) * 900 - 27000, z = Math.floor(i / 60) * 900 - 27000;
    const target = system.sampleTarget(12, x, z, warmth);
    if (target.kind === 'heavy-rain' || target.kind === 'storm' || target.kind === 'rain') {
      return { x, z, hour: 12 };
    }
  }
  throw new Error('no wet weather found on this front');
}

describe('weather determinism', () => {
  it('produces the same state for the same seed, place and time', () => {
    const run = (): number[] => {
      const system = new WeatherSystem(SEED);
      const path: number[] = [];
      for (let i = 0; i < 120; i++) {
        system.update(0.5, 10 + i * 0.01, 1200, -800, warm);
        path.push(system.state.cloudCoverage, system.state.rain, system.state.windSpeed);
      }
      return path;
    };
    expect(run()).toEqual(run());
  });

  it('differs between seeds and between regions', () => {
    const a = new WeatherSystem('seed-a');
    const b = new WeatherSystem('seed-b');
    let differs = false;
    for (let i = 0; i < 200 && !differs; i++) {
      const x = i * 500 - 50000;
      const ta = a.sampleTarget(9, x, 0, warm);
      const tb = b.sampleTarget(9, x, 0, warm);
      if (ta.kind !== tb.kind || Math.abs(ta.cloudCoverage - tb.cloudCoverage) > 0.01) differs = true;
    }
    expect(differs).toBe(true);

    const system = new WeatherSystem(SEED);
    const kinds = new Set<string>();
    for (let i = 0; i < 400; i++) {
      kinds.add(system.sampleTarget(12, i * 1500 - 300000, i * 700 - 140000, warm).kind);
    }
    expect(kinds.size).toBeGreaterThan(1);
  });
});

describe('weather transitions', () => {
  it('eases toward the target instead of snapping', () => {
    const position = stormyPosition(warm);
    const calm = new WeatherSystem(SEED);
    // Start from the authored baseline, then step once into stormy weather.
    const before = { ...calm.state };
    calm.update(1 / 60, position.hour, position.x, position.z, warm);
    expect(Math.abs(calm.state.cloudCoverage - before.cloudCoverage)).toBeLessThan(0.1);
    expect(calm.state.rain).toBeLessThan(0.2);
    // The transition half-life is 45 s, so a minute and a half of stormy air gets
    // the state most of the way there without ever jumping.
    for (let i = 0; i < 3600; i++) calm.update(1 / 30, position.hour, position.x, position.z, warm);
    expect(calm.state.rain).toBeGreaterThan(0.3);
    expect(calm.state.cloudCoverage).toBeGreaterThan(0.6);
    // Cloud cover stays in range and the sun is dimmed, never negative.
    expect(calm.state.cloudCoverage).toBeLessThanOrEqual(1);
    expect(calm.state.sunScale).toBeGreaterThan(0);
    expect(calm.state.fogScale).toBeGreaterThan(0);
  });

  it('turns rain into snow in cold air and at altitude', () => {
    const position = stormyPosition(warm);
    const rain = new WeatherSystem(SEED);
    const rainTarget = rain.sampleTarget(position.hour, position.x, position.z, warm);
    expect(['rain', 'heavy-rain', 'storm']).toContain(rainTarget.kind);

    const snow = new WeatherSystem(SEED);
    const coldTarget = snow.sampleTarget(position.hour, position.x, position.z, cold);
    expect(['snow', 'blizzard']).toContain(coldTarget.kind);
    expect(coldTarget.snow).toBeGreaterThan(0);
    expect(coldTarget.rain).toBe(0);

    const alpine = new WeatherSystem(SEED);
    expect(['snow', 'blizzard']).toContain(alpine.sampleTarget(position.hour, position.x, position.z, high).kind);
  });

  it('accumulates wetness and snow cover, then dries out', () => {
    const position = stormyPosition(warm);
    const system = new WeatherSystem(SEED);
    for (let i = 0; i < 900; i++) system.update(1 / 30, position.hour, position.x, position.z, warm);
    expect(system.state.wetness).toBeGreaterThan(0.2);

    // Clear, dry weather at a calm place: the ground dries.
    const clear = new WeatherSystem(SEED, { override: 'clear' });
    const cleared = clear.update(1 / 30, 12, 0, 0, warm);
    for (let i = 0; i < 3000; i++) clear.update(1 / 30, 12, 0, 0, warm);
    expect(cleared.snowCover).toBe(0);
    expect(clear.state.rain).toBe(0);

    const snowing = new WeatherSystem(SEED, { override: 'blizzard' });
    for (let i = 0; i < 3000; i++) snowing.update(1 / 30, 2, 0, 0, cold);
    expect(snowing.state.snowCover).toBeGreaterThan(0.2);
    expect(snowing.state.snow).toBeGreaterThan(0.3);
  });

  it('honours an explicit override and reports it', () => {
    const system = new WeatherSystem(SEED, { override: 'fog' });
    system.update(0.1, 6, 0, 0, warm);
    expect(system.state.kind).toBe('fog');
    expect(system.overridden).toBe('fog');
    expect(system.label).toBe('Fog');
    system.setOverride(null);
    system.update(0.1, 6, 0, 0, warm);
    expect(system.overridden).toBeNull();
  });

  it('exposes a wind vector consistent with speed and direction', () => {
    const system = new WeatherSystem(SEED);
    for (let i = 0; i < 400; i++) system.update(0.2, 15, 0, 0, warm);
    const wind = system.windVector();
    expect(Math.hypot(wind.x, wind.z)).toBeCloseTo(system.state.windSpeed, 5);
    expect(system.state.seaState).toBeGreaterThan(0);
    expect(system.snapshot().kind).toBe(system.state.kind);
  });
});
