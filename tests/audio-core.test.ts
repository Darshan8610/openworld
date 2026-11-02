import { describe, expect, it } from 'vitest';
import { busGains, VoiceMixer } from '../src/audio/mixer';
import { footstepSoundFor, interactionSoundFor, RECIPES } from '../src/audio/recipes';
import { SOUND_IDS, DEFAULT_AUDIO_SETTINGS } from '../src/audio/types';
import type { AmbienceZone, ZoneWeights } from '../src/audio/types';
import { altitudeExposure, ambienceWeights, dominantZone, smoothWeights } from '../src/audio/zones';
import { FootstepDriver } from '../src/audio/footsteps';
import type { FootstepState } from '../src/audio/footsteps';
import { SURFACE_KINDS } from '../src/physics/surfaces';

const voice = (overrides: Partial<Parameters<VoiceMixer['request']>[0]> = {}) => ({
  sound: 'step-grass' as const,
  bus: 'effects' as const,
  priority: 2,
  gain: 0.5,
  duration: 5,
  ...overrides,
});

describe('audio mixing policy', () => {
  it('scales every bus by the master gain and honours mute and ducking', () => {
    const gains = busGains(DEFAULT_AUDIO_SETTINGS);
    expect(gains.master).toBeCloseTo(0.8, 5);
    expect(gains.effects).toBeCloseTo(0.9, 5);

    expect(busGains({ ...DEFAULT_AUDIO_SETTINGS, muted: true }).master).toBe(0);
    expect(busGains(DEFAULT_AUDIO_SETTINGS, 0.5).master).toBeCloseTo(0.4, 5);
    // Out-of-range values are clamped rather than trusted.
    expect(busGains({ ...DEFAULT_AUDIO_SETTINGS, master: 4, effects: -2 }).master).toBe(1);
    expect(busGains({ ...DEFAULT_AUDIO_SETTINGS, effects: -2 }).effects).toBe(0);
  });

  it('admits voices up to the global cap and then refuses quietly', () => {
    const mixer = new VoiceMixer({ maxVoices: 2 });
    expect(mixer.request(voice(), 0).admitted).toBe(true);
    expect(mixer.request(voice(), 0).admitted).toBe(true);
    const third = mixer.request(voice({ gain: 0.2 }), 0);
    expect(third.admitted).toBe(false);
    expect(mixer.droppedCount).toBe(1);
    expect(mixer.active).toHaveLength(2);
  });

  it('never exceeds a per-bus cap even with headroom overall', () => {
    const mixer = new VoiceMixer({ maxVoices: 8, busVoices: { ambience: 1, effects: 8, ui: 2 } });
    expect(mixer.request(voice({ bus: 'ambience', sound: 'ambience-transition' }), 0).admitted).toBe(true);
    const second = mixer.request(voice({ bus: 'ambience', sound: 'ambience-transition' }), 0);
    expect(second.admitted).toBe(false);
    expect(mixer.counts()).toEqual({ ambience: 1, effects: 0, ui: 0 });
  });

  it('steals a lower-priority voice but not a louder equal-priority one', () => {
    const mixer = new VoiceMixer({ maxVoices: 1 });
    const first = mixer.request(voice({ priority: 1, gain: 0.9 }), 0);
    expect(first.admitted).toBe(true);

    const louderButSame = mixer.request(voice({ priority: 1, gain: 0.2 }), 0.1);
    expect(louderButSame.admitted).toBe(false);

    const important = mixer.request(voice({ priority: 6, gain: 0.5 }), 0.2);
    expect(important.admitted).toBe(true);
    expect(important.stolen).toBe(first.id);
    expect(mixer.active).toHaveLength(1);
  });

  it('prunes finished voices and ignores silent requests', () => {
    const mixer = new VoiceMixer({ maxVoices: 4 });
    expect(mixer.request(voice({ gain: 0 }), 0).admitted).toBe(false);
    mixer.request(voice({ duration: 0.5 }), 0);
    expect(mixer.active).toHaveLength(1);
    mixer.prune(1);
    expect(mixer.active).toHaveLength(0);
  });
});

describe('audio recipes', () => {
  it('defines a playable recipe for every sound id, with sane envelopes', () => {
    for (const sound of SOUND_IDS) {
      const recipe = RECIPES[sound];
      expect(recipe, sound).toBeDefined();
      expect(recipe.duration).toBeGreaterThan(0);
      expect(recipe.layers.length).toBeGreaterThan(0);
      expect(['ambience', 'effects', 'ui']).toContain(recipe.bus);
      expect(recipe.priority).toBeGreaterThanOrEqual(1);
      expect(recipe.priority).toBeLessThanOrEqual(8);
      for (const layer of recipe.layers) {
        expect(layer.gain).toBeGreaterThan(0);
        expect(layer.gain).toBeLessThanOrEqual(1);
        expect(layer.attack).toBeGreaterThan(0);
        expect(layer.decay).toBeGreaterThan(layer.attack);
        if (layer.source === 'tone') expect(layer.frequency ?? layer.glideTo).toBeGreaterThan(20);
      }
    }
  });

  it('maps every physical surface to a footstep sound', () => {
    for (const surface of SURFACE_KINDS) {
      const sound = footstepSoundFor(surface);
      expect(RECIPES[sound], surface).toBeDefined();
    }
    expect(footstepSoundFor('snow')).toBe('step-snow');
    expect(footstepSoundFor('metal')).toBe('step-metal');
    expect(footstepSoundFor('gravel')).toBe('step-gravel');
  });

  it('maps interactions to mechanical sounds and collects to pickups', () => {
    expect(interactionSoundFor('access-gate', 'open')).toBe('object-door');
    expect(interactionSoundFor('service-valve', 'turn')).toBe('object-valve');
    expect(interactionSoundFor('supply-crate', 'collect')).toBe('item-pickup');
    expect(interactionSoundFor('unknown-archetype', 'toggle')).toBe('object-switch');
  });
});

describe('ambience zones', () => {
  const base = { biome: 0 as const, altitude: 400, hour: 12, windEnabled: true };

  it('is silent air when wind is off, keeping only the room tone', () => {
    expect(ambienceWeights({ ...base, windEnabled: false })).toEqual({ wind: 0, foliage: 0, ridge: 0, hush: 1 });
  });

  it('gives cover more foliage than open high ground', () => {
    const forest = ambienceWeights({ ...base, biome: 1 });
    const tundra = ambienceWeights({ ...base, biome: 3 });
    expect(forest.foliage).toBeGreaterThan(tundra.foliage);
    expect(tundra.wind).toBeGreaterThan(forest.wind);
  });

  it('raises wind and ridge howl with altitude', () => {
    const low = ambienceWeights({ ...base, biome: 2, altitude: 300 });
    const high = ambienceWeights({ ...base, biome: 2, altitude: 2600 });
    expect(high.wind).toBeGreaterThan(low.wind);
    expect(high.ridge).toBeGreaterThan(low.ridge);
    expect(altitudeExposure(3200)).toBe(1);
  });

  it('quiets the air and raises the hush at night', () => {
    const noon = ambienceWeights({ ...base, hour: 12 });
    const night = ambienceWeights({ ...base, hour: 1 });
    expect(night.hush).toBeGreaterThan(noon.hush);
    expect(night.wind).toBeLessThan(noon.wind);
  });

  it('cross-fades towards a target without jumping', () => {
    const from: ZoneWeights = { wind: 0, foliage: 0, ridge: 0, hush: 0 };
    const to: ZoneWeights = { wind: 1, foliage: 1, ridge: 1, hush: 1 };
    const step = smoothWeights(from, to, 0.5, 2.5);
    expect(step.wind).toBeCloseTo(0.2, 5);
    let current = from;
    for (let i = 0; i < 40; i++) current = smoothWeights(current, to, 0.25, 2.5);
    expect(current).toEqual(to);
    expect(['wind', 'foliage', 'ridge', 'hush']).toContain(dominantZone(current));
    expect(dominantZone({ wind: 0, foliage: 0, ridge: 0, hush: 0.9 } as Record<AmbienceZone, number>)).toBe('hush');
  });
});

describe('footstep cadence', () => {
  const state = (overrides: Partial<FootstepState> = {}): FootstepState => ({
    position: { x: 0, y: 0, z: 0 },
    speed: 1.4,
    verticalSpeed: 0,
    grounded: true,
    stance: 'walk',
    swimming: false,
    surface: 'grass',
    ...overrides,
  });

  it('does not step while standing still', () => {
    const driver = new FootstepDriver();
    const events = driver.update(0.5, state({ speed: 0 }));
    expect(events).toHaveLength(0);
  });

  it('steps once per stride distance, not once per frame', () => {
    const driver = new FootstepDriver({ stride: 1 });
    let steps = 0;
    for (let i = 0; i < 120; i++) steps += driver.update(1 / 120, state({ speed: 2 })).filter((e) => e.kind === 'step').length;
    // Two metres per second for one second at a one-metre stride.
    expect(steps).toBeGreaterThanOrEqual(1);
    expect(steps).toBeLessThanOrEqual(3);
    expect(driver.stepCount).toBe(steps);
  });

  it('uses the surface it is actually standing on', () => {
    const driver = new FootstepDriver({ stride: 0.2 });
    const events = driver.update(0.3, state({ speed: 1.5, surface: 'snow' }));
    expect(events[0]).toMatchObject({ kind: 'step', sound: 'step-snow', surface: 'snow' });
  });

  it('is quieter when crouched and resets in the air', () => {
    const crouched = new FootstepDriver({ stride: 0.2 }).update(0.4, state({ speed: 1.5, stance: 'crouch' }));
    const running = new FootstepDriver({ stride: 0.2 }).update(0.4, state({ speed: 1.5, stance: 'sprint' }));
    expect(crouched[0]!.gain).toBeLessThan(running[0]!.gain);

    const driver = new FootstepDriver({ stride: 0.2 });
    driver.update(0.1, state({ speed: 1.5 }));
    const airborne = driver.update(0.4, state({ grounded: false, speed: 3 }));
    expect(airborne.filter((e) => e.kind === 'step')).toHaveLength(0);
  });

  it('reports soft and hard landings from the impact speed', () => {
    const soft = new FootstepDriver();
    soft.update(0.1, state({ grounded: false, verticalSpeed: -2 }));
    const softLanding = soft.update(0.1, state({ grounded: true, verticalSpeed: -2 }));
    expect(softLanding.find((e) => e.kind === 'land')?.sound).toBe('land-soft');

    const hard = new FootstepDriver();
    hard.update(0.1, state({ grounded: false, verticalSpeed: -8 }));
    const hardLanding = hard.update(0.1, state({ grounded: true, verticalSpeed: -8 }));
    expect(hardLanding.find((e) => e.kind === 'land')?.sound).toBe('land-hard');
    expect(hardLanding[0]!.gain).toBeGreaterThan(softLanding[0]!.gain);
  });

  it('splashes while swimming instead of stepping', () => {
    const driver = new FootstepDriver({ stride: 0.5 });
    const events = driver.update(0.5, state({ swimming: true, speed: 2, surface: 'water' }));
    expect(events[0]).toMatchObject({ kind: 'splash', sound: 'step-water' });
  });
});
