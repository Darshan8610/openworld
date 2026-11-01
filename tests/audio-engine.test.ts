import { describe, expect, it } from 'vitest';
import { WebAudioEngine } from '../src/audio/engine';
import type { AudioBufferLike, AudioContextLike, AudioNodeLike, AudioParamLike, FilterNodeLike, GainNodeLike, PannerNodeLike, SourceNodeLike } from '../src/audio/engine';
import { VoiceMixer } from '../src/audio/mixer';
import { RECIPES } from '../src/audio/recipes';

/** A minimal recording stand-in for the parts of Web Audio the engine uses. */
class FakeParam implements AudioParamLike {
  value = 0;
  readonly calls: { method: string; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) { this.value = value; this.calls.push({ method: 'set', value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.value = value; this.calls.push({ method: 'ramp', value, time }); return this; }
  setTargetAtTime(value: number, time: number) { this.value = value; this.calls.push({ method: 'target', value, time }); return this; }
  cancelScheduledValues(time: number) { this.calls.push({ method: 'cancel', value: 0, time }); return this; }
}

class FakeNode implements AudioNodeLike {
  readonly connected: AudioNodeLike[] = [];
  disconnected = 0;
  connect(destination: AudioNodeLike) { this.connected.push(destination); return destination; }
  disconnect() { this.disconnected += 1; }
}

class FakeGain extends FakeNode implements GainNodeLike { readonly gain = new FakeParam(); }
class FakeFilter extends FakeNode implements FilterNodeLike {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}
class FakePanner extends FakeNode implements PannerNodeLike { readonly pan = new FakeParam(); }

class FakeSource extends FakeNode implements SourceNodeLike {
  playbackRate = new FakeParam();
  frequency = new FakeParam();
  type = 'sine';
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  start(when = 0) { this.startedAt = when; }
  stop(when = 0) { this.stoppedAt = when; }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = 'suspended';
  sampleRate = 8000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly filters: FakeFilter[] = [];
  readonly panners: FakePanner[] = [];
  readonly oscillators: FakeSource[] = [];
  readonly bufferSources: FakeSource[] = [];
  readonly buffers: AudioBufferLike[] = [];
  compressor = new FakeNode();
  createDynamicsCompressor: (() => AudioNodeLike) | undefined = () => this.compressor;
  resumeCount = 0;
  suspendCount = 0;
  closeCount = 0;

  resume() { this.resumeCount += 1; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.suspendCount += 1; this.state = 'suspended'; return Promise.resolve(); }
  close() { this.closeCount += 1; this.state = 'closed'; return Promise.resolve(); }
  createGain() { const node = new FakeGain(); this.gains.push(node); return node; }
  createBiquadFilter() { const node = new FakeFilter(); this.filters.push(node); return node; }
  createStereoPanner() { const node = new FakePanner(); this.panners.push(node); return node; }
  createOscillator() { const node = new FakeSource(); this.oscillators.push(node); return node; }
  createBufferSource() { const node = new FakeSource(); this.bufferSources.push(node); return node; }
  createBuffer(_channels: number, length: number): AudioBufferLike {
    const data = new Float32Array(length);
    const buffer = { getChannelData: () => data };
    this.buffers.push(buffer);
    return buffer;
  }
}

describe('Web Audio engine', () => {
  it('degrades to a silent no-op without an AudioContext', async () => {
    const engine = new WebAudioEngine({ context: null });
    expect(engine.available).toBe(false);
    expect(engine.state).toBe('unavailable');
    expect(engine.play({ sound: 'ui-click', gain: 1, pan: 0, rate: 1 })).toBe(false);
    expect(engine.stats()).toMatchObject({ state: 'unavailable', voices: 0, ambienceBeds: 0 });
    await engine.resume();
    expect(() => engine.dispose()).not.toThrow();
    expect(engine.available).toBe(false);
  });

  it('builds a master → compressor → destination graph with three buses', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context, beds: true });
    expect(engine.available).toBe(true);
    // master + three bus gains, plus four bed gains.
    expect(context.gains).toHaveLength(8);
    expect(context.compressor.connected).toContain(context.destination);
    expect(context.gains[0]!.connected[0]).toBe(context.compressor);
    for (const bus of context.gains.slice(1, 4)) expect(bus.connected[0]).toBe(context.gains[0]);
    expect(context.buffers).toHaveLength(1); // one shared noise buffer
    expect(engine.stats().ambienceBeds).toBe(4);
    expect(context.bufferSources).toHaveLength(4);
  });

  it('survives a context without a compressor', () => {
    const context = new FakeContext();
    context.createDynamicsCompressor = undefined;
    const engine = new WebAudioEngine({ context });
    expect(context.gains[0]!.connected[0]).toBe(context.destination);
    expect(engine.available).toBe(true);
  });

  it('renders one source per recipe layer with the requested pan and rate', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context });
    const layers = RECIPES['object-door'].layers.length;
    expect(engine.play({ sound: 'object-door', gain: 0.5, pan: -0.4, rate: 1 })).toBe(true);

    const sources = [...context.oscillators, ...context.bufferSources];
    expect(sources).toHaveLength(layers);
    for (const source of sources) expect(source.startedAt).not.toBeNull();
    expect(context.panners.at(-1)!.pan.value).toBeCloseTo(-0.4, 5);
    expect(context.panners).toHaveLength(layers);
    expect(engine.stats().voices).toBe(1);
  });

  it('clamps pan, rate and gain instead of trusting the caller', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context });
    expect(engine.play({ sound: 'ui-click', gain: 4, pan: 9, rate: 40 })).toBe(true);
    for (const panner of context.panners) expect(panner.pan.value).toBe(1);
    for (const oscillator of context.oscillators) {
      expect(oscillator.frequency.value).toBeLessThan(8000 * 2);
    }
    expect(engine.play({ sound: 'ui-click', gain: 0, pan: 0, rate: 1 })).toBe(false);
  });

  it('honours the voice budget and reports drops', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context, mixer: new VoiceMixer({ maxVoices: 1 }) });
    expect(engine.play({ sound: 'step-grass', gain: 0.4, pan: 0, rate: 1 })).toBe(true);
    expect(engine.play({ sound: 'step-grass', gain: 0.4, pan: 0, rate: 1 })).toBe(false);
    expect(engine.stats()).toMatchObject({ voices: 1, capacity: 1, dropped: 1 });
  });

  it('applies bus gains and mute as ramps, not jumps', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context });
    engine.setBusGains({ master: 0.25, ambience: 0.2, effects: 0.4, ui: 0.6 });
    for (const bus of context.gains.slice(1, 4)) {
      expect(bus.gain.calls.at(-1)!.method).toBe('target');
    }
    expect(context.gains[1]!.gain.value).toBeCloseTo(0.2, 5);
    // The master slider drives the master node, not just a stored number.
    expect(context.gains[0]!.gain.value).toBeCloseTo(0.25, 5);

    engine.setMuted(true);
    expect(engine.isMuted).toBe(true);
    expect(context.gains[0]!.gain.value).toBe(0);
    engine.setMuted(false);
    expect(context.gains[0]!.gain.value).toBeCloseTo(0.25, 5);
  });

  it('cross-fades ambience beds towards the zone weights', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context });
    expect(engine.stats().ambienceBeds).toBe(0);

    engine.setZoneWeights({ wind: 1, foliage: 0, ridge: 0.5, hush: 0 });
    expect(engine.stats().ambienceBeds).toBe(4);
    expect(engine.stats().zones).toEqual({ wind: 1, foliage: 0, ridge: 0.5, hush: 0 });
    const bedGains = context.gains.slice(4);
    expect(bedGains).toHaveLength(4);
    expect(bedGains[0]!.gain.value).toBeGreaterThan(0);
    expect(bedGains[1]!.gain.value).toBe(0);
    // Beds loop; one-shots do not.
    for (const source of context.bufferSources) expect((source as unknown as { loop: boolean }).loop).toBe(true);
  });

  it('stops voices on stopAll without touching the beds', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context, beds: true });
    engine.play({ sound: 'npc-greet', gain: 0.8, pan: 0.2, rate: 1 });
    const oneShotSources = context.oscillators.concat(context.bufferSources.slice(4));
    expect(oneShotSources.length).toBe(RECIPES['npc-greet'].layers.length);

    engine.stopAll();
    expect(engine.stats().voices).toBe(0);
    expect(engine.stats().ambienceBeds).toBe(4);
    for (const source of oneShotSources) expect(source.stoppedAt).not.toBeNull();
  });

  it('closes the context once and becomes inert on dispose', () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context, beds: true });
    engine.play({ sound: 'ui-confirm', gain: 1, pan: 0, rate: 1 });
    engine.dispose();
    engine.dispose();

    expect(context.closeCount).toBe(1);
    expect(engine.state).toBe('closed');
    expect(engine.available).toBe(false);
    expect(engine.play({ sound: 'ui-click', gain: 1, pan: 0, rate: 1 })).toBe(false);
    for (const source of context.bufferSources) expect(source.stoppedAt).not.toBeNull();
  });

  it('resumes and suspends through the context, ignoring a closed one', async () => {
    const context = new FakeContext();
    const engine = new WebAudioEngine({ context });
    expect(engine.state).toBe('suspended');
    await engine.resume();
    expect(context.resumeCount).toBe(1);
    expect(engine.state).toBe('running');
    await engine.suspend();
    expect(context.suspendCount).toBe(1);
    expect(engine.state).toBe('suspended');

    engine.dispose();
    await engine.resume();
    expect(context.resumeCount).toBe(1);
  });
});
