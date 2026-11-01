import type { WorldPoint } from '../core/coordinates';
import type { GameEventBus } from '../core/events';
import type { SurfaceKind } from '../physics/surfaces';
import type { BiomeId } from '../world/biomes';
import { FootstepDriver } from './footsteps';
import type { FootstepEvent } from './footsteps';
import { busGains, VoiceMixer } from './mixer';
import type { MixerOptions } from './mixer';
import { interactionSoundFor } from './recipes';
import { ambienceWeights, dominantZone, smoothWeights, ZERO_WEIGHTS } from './zones';
import type { AmbienceInput } from './zones';
import { spatialize } from './types';
import type {
  AudioEngine, AudioPlayRequest, AudioSettings, AudioStats, SoundId, ZoneWeights,
} from './types';

/**
 * Audio director.
 *
 * Turns simulation state and typed game events into audio requests. It owns the
 * policies — cadence, distance attenuation, which events deserve a caption, how
 * fast zones cross-fade — while the engine owns nodes and the mixer owns the
 * voice budget.
 *
 * What is *not* here: engine or weather beds. Vehicles arrive in Phase 10 and
 * weather in Phase 9, so those sources do not exist yet; when they do, they send
 * `AudioPlayRequest`s through the same engine rather than growing this class.
 */

export interface AudioFrame {
  /** Canonical player position (feet). */
  readonly player: WorldPoint;
  /** Camera yaw in radians; 0 looks towards -Z. */
  readonly yaw: number;
  readonly speed: number;
  readonly verticalSpeed: number;
  readonly grounded: boolean;
  readonly stance: string;
  readonly swimming: boolean;
  readonly surface: SurfaceKind;
  readonly biome: BiomeId;
  readonly altitude: number;
  readonly hour: number;
  readonly windEnabled: boolean;
}

export interface AudioDirectorOptions {
  readonly engine: AudioEngine;
  readonly settings: AudioSettings;
  readonly events?: GameEventBus;
  /** Resolve a world id (object, NPC) to a canonical position for panning. */
  readonly locate?: (id: string) => WorldPoint | undefined;
  /** Caption sink; the UI renders and expires them. */
  readonly onCaption?: (text: string, pan: number) => void;
  readonly mixer?: Partial<MixerOptions>;
  readonly footstepStride?: number;
}

/** Salient sounds get a caption. Footsteps deliberately do not (they would spam). */
const CAPTIONS: Partial<Record<SoundId, string>> = {
  'land-hard': 'Hard landing',
  'object-door': 'Gate opens',
  'object-container': 'Container opens',
  'object-switch': 'Switch',
  'object-valve': 'Valve turns',
  'object-lamp': 'Lamp',
  'item-pickup': 'Pickup',
  'npc-greet': 'Someone greets you',
  'npc-reply': 'Reply',
  'npc-farewell': 'Conversation ends',
  'ambience-transition': 'Ambience shifts',
};

const ZONE_CAPTIONS: Record<string, string> = {
  wind: 'Open wind', foliage: 'Leaves rustle', ridge: 'Ridge wind', hush: 'Still air',
};

export class AudioDirector {
  private readonly engine: AudioEngine;
  private readonly steps: FootstepDriver;
  private readonly locate?: (id: string) => WorldPoint | undefined;
  private readonly onCaption?: (text: string, pan: number) => void;
  private readonly unsubscribes: (() => void)[] = [];
  private settings: AudioSettings;
  private weights: ZoneWeights = ZERO_WEIGHTS;
  private zoneTimer = 0;
  private lastZone: string;
  private captionCooldown = 0;
  private paused = false;
  private frame: AudioFrame | null = null;
  private effectDistance = 46;

  constructor(options: AudioDirectorOptions) {
    this.engine = options.engine;
    this.settings = options.settings;
    this.locate = options.locate;
    this.onCaption = options.onCaption;
    this.steps = new FootstepDriver(options.footstepStride ? { stride: options.footstepStride } : {});
    this.lastZone = '';
    this.applySettings();

    const events = options.events;
    if (events) {
      this.unsubscribes.push(
        events.on('object:interacted', ({ id, archetype, action }) => {
          const sound = interactionSoundFor(archetype, action);
          this.playAt(sound, this.locate?.(id));
        }),
        events.on('npc:talkStarted', ({ id }) => this.playAt('npc-greet', this.locate?.(id))),
        events.on('npc:topicSelected', ({ id }) => this.playAt('npc-reply', this.locate?.(id), 0.7)),
        events.on('npc:talkEnded', ({ id }) => this.playAt('npc-farewell', this.locate?.(id), 0.7)),
      );
    }
  }

  /** Controller / diagnostics mixer used before the engine is built. */
  static createMixer(options?: Partial<MixerOptions>): VoiceMixer { return new VoiceMixer(options); }

  get isPaused(): boolean { return this.paused; }
  get zoneWeights(): ZoneWeights { return { ...this.weights }; }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) this.steps.reset();
  }

  setSettings(settings: AudioSettings): void {
    this.settings = settings;
    this.applySettings();
  }

  /** One-shot UI sound; always centred, never distance-attenuated. */
  ui(sound: 'click' | 'hover' | 'confirm' | 'back' | 'error'): void {
    const id: SoundId = `ui-${sound}`;
    this.engine.play({ sound: id, gain: sound === 'hover' ? 0.45 : 0.8, pan: 0, rate: 1 });
  }

  /**
   * Per-frame update. Accepts the render-frame `dt` (clamped) and the current
   * player state; footsteps use it directly, ambience resamples at 4 Hz.
   */
  update(dt: number, frame: AudioFrame): void {
    this.frame = frame;
    if (this.paused || dt <= 0) return;
    const step = Math.min(0.1, dt);

    if (this.captionCooldown > 0) this.captionCooldown = Math.max(0, this.captionCooldown - step);

    for (const event of this.steps.update(step, {
      position: frame.player, speed: frame.speed, verticalSpeed: frame.verticalSpeed,
      grounded: frame.grounded, stance: frame.stance, swimming: frame.swimming, surface: frame.surface,
    })) {
      this.playFootstep(event);
    }

    this.zoneTimer += step;
    if (this.zoneTimer >= 0.25) {
      const weights = ambienceWeights(this.ambienceInput(frame));
      this.weights = smoothWeights(this.weights, weights, this.zoneTimer);
      this.zoneTimer = 0;
      this.engine.setZoneWeights(this.weights);
      const zone = dominantZone(this.weights);
      if (this.lastZone && zone !== this.lastZone) {
        this.caption(ZONE_CAPTIONS[zone] ?? 'Ambience shifts', 0);
        this.engine.play({ sound: 'ambience-transition', gain: 0.5, pan: 0, rate: 1 });
      }
      this.lastZone = zone;
    }
  }

  stats(): AudioStats { return this.engine.stats(); }

  /** Number of steps the cadence driver has produced (diagnostics). */
  get stepCount(): number { return this.steps.stepCount; }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.steps.reset();
  }

  /* ---- internals ---------------------------------------------------------- */

  private applySettings(): void {
    this.engine.setBusGains(busGains(this.settings));
    this.engine.setMuted(this.settings.muted);
  }

  private ambienceInput(frame: AudioFrame): AmbienceInput {
    return {
      biome: frame.biome,
      altitude: frame.altitude,
      hour: frame.hour,
      windEnabled: frame.windEnabled,
    };
  }

  private playFootstep(event: FootstepEvent): void {
    const request: AudioPlayRequest = {
      sound: event.sound, gain: event.gain, pan: 0, rate: event.rate,
    };
    this.engine.play(request);
    if (event.sound === 'land-hard') this.caption('Hard landing', 0);
  }

  private playAt(sound: SoundId, position: WorldPoint | undefined, gainScale = 1): void {
    const frame = this.frame;
    let gain = 0.8 * gainScale;
    let pan = 0;
    if (position && frame) {
      const { gain: falloff, pan: direction } = spatialize(
        { position: frame.player, yaw: frame.yaw }, position, this.effectDistance,
      );
      if (falloff <= 0) return;
      gain *= falloff;
      pan = direction;
    }
    this.engine.play({ sound, gain, pan, rate: 1 });
    this.caption(CAPTIONS[sound] ?? null, pan);
  }

  private caption(text: string | null, pan: number): void {
    if (!text || !this.settings.captions || !this.onCaption) return;
    if (this.captionCooldown > 0) return;
    this.onCaption(text, pan);
    this.captionCooldown = 0.5;
  }
}
