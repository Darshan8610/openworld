import type { WorldPoint } from '../core/coordinates';

/**
 * Phase 12 audio vocabulary.
 *
 * Everything here is plain data so the mixer, the directors and the settings can
 * be tested headlessly, without a browser, an `AudioContext` or a user gesture.
 * The only browser-specific code lives in `engine.ts`.
 */

/** Buses the player can mix independently. `master` scales all of them. */
export const AUDIO_BUSES = ['master', 'ambience', 'effects', 'ui'] as const;
export type AudioBus = typeof AUDIO_BUSES[number];
/** Buses a sound can be sent to (everything except the master). */
export type MixBus = Exclude<AudioBus, 'master'>;

/** Procedural sound identities. There are no audio files in this repository. */
export const SOUND_IDS = [
  'step-grass', 'step-gravel', 'step-rock', 'step-snow', 'step-hard',
  'step-wood', 'step-metal', 'step-water', 'land-soft', 'land-hard',
  'ui-click', 'ui-hover', 'ui-confirm', 'ui-back', 'ui-error',
  'object-door', 'object-container', 'object-switch', 'object-valve', 'object-lamp',
  'item-pickup', 'item-drop',
  'npc-greet', 'npc-reply', 'npc-farewell',
  'vehicle-impact', 'vehicle-gear', 'vehicle-start', 'vehicle-stop', 'vehicle-splash',
  'ambience-transition',
] as const;
export type SoundId = typeof SOUND_IDS[number];

/** Looping ambience beds, each a filtered noise voice with a slow LFO. */
export const AMBIENCE_ZONES = ['wind', 'foliage', 'ridge', 'hush'] as const;
export type AmbienceZone = typeof AMBIENCE_ZONES[number];
export type ZoneWeights = Record<AmbienceZone, number>;

export type AudioState = 'unavailable' | 'suspended' | 'running' | 'closed';

export interface AudioSettings {
  readonly master: number;
  readonly ambience: number;
  readonly effects: number;
  readonly ui: number;
  readonly muted: boolean;
  /** Show text captions for salient sounds (accessibility). */
  readonly captions: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 0.8, ambience: 0.7, effects: 0.9, ui: 0.6, muted: false, captions: true,
};

/** One request to play a sound. Gains are pre-mixed by the caller (distance, etc.). */
export interface AudioPlayRequest {
  readonly sound: SoundId;
  /** Distance-attenuated caller gain, 0..1. */
  readonly gain: number;
  /** Stereo position, -1 (left) .. 1 (right). */
  readonly pan: number;
  /** Playback-rate multiplier for pitch variation, 0.5..2. */
  readonly rate: number;
  /** Higher wins when the voice budget is full. Defaults to the recipe's. */
  readonly priority?: number;
}

export interface AudioStats {
  readonly state: AudioState;
  /** Voices currently playing. */
  readonly voices: number;
  readonly capacity: number;
  /** Requests rejected because the budget was full. */
  readonly dropped: number;
  readonly ambienceBeds: number;
  readonly zones: ZoneWeights;
}

/**
 * The audio backend. `engine.ts` implements it with Web Audio; tests implement
 * it with a recording stub, and a browser without Web Audio gets a no-op engine.
 */
export interface AudioEngine {
  readonly available: boolean;
  readonly state: AudioState;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  play(request: AudioPlayRequest): boolean;
  setBusGains(gains: Readonly<Record<AudioBus, number>>): void;
  setMuted(muted: boolean): void;
  setZoneWeights(weights: ZoneWeights): void;
  stopAll(): void;
  stats(): AudioStats;
  dispose(): void;
}

/** A listener pose in canonical world space (no Three.js types). */
export interface AudioListener {
  readonly position: WorldPoint;
  /** Camera yaw, radians. 0 looks towards -Z. */
  readonly yaw: number;
}

/**
 * Pan and distance attenuation for a world-space source.
 *
 * `pan` follows the camera's right vector; `gain` is linear distance falloff with
 * a small near-field plateau so a sound next to the player is not deafening.
 */
export function spatialize(
  listener: AudioListener,
  source: WorldPoint,
  maxDistance: number,
): { gain: number; pan: number; distance: number } {
  const dx = source.x - listener.position.x;
  const dz = source.z - listener.position.z;
  const distance = Math.hypot(dx, dz);
  if (distance > maxDistance) return { gain: 0, pan: 0, distance };
  const rightX = Math.cos(listener.yaw);
  const rightZ = -Math.sin(listener.yaw);
  const pan = distance < 0.001 ? 0 : Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / distance));
  const near = 2.5;
  const falloff = distance <= near ? 1 : 1 - (distance - near) / Math.max(0.001, maxDistance - near);
  return { gain: Math.max(0, Math.min(1, falloff * falloff)), pan, distance };
}

/** Clamp helper shared by settings and mixing. */
export const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
