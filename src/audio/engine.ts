import { RECIPES } from './recipes';
import { VoiceMixer } from './mixer';
import type { VoiceRequest } from './mixer';
import { ZERO_WEIGHTS } from './zones';
import type {
  AmbienceZone, AudioBus, AudioEngine, AudioPlayRequest, AudioState, AudioStats, MixBus, ZoneWeights,
} from './types';

/**
 * Web Audio engine.
 *
 * Responsibilities: build the bus graph once, render procedural recipes into
 * nodes, respect the mixer's voice budget, and cross-fade the four ambience beds.
 * There are no audio files: noise comes from a shared generated buffer and tones
 * from oscillators, so the game ships no samples and no licences.
 *
 * Autoplay policy: the context starts suspended and is resumed from a user
 * gesture (`resume()` is a no-op elsewhere). If Web Audio is missing or blocked,
 * `available` is false and every call is a safe no-op — audio never breaks the
 * game, and the UI explains it.
 */

/* -------------------------------------------------------------------------- */
/* Structural Web Audio surface (kept minimal so tests can fake it)            */
/* -------------------------------------------------------------------------- */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(value: number, time: number, constant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike { connect(destination: AudioNodeLike): unknown; disconnect(): void }
export interface GainNodeLike extends AudioNodeLike { gain: AudioParamLike }
export interface FilterNodeLike extends AudioNodeLike { type: string; frequency: AudioParamLike; Q: AudioParamLike }
export interface PannerNodeLike extends AudioNodeLike { pan: AudioParamLike }
export interface SourceNodeLike extends AudioNodeLike {
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
  playbackRate?: AudioParamLike;
  frequency?: AudioParamLike;
  type?: string;
  buffer?: unknown;
  onended?: (() => void) | null;
}
export interface AudioBufferLike { getChannelData(channel: number): Float32Array }
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  readonly sampleRate: number;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainNodeLike;
  createBiquadFilter(): FilterNodeLike;
  createStereoPanner(): PannerNodeLike;
  createOscillator(): SourceNodeLike;
  createBufferSource(): SourceNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createDynamicsCompressor?(): AudioNodeLike;
}

/** Continuous vehicle loop channels (Phase 10 telemetry → Phase 12 audio). */
export type VehicleLoopId = 'engine' | 'tyre' | 'rotor' | 'wind';
export interface VehicleLoopSignal { readonly gain: number; readonly pitch: number }
export type VehicleLoopChannels = Partial<Record<VehicleLoopId, VehicleLoopSignal>>;
const VEHICLE_LOOPS: Readonly<Record<VehicleLoopId, { level: number; baseHz: number; filterHz: number; q: number; filterType: 'lowpass' | 'bandpass' }>> = {
  engine: { level: 0.42, baseHz: 80, filterHz: 700, q: 1.2, filterType: 'lowpass' },
  tyre: { level: 0.3, baseHz: 1, filterHz: 1100, q: 0.9, filterType: 'bandpass' },
  rotor: { level: 0.38, baseHz: 1, filterHz: 460, q: 0.8, filterType: 'lowpass' },
  wind: { level: 0.2, baseHz: 1, filterHz: 700, q: 0.7, filterType: 'bandpass' },
};

export interface AudioEngineOptions {
  /** Inject a context (tests); otherwise the engine creates one. */
  readonly context?: AudioContextLike | null;
  /** Lazy factory used when no context is injected. */
  readonly contextFactory?: () => AudioContextLike | null;
  readonly mixer?: VoiceMixer;
  /** Create the four ambience beds eagerly (default: on first weights update). */
  readonly beds?: boolean;
}

interface ActiveVoice {
  readonly sources: SourceNodeLike[];
  readonly nodes: AudioNodeLike[];
}
interface VehicleLoopVoice {
  readonly sources: SourceNodeLike[];
  readonly nodes: AudioNodeLike[];
  readonly gain: GainNodeLike;
  readonly osc?: SourceNodeLike;
  readonly filter?: FilterNodeLike;
  readonly noise?: SourceNodeLike;
}

const ZONE_BEDS: Readonly<Record<AmbienceZone, { filter: BiquadFilterType; frequency: number; q: number; gain: number }>> = {
  wind: { filter: 'lowpass', frequency: 480, q: 0.6, gain: 0.22 },
  foliage: { filter: 'bandpass', frequency: 2600, q: 0.7, gain: 0.15 },
  ridge: { filter: 'bandpass', frequency: 900, q: 2.2, gain: 0.1 },
  hush: { filter: 'lowpass', frequency: 240, q: 0.5, gain: 0.08 },
};

export class WebAudioEngine implements AudioEngine {
  private readonly context: AudioContextLike | null;
  private readonly mixer: VoiceMixer;
  private readonly master: GainNodeLike | null;
  private readonly buses = new Map<MixBus, GainNodeLike>();
  private readonly voices = new Map<number, ActiveVoice>();
  private readonly beds = new Map<AmbienceZone, { source: SourceNodeLike; gain: GainNodeLike }>();
  private readonly vehicleLoops = new Map<VehicleLoopId, VehicleLoopVoice>();
  private readonly noise: AudioBufferLike | null = null;
  private zoneWeights: ZoneWeights = ZERO_WEIGHTS;
  private gains: Record<MixBus, number> = { ambience: 0.7, effects: 0.9, ui: 0.6 };
  private muted = false;
  /** Master volume slider, applied to the master node (mute overrides it). */
  private masterLevel = 1;
  /** Cutscene ducking: multiplies the master while a cinematic plays (1 = none). */
  private duckLevel = 1;
  private closed = false;

  constructor(options: AudioEngineOptions = {}) {
    this.context = options.context ?? (options.contextFactory ?? defaultContextFactory)();
    this.mixer = options.mixer ?? new VoiceMixer();
    if (!this.context) {
      this.master = null;
      return;
    }
    this.master = this.context.createGain();
    this.master.gain.value = 1;
    const compressor = this.context.createDynamicsCompressor?.();
    if (compressor) {
      this.master.connect(compressor);
      compressor.connect(this.context.destination);
    } else {
      this.master.connect(this.context.destination);
    }
    for (const bus of ['ambience', 'effects', 'ui'] as const) {
      const gain = this.context.createGain();
      gain.gain.value = this.gains[bus];
      gain.connect(this.master);
      this.buses.set(bus, gain);
    }
    this.noise = this.createNoise();
    if (options.beds) this.ensureBeds();
  }

  get available(): boolean { return this.context !== null && !this.closed; }

  get state(): AudioState {
    if (!this.context) return 'unavailable';
    if (this.closed) return 'closed';
    return this.context.state === 'running' ? 'running' : 'suspended';
  }

  async resume(): Promise<void> {
    if (!this.context || this.closed) return;
    try {
      if (this.context.state !== 'running') await this.context.resume();
    } catch {
      // A blocked resume is not fatal: the game runs silently.
    }
  }

  async suspend(): Promise<void> {
    if (!this.context || this.closed) return;
    try { await this.context.suspend(); } catch { /* context may already be closed */ }
  }

  play(request: AudioPlayRequest): boolean {
    const context = this.context;
    if (!context || this.closed || !this.master) return false;
    const recipe = RECIPES[request.sound];
    if (!recipe) return false;
    const now = context.currentTime;
    const gain = Math.max(0, Math.min(1, request.gain));
    const rate = Math.max(0.5, Math.min(2, request.rate || 1));
    const voiceRequest: VoiceRequest = {
      sound: request.sound, bus: recipe.bus,
      priority: request.priority ?? recipe.priority,
      gain, duration: recipe.duration / rate,
    };
    const decision = this.mixer.request(voiceRequest, now);
    if (!decision.admitted || decision.id === null) return false;
    if (decision.stolen !== null) this.stopVoice(decision.stolen);

    const bus = this.buses.get(recipe.bus);
    if (!bus) { this.mixer.release(decision.id); return false; }

    const sources: SourceNodeLike[] = [];
    const nodes: AudioNodeLike[] = [];
    const jitter = recipe.jitter > 0 ? 1 + (deriveNoise(decision.id) - 0.5) * 2 * recipe.jitter : 1;

    for (const layer of recipe.layers) {
      const start = now + (layer.delay ?? 0);
      const decay = Math.max(0.02, layer.decay / (rate * jitter));
      const attack = Math.max(0.001, layer.attack);
      const layerGain = context.createGain();
      layerGain.gain.setValueAtTime(0.0001, start);
      layerGain.gain.linearRampToValueAtTime(Math.max(0.0001, layer.gain * gain), start + attack);
      layerGain.gain.setTargetAtTime(0.0001, start + attack, Math.max(0.005, (decay - attack) / 3));

      let source: SourceNodeLike;
      if (layer.source === 'noise' && this.noise) {
        source = context.createBufferSource();
        source.buffer = this.noise;
        source.playbackRate?.setValueAtTime(rate * jitter, start);
      } else {
        source = context.createOscillator();
        const frequency = (layer.frequency ?? 220) * (layer.source === 'tone' ? rate * jitter : 1);
        if (source.frequency) {
          source.frequency.setValueAtTime(frequency, start);
          if (layer.glideTo) source.frequency.linearRampToValueAtTime(layer.glideTo * rate * jitter, start + decay);
        }
        if (layer.waveform) source.type = layer.waveform;
      }

      let tail: AudioNodeLike = layerGain;
      if (layer.filter) {
        const filter = context.createBiquadFilter();
        filter.type = layer.filter.type;
        filter.frequency.setValueAtTime(layer.filter.frequency * Math.min(2, rate), start);
        if (layer.filter.sweepTo) {
          filter.frequency.linearRampToValueAtTime(layer.filter.sweepTo * Math.min(2, rate), start + decay);
        }
        filter.Q.value = layer.filter.q;
        layerGain.connect(filter);
        tail = filter;
        nodes.push(filter);
      }

      // Noise is mono-ish; a stereo panner keeps a source off-centre cheaply.
      const panner = context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, request.pan));
      tail.connect(panner);
      source.connect(layerGain);
      panner.connect(bus);

      source.onended = () => {
        try { source.disconnect(); } catch { /* already disconnected */ }
      };
      sources.push(source);
      nodes.push(layerGain, panner);
      try { source.start(start); source.stop(start + decay + 0.02); } catch { /* a closed context throws */ }
    }

    this.voices.set(decision.id, { sources, nodes });
    return true;
  }

  setBusGains(gains: Readonly<Record<AudioBus, number>>): void {
    this.gains = { ambience: gains.ambience, effects: gains.effects, ui: gains.ui };
    if (typeof gains.master === 'number' && Number.isFinite(gains.master)) {
      this.masterLevel = Math.max(0, Math.min(1, gains.master));
    }
    if (!this.context) return;
    for (const [bus, node] of this.buses) {
      node.gain.setTargetAtTime(this.gains[bus], this.context.currentTime, 0.05);
    }
    this.applyMaster();
  }

  /**
   * Continuous vehicle channels: one looping voice per channel with live
   * gain/pitch (engine = sawtooth through a lowpass; tyre/rotor/wind = looping
   * noise through filters). Voices are created on demand, faded out and
   * retired when silent, so a parked world costs nothing. Gains arrive 0..1
   * from `VehicleAudioHooks`; each channel is scaled by its own level.
   */
  setVehicleLoops(channels: VehicleLoopChannels): void {
    if (!this.context || this.closed) return;
    const now = this.context.currentTime;
    for (const id of ['engine', 'tyre', 'rotor', 'wind'] as const) {
      const signal = channels[id];
      const gain = Math.max(0, Math.min(1, signal?.gain ?? 0));
      const pitch = Math.max(0.5, Math.min(2, signal?.pitch ?? 1));
      const profile = VEHICLE_LOOPS[id];
      let voice = this.vehicleLoops.get(id);
      if (!voice) {
        if (gain <= 0.001) continue;
        voice = this.createVehicleLoop(id);
        if (!voice) continue;
        this.vehicleLoops.set(id, voice);
      }
      if (gain <= 0.001) {
        // Fade out and retire so silence costs no nodes.
        this.vehicleLoops.delete(id);
        voice.gain.gain.setTargetAtTime(0, now, 0.15);
        const stopAt = now + 0.7;
        for (const source of voice.sources) { try { source.stop(stopAt); } catch { /* already stopped */ } }
        voice.sources[0]!.onended = () => {
          for (const source of voice.sources) { try { source.disconnect(); } catch { /* already disconnected */ } }
          for (const node of voice.nodes) { try { node.disconnect(); } catch { /* already disconnected */ } }
        };
        continue;
      }
      voice.gain.gain.setTargetAtTime(gain * profile.level, now, 0.08);
      if (voice.osc?.frequency) voice.osc.frequency.setTargetAtTime(profile.baseHz * pitch, now, 0.06);
      if (voice.filter) voice.filter.frequency.setTargetAtTime(profile.filterHz * pitch, now, 0.06);
      if (voice.noise?.playbackRate) voice.noise.playbackRate.setTargetAtTime(pitch, now, 0.06);
    }
  }

  private createVehicleLoop(id: VehicleLoopId): VehicleLoopVoice | undefined {
    const context = this.context;
    const bus = this.buses.get('effects');
    if (!context || !bus) return undefined;
    const profile = VEHICLE_LOOPS[id];
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(bus);
    const nodes: AudioNodeLike[] = [gain];
    const filter = context.createBiquadFilter();
    filter.type = profile.filterType;
    filter.frequency.value = profile.filterHz;
    filter.Q.value = profile.q;
    nodes.push(filter);
    if (id === 'engine') {
      const osc = context.createOscillator();
      osc.type = 'sawtooth';
      if (osc.frequency) osc.frequency.value = profile.baseHz;
      osc.connect(filter);
      filter.connect(gain);
      try { osc.start(); } catch { /* a closed context throws */ }
      return { sources: [osc], nodes, gain, osc, filter };
    }
    if (!this.noise) { try { gain.disconnect(); } catch { /* already disconnected */ } return undefined; }
    const noise = context.createBufferSource();
    noise.buffer = this.noise;
    (noise as unknown as { loop: boolean }).loop = true;
    if (noise.playbackRate) noise.playbackRate.value = 1;
    noise.connect(filter);
    filter.connect(gain);
    try { noise.start(); } catch { /* a closed context throws */ }
    return { sources: [noise], nodes, gain, filter, noise };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  /** The master node carries mute and the master slider; buses carry their own mix. */
  private applyMaster(): void {
    if (!this.context || !this.master) return;
    const level = this.muted ? 0 : this.masterLevel * this.duckLevel;
    this.master.gain.setTargetAtTime(level, this.context.currentTime, 0.05);
  }

  /** Duck the whole mix for cutscenes/dialogue (1 = untouched, 0 = silent). */
  setDuck(level: number): void {
    if (!Number.isFinite(level)) return;
    this.duckLevel = Math.min(1, Math.max(0, level));
    this.applyMaster();
  }

  get isMuted(): boolean { return this.muted; }

  setZoneWeights(weights: ZoneWeights): void {
    this.zoneWeights = { ...weights };
    if (!this.context || this.closed) return;
    this.ensureBeds();
    const now = this.context.currentTime;
    for (const [zone, bed] of this.beds) {
      const profile = ZONE_BEDS[zone];
      const target = Math.max(0, Math.min(1, weights[zone])) * profile.gain;
      bed.gain.gain.setTargetAtTime(target, now, 0.35);
    }
  }

  /** Stop one-shot voices (conversation, pause, teardown). Beds keep running. */
  stopAll(): void {
    for (const id of [...this.voices.keys()]) this.stopVoice(id);
    this.mixer.clear();
  }

  stats(): AudioStats {
    return {
      state: this.state,
      voices: this.mixer.active.length,
      capacity: this.mixer.capacity,
      dropped: this.mixer.droppedCount,
      ambienceBeds: this.beds.size,
      zones: { ...this.zoneWeights },
    };
  }

  dispose(): void {
    if (this.closed) return;
    this.stopAll();
    for (const voice of this.vehicleLoops.values()) {
      for (const source of voice.sources) { try { source.stop(); source.disconnect(); } catch { /* already stopped */ } }
      for (const node of voice.nodes) { try { node.disconnect(); } catch { /* already disconnected */ } }
    }
    this.vehicleLoops.clear();
    for (const bed of this.beds.values()) {
      try { bed.source.stop(); bed.source.disconnect(); } catch { /* already stopped */ }
      try { bed.gain.disconnect(); } catch { /* already disconnected */ }
    }
    this.beds.clear();
    this.closed = true;
    if (this.context) void this.context.close().catch(() => undefined);
  }

  /* ---- internals ---------------------------------------------------------- */

  private stopVoice(id: number): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    for (const source of voice.sources) {
      try { source.stop(); } catch { /* already stopped */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    for (const node of voice.nodes) {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
    this.voices.delete(id);
    this.mixer.release(id);
  }

  private ensureBeds(): void {
    if (!this.context || this.beds.size > 0 || !this.noise) return;
    for (const zone of ['wind', 'foliage', 'ridge', 'hush'] as const) {
      const profile = ZONE_BEDS[zone];
      const source = this.context.createBufferSource();
      source.buffer = this.noise;
      source as SourceNodeLike & { loop?: boolean };
      const loopable = source as unknown as { loop: boolean };
      loopable.loop = true;
      const filter = this.context.createBiquadFilter();
      filter.type = profile.filter;
      filter.frequency.value = profile.frequency;
      filter.Q.value = profile.q;
      const gain = this.context.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.buses.get('ambience') ?? this.master!);
      try { source.start(); } catch { /* context may be suspended but nodes still schedule */ }
      this.beds.set(zone, { source, gain });
    }
  }

  /** Two seconds of white noise, generated once and shared by every voice. */
  private createNoise(): AudioBufferLike | null {
    if (!this.context) return null;
    try {
      const length = Math.floor(this.context.sampleRate * 2);
      const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
      const data = buffer.getChannelData(0);
      let state = 0x9e3779b9;
      for (let i = 0; i < data.length; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        data[i] = (state / 4294967296) * 2 - 1;
      }
      return buffer;
    } catch {
      return null;
    }
  }
}

/** Deterministic 0..1 value per voice id, used for recipe jitter. */
function deriveNoise(id: number): number {
  const x = Math.sin(id * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function defaultContextFactory(): AudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Constructor) return null;
  try {
    return new Constructor();
  } catch {
    return null;
  }
}
