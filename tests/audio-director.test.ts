import { describe, expect, it } from 'vitest';
import { AudioDirector } from '../src/audio/director';
import type { AudioFrame } from '../src/audio/director';
import { DEFAULT_AUDIO_SETTINGS } from '../src/audio/types';
import type { AudioEngine, AudioPlayRequest, AudioStats, MixBus, ZoneWeights } from '../src/audio/types';
import { busGains } from '../src/audio/mixer';
import { GameEventBus } from '../src/core/events';

class StubEngine implements AudioEngine {
  readonly plays: AudioPlayRequest[] = [];
  lastGains: Record<string, number> | null = null;
  muted = false;
  zones: ZoneWeights = { wind: 0, foliage: 0, ridge: 0, hush: 0 };
  disposed = false;
  available = true;
  state = 'running' as const;

  play(request: AudioPlayRequest): boolean { this.plays.push(request); return true; }
  setBusGains(gains: Readonly<Record<'master' | MixBus, number>>): void { this.lastGains = { ...gains }; }
  setMuted(muted: boolean): void { this.muted = muted; }
  setZoneWeights(weights: ZoneWeights): void { this.zones = { ...weights }; }
  stopAll(): void { this.plays.length = 0; }
  stats(): AudioStats {
    return { state: 'running', voices: 0, capacity: 24, dropped: 0, ambienceBeds: 4, zones: this.zones };
  }
  resume(): Promise<void> { return Promise.resolve(); }
  suspend(): Promise<void> { return Promise.resolve(); }
  dispose(): void { this.disposed = true; }

  sounds(): string[] { return this.plays.map((play) => play.sound); }
}

const frame = (overrides: Partial<AudioFrame> = {}): AudioFrame => ({
  player: { x: 0, y: 0, z: 0 },
  yaw: 0,
  speed: 0,
  verticalSpeed: 0,
  grounded: true,
  stance: 'stand',
  swimming: false,
  surface: 'grass',
  biome: 0,
  altitude: 200,
  hour: 12,
  windEnabled: true,
  ...overrides,
});

const build = (options: {
  captions?: boolean;
  locate?: (id: string) => { x: number; y: number; z: number } | undefined;
} = {}) => {
  const engine = new StubEngine();
  const events = new GameEventBus();
  const captions: { text: string; pan: number }[] = [];
  const director = new AudioDirector({
    engine,
    events,
    settings: { ...DEFAULT_AUDIO_SETTINGS, captions: options.captions ?? true },
    locate: options.locate,
    onCaption: (text, pan) => captions.push({ text, pan }),
  });
  return { engine, events, captions, director };
};

describe('audio director', () => {
  it('pushes the mix into the engine as soon as it is built', () => {
    const { engine, director } = build();
    expect(engine.lastGains).toEqual(busGains(DEFAULT_AUDIO_SETTINGS));
    expect(engine.muted).toBe(false);
    director.setSettings({ ...DEFAULT_AUDIO_SETTINGS, master: 0.5 });
    expect(engine.lastGains!.master).toBeCloseTo(0.5, 5);
    director.setSettings({ ...DEFAULT_AUDIO_SETTINGS, master: 0.5, muted: true });
    expect(engine.lastGains!.master).toBe(0);
    expect(engine.muted).toBe(true);
  });

  it('plays centred UI sounds without distance attenuation', () => {
    const { engine, director } = build();
    director.update(0.1, frame());
    director.ui('click');
    director.ui('hover');
    expect(engine.plays.at(-2)).toMatchObject({ sound: 'ui-click', pan: 0, gain: 0.8 });
    expect(engine.plays.at(-1)!.gain).toBeLessThan(0.8);
  });

  it('spatialises object interactions and captions them', () => {
    const { engine, events, captions, director } = build({ locate: () => ({ x: 6, y: 0, z: 0 }) });
    director.update(0.1, frame({ yaw: 0 }));
    events.emit('object:interacted', { id: 'gate-1', archetype: 'access-gate', action: 'open', label: 'Gate', actor: 'player' });
    const play = engine.plays.at(-1)!;
    expect(play.sound).toBe('object-door');
    expect(play.pan).toBeGreaterThan(0.5); // to the player's right
    expect(play.gain).toBeGreaterThan(0);
    expect(captions[0]).toMatchObject({ text: 'Gate opens' });
  });

  it('drops sounds that are out of earshot and centres unresolved ids', () => {
    const far = build({ locate: () => ({ x: 400, y: 0, z: 0 }) });
    far.director.update(0.1, frame());
    far.events.emit('object:interacted', { id: 'gate-1', archetype: 'access-gate', action: 'open', label: 'Gate', actor: 'player' });
    expect(far.engine.plays).toHaveLength(0);

    const unknown = build();
    unknown.director.update(0.1, frame());
    unknown.events.emit('object:interacted', { id: 'crate-9', archetype: 'supply-crate', action: 'collect', label: 'Crate', actor: 'player' });
    expect(unknown.engine.plays.at(-1)).toMatchObject({ sound: 'item-pickup', pan: 0 });
  });

  it('voices NPC conversations and honours the caption preference', () => {
    const withCaptions = build({ locate: () => ({ x: 0, y: 0, z: -3 }) });
    withCaptions.director.update(0.1, frame());
    withCaptions.events.emit('npc:talkStarted', { id: 'npc-1', label: 'Keeper' });
    withCaptions.events.emit('npc:talkEnded', { id: 'npc-1', reason: 'player' });
    expect(withCaptions.engine.sounds()).toEqual(['npc-greet', 'npc-farewell']);
    expect(withCaptions.captions.map((c) => c.text)).toEqual(['Someone greets you']);

    const silent = build({ captions: false });
    silent.director.update(0.1, frame());
    silent.events.emit('npc:talkStarted', { id: 'npc-1', label: 'Keeper' });
    expect(silent.engine.sounds()).toEqual(['npc-greet']);
    expect(silent.captions).toHaveLength(0);
  });

  it('does not spam captions faster than the cooldown', () => {
    const { engine, events, captions, director } = build();
    director.update(0.1, frame());
    events.emit('npc:topicSelected', { id: 'npc-1', topic: 'weather', line: 'Cold.' });
    events.emit('npc:topicSelected', { id: 'npc-1', topic: 'road', line: 'North.' });
    expect(engine.sounds().filter((s) => s === 'npc-reply')).toHaveLength(2);
    expect(captions).toHaveLength(1);
  });

  it('derives footsteps from movement, on the surface underfoot', () => {
    const { engine, director } = build();
    for (let i = 0; i < 20; i++) director.update(0.1, frame({ speed: 2, stance: 'walk', surface: 'gravel' }));
    const steps = engine.sounds().filter((s) => s === 'step-gravel');
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(director.stepCount).toBeGreaterThanOrEqual(2);
    // Footsteps are deliberately never captioned.
    expect(engine.plays[0]!.pan).toBe(0);
  });

  it('stops stepping while paused and resumes cleanly', () => {
    const { engine, director } = build();
    director.update(0.5, frame({ speed: 3, stance: 'sprint' }));
    director.setPaused(true);
    expect(director.isPaused).toBe(true);
    const before = engine.plays.length;
    for (let i = 0; i < 20; i++) director.update(0.1, frame({ speed: 3, stance: 'sprint' }));
    expect(engine.plays).toHaveLength(before);
    director.setPaused(false);
    expect(director.isPaused).toBe(false);
  });

  it('resamples ambience at 4 Hz and cross-fades towards the new zone', () => {
    const { engine, director } = build();
    director.update(0.1, frame({ biome: 1, altitude: 200, hour: 12 }));
    expect(engine.zones).toEqual({ wind: 0, foliage: 0, ridge: 0, hush: 0 }); // < 0.25 s elapsed
    for (let i = 0; i < 5; i++) director.update(0.1, frame({ biome: 1, altitude: 200, hour: 12 }));
    expect(engine.zones.foliage).toBeGreaterThan(0);
    expect(director.zoneWeights.foliage).toBeGreaterThan(0);

    // Night in the open with wind disabled must collapse towards hush.
    for (let i = 0; i < 60; i++) director.update(0.1, frame({ biome: 3, altitude: 500, hour: 1, windEnabled: false }));
    expect(director.zoneWeights.hush).toBeGreaterThan(0.9);
    expect(engine.sounds()).toContain('ambience-transition');
  });

  it('unsubscribes from game events on dispose', () => {
    const { engine, events, director } = build();
    director.dispose();
    events.emit('npc:talkStarted', { id: 'npc-1', label: 'Keeper' });
    events.emit('object:interacted', { id: 'gate-1', archetype: 'access-gate', action: 'open', label: 'Gate', actor: 'player' });
    expect(engine.plays).toHaveLength(0);
  });
});
