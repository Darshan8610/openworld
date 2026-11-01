import type { SurfaceKind } from '../physics/surfaces';
import type { MixBus, SoundId } from './types';

/**
 * Procedural sound recipes.
 *
 * Every sound in Wayfarer is synthesised from noise and oscillators, so the
 * repository ships no audio assets and every sample is generated at runtime.
 * A recipe is data: a bus, a duration, a priority and one or more layers. The
 * engine turns layers into `BufferSource`/`Oscillator` nodes with filter and
 * gain envelopes; the mixer never sees node graphs.
 */

export interface FilterRecipe {
  readonly type: BiquadFilterType;
  readonly frequency: number;
  readonly q: number;
  /** Filter frequency at the end of the layer (sweeps if present). */
  readonly sweepTo?: number;
}

export interface LayerRecipe {
  readonly source: 'noise' | 'tone';
  /** Tone waveform; ignored by noise layers. */
  readonly waveform?: OscillatorType;
  /** Tone frequency in Hz. */
  readonly frequency?: number;
  /** Tone pitch at the end of the layer. */
  readonly glideTo?: number;
  readonly filter?: FilterRecipe;
  /** Peak gain of the layer, 0..1. */
  readonly gain: number;
  /** Seconds to reach peak gain. */
  readonly attack: number;
  /** Seconds from the start of the layer until it is silent. */
  readonly decay: number;
  /** Seconds before the layer starts. */
  readonly delay?: number;
}

export interface VoiceRecipe {
  readonly bus: MixBus;
  readonly duration: number;
  readonly priority: number;
  readonly layers: readonly LayerRecipe[];
  /** Random playback-rate deviation applied by the engine (±fraction). */
  readonly jitter: number;
}

const NOISE = (gain: number, frequency: number, q = 0.8, type: BiquadFilterType = 'bandpass'): LayerRecipe => ({
  source: 'noise', gain, attack: 0.004, decay: 0.11, filter: { type, frequency, q },
});

export const RECIPES: Readonly<Record<SoundId, VoiceRecipe>> = {
  /* ---- footsteps: one physical gesture per surface ------------------------ */
  'step-grass': { bus: 'effects', duration: 0.16, priority: 2, jitter: 0.12, layers: [
    NOISE(0.32, 780, 0.9, 'lowpass'),
    NOISE(0.14, 2600, 1.6),
  ] },
  'step-gravel': { bus: 'effects', duration: 0.2, priority: 2, jitter: 0.14, layers: [
    NOISE(0.36, 2100, 1.1),
    { source: 'noise', gain: 0.16, attack: 0.002, decay: 0.06, delay: 0.035, filter: { type: 'bandpass', frequency: 3600, q: 1.2 } },
  ] },
  'step-rock': { bus: 'effects', duration: 0.13, priority: 2, jitter: 0.1, layers: [
    NOISE(0.34, 1250, 1.4),
    { source: 'tone', waveform: 'triangle', frequency: 190, glideTo: 120, gain: 0.1, attack: 0.002, decay: 0.07 },
  ] },
  'step-snow': { bus: 'effects', duration: 0.26, priority: 2, jitter: 0.1, layers: [
    { source: 'noise', gain: 0.26, attack: 0.02, decay: 0.24, filter: { type: 'lowpass', frequency: 620, q: 0.7 } },
  ] },
  'step-hard': { bus: 'effects', duration: 0.12, priority: 2, jitter: 0.08, layers: [
    NOISE(0.3, 1750, 1.5),
    { source: 'tone', waveform: 'square', frequency: 140, glideTo: 90, gain: 0.06, attack: 0.001, decay: 0.05 },
  ] },
  'step-wood': { bus: 'effects', duration: 0.18, priority: 2, jitter: 0.1, layers: [
    NOISE(0.24, 640, 1.0),
    { source: 'tone', waveform: 'triangle', frequency: 210, glideTo: 150, gain: 0.12, attack: 0.003, decay: 0.12 },
  ] },
  'step-metal': { bus: 'effects', duration: 0.3, priority: 2, jitter: 0.06, layers: [
    NOISE(0.22, 3200, 1.8),
    { source: 'tone', waveform: 'sine', frequency: 1180, glideTo: 980, gain: 0.09, attack: 0.002, decay: 0.26 },
  ] },
  'step-water': { bus: 'effects', duration: 0.34, priority: 3, jitter: 0.15, layers: [
    { source: 'noise', gain: 0.3, attack: 0.01, decay: 0.3, filter: { type: 'bandpass', frequency: 1500, q: 0.6, sweepTo: 500 } },
  ] },

  /* ---- landings: weight, not a footstep ---------------------------------- */
  'land-soft': { bus: 'effects', duration: 0.3, priority: 4, jitter: 0.08, layers: [
    { source: 'noise', gain: 0.36, attack: 0.006, decay: 0.26, filter: { type: 'lowpass', frequency: 520, q: 0.8 } },
    { source: 'tone', waveform: 'sine', frequency: 96, glideTo: 58, gain: 0.14, attack: 0.004, decay: 0.2 },
  ] },
  'land-hard': { bus: 'effects', duration: 0.34, priority: 5, jitter: 0.06, layers: [
    { source: 'noise', gain: 0.42, attack: 0.004, decay: 0.3, filter: { type: 'bandpass', frequency: 900, q: 0.7 } },
    { source: 'tone', waveform: 'triangle', frequency: 120, glideTo: 62, gain: 0.18, attack: 0.003, decay: 0.26 },
  ] },

  /* ---- interface ---------------------------------------------------------- */
  'ui-click': { bus: 'ui', duration: 0.07, priority: 6, jitter: 0.02, layers: [
    { source: 'tone', waveform: 'sine', frequency: 640, glideTo: 520, gain: 0.16, attack: 0.001, decay: 0.06 },
  ] },
  'ui-hover': { bus: 'ui', duration: 0.05, priority: 1, jitter: 0.02, layers: [
    { source: 'tone', waveform: 'sine', frequency: 880, gain: 0.05, attack: 0.001, decay: 0.04 },
  ] },
  'ui-confirm': { bus: 'ui', duration: 0.24, priority: 6, jitter: 0.01, layers: [
    { source: 'tone', waveform: 'sine', frequency: 520, gain: 0.14, attack: 0.005, decay: 0.2 },
    { source: 'tone', waveform: 'sine', frequency: 780, gain: 0.1, attack: 0.005, decay: 0.18, delay: 0.06 },
  ] },
  'ui-back': { bus: 'ui', duration: 0.2, priority: 6, jitter: 0.01, layers: [
    { source: 'tone', waveform: 'sine', frequency: 420, glideTo: 300, gain: 0.12, attack: 0.004, decay: 0.16 },
  ] },
  'ui-error': { bus: 'ui', duration: 0.32, priority: 7, jitter: 0, layers: [
    { source: 'tone', waveform: 'triangle', frequency: 300, glideTo: 210, gain: 0.14, attack: 0.004, decay: 0.14 },
    { source: 'tone', waveform: 'triangle', frequency: 240, glideTo: 180, gain: 0.12, attack: 0.004, decay: 0.16, delay: 0.12 },
  ] },

  /* ---- world objects: mechanical, not musical ----------------------------- */
  'object-door': { bus: 'effects', duration: 0.62, priority: 4, jitter: 0.05, layers: [
    { source: 'noise', gain: 0.28, attack: 0.01, decay: 0.55, filter: { type: 'bandpass', frequency: 420, q: 1.6, sweepTo: 260 } },
    { source: 'tone', waveform: 'sawtooth', frequency: 120, glideTo: 86, gain: 0.08, attack: 0.02, decay: 0.5 },
  ] },
  'object-container': { bus: 'effects', duration: 0.34, priority: 3, jitter: 0.06, layers: [
    NOISE(0.3, 950, 1.2),
    { source: 'tone', waveform: 'triangle', frequency: 240, glideTo: 160, gain: 0.1, attack: 0.004, decay: 0.24 },
  ] },
  'object-switch': { bus: 'effects', duration: 0.12, priority: 3, jitter: 0.04, layers: [
    NOISE(0.28, 2600, 1.6),
    { source: 'tone', waveform: 'square', frequency: 700, glideTo: 420, gain: 0.07, attack: 0.001, decay: 0.08 },
  ] },
  'object-valve': { bus: 'effects', duration: 0.42, priority: 3, jitter: 0.05, layers: [
    { source: 'noise', gain: 0.24, attack: 0.02, decay: 0.38, filter: { type: 'bandpass', frequency: 1200, q: 2.4, sweepTo: 760 } },
  ] },
  'object-lamp': { bus: 'effects', duration: 0.5, priority: 3, jitter: 0.04, layers: [
    { source: 'tone', waveform: 'sine', frequency: 420, glideTo: 660, gain: 0.1, attack: 0.02, decay: 0.44 },
    NOISE(0.08, 4200, 1.2),
  ] },

  /* ---- pickups ------------------------------------------------------------ */
  'item-pickup': { bus: 'effects', duration: 0.26, priority: 4, jitter: 0.02, layers: [
    { source: 'tone', waveform: 'sine', frequency: 660, gain: 0.12, attack: 0.004, decay: 0.12 },
    { source: 'tone', waveform: 'sine', frequency: 990, gain: 0.09, attack: 0.004, decay: 0.16, delay: 0.07 },
  ] },
  'item-drop': { bus: 'effects', duration: 0.18, priority: 3, jitter: 0.04, layers: [
    { source: 'noise', gain: 0.2, attack: 0.003, decay: 0.15, filter: { type: 'lowpass', frequency: 800, q: 0.9 } },
  ] },

  /* ---- people: short, non-verbal acknowledgements ------------------------- */
  'npc-greet': { bus: 'effects', duration: 0.3, priority: 4, jitter: 0.03, layers: [
    { source: 'tone', waveform: 'sine', frequency: 330, glideTo: 440, gain: 0.12, attack: 0.02, decay: 0.24 },
  ] },
  'npc-reply': { bus: 'effects', duration: 0.16, priority: 3, jitter: 0.05, layers: [
    { source: 'tone', waveform: 'sine', frequency: 392, glideTo: 523, gain: 0.09, attack: 0.01, decay: 0.13 },
  ] },
  'npc-farewell': { bus: 'effects', duration: 0.28, priority: 3, jitter: 0.03, layers: [
    { source: 'tone', waveform: 'sine', frequency: 392, glideTo: 294, gain: 0.1, attack: 0.015, decay: 0.24 },
  ] },

  /* ---- ambience transitions ---------------------------------------------- */
  'ambience-transition': { bus: 'ambience', duration: 1.6, priority: 1, jitter: 0, layers: [
    { source: 'noise', gain: 0.1, attack: 0.4, decay: 1.5, filter: { type: 'lowpass', frequency: 700, q: 0.6, sweepTo: 340 } },
  ] },
};

/** The step sound for a physical surface; every kind maps to something audible. */
export function footstepSoundFor(surface: SurfaceKind): SoundId {
  switch (surface) {
    case 'grass': case 'soil': case 'sand': case 'fabric': return 'step-grass';
    case 'gravel': return 'step-gravel';
    case 'rock': case 'ice': return 'step-rock';
    case 'snow': return 'step-snow';
    case 'asphalt': case 'concrete': case 'glass': case 'rubber': return 'step-hard';
    case 'wood': return 'step-wood';
    case 'metal': return 'step-metal';
    case 'water': return 'step-water';
    default: return 'step-hard';
  }
}

/**
 * World-object archetype → sound. Keys come from `src/objects/archetypes.ts`;
 * an unknown archetype falls back to the generic switch click rather than
 * inventing a sound per object.
 */
const ARCHETYPE_SOUNDS: Readonly<Record<string, SoundId>> = {
  'supply-crate': 'object-container',
  'ration-box': 'object-container',
  'medical-case': 'object-container',
  'fuel-drum': 'object-container',
  'tool-roll': 'item-pickup',
  'parts-bin': 'item-pickup',
  'water-flask': 'item-pickup',
  'lantern-cell': 'item-pickup',
  'survey-post': 'item-pickup',
  'access-gate': 'object-door',
  'rest-bench': 'step-wood',
  'trail-sign': 'object-switch',
  'field-lamp': 'object-lamp',
  'utility-switch': 'object-switch',
  'service-valve': 'object-valve',
  'signal-lever': 'object-switch',
};

/** Interaction/action → world sound. `collect` always sounds like a pickup. */
export function interactionSoundFor(archetype: string, action: string): SoundId {
  if (action === 'collect' || action === 'take') return 'item-pickup';
  return ARCHETYPE_SOUNDS[archetype] ?? 'object-switch';
}
