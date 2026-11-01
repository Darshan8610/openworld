import type { AudioBus, AudioSettings, MixBus, SoundId } from './types';
import { AUDIO_BUSES, clamp01 } from './types';

/**
 * Voice budgeting and bus mixing.
 *
 * The mixer is pure bookkeeping: it decides whether a sound is allowed to play,
 * which lower-priority voice (if any) it replaces, and what the effective gain of
 * each bus is. It owns no audio nodes, so the policy is unit-testable in Node and
 * the Web Audio engine stays a thin translation layer.
 */

export interface MixerOptions {
  /** Hard cap on simultaneously playing voices. */
  readonly maxVoices: number;
  /** Per-bus caps; a bus cannot exceed either its cap or `maxVoices`. */
  readonly busVoices: Readonly<Record<MixBus, number>>;
}

export const DEFAULT_MIXER_OPTIONS: MixerOptions = {
  maxVoices: 24,
  busVoices: { ambience: 4, effects: 16, ui: 6 },
};

export interface VoiceRequest {
  readonly sound: SoundId;
  readonly bus: MixBus;
  readonly priority: number;
  /** Caller gain, 0..1 (distance attenuation already applied). */
  readonly gain: number;
  readonly duration: number;
}

export interface VoiceRecord extends VoiceRequest {
  readonly id: number;
  readonly startedAt: number;
  readonly endsAt: number;
}

export interface VoiceDecision {
  readonly admitted: boolean;
  /** Voice that must be stopped to make room, if any. */
  readonly stolen: number | null;
  readonly id: number | null;
}

/** Effective gains for every bus, including `master`. Muted means master = 0. */
export function busGains(settings: AudioSettings, duck = 0): Record<AudioBus, number> {
  const master = settings.muted ? 0 : clamp01(settings.master) * (1 - clamp01(duck));
  return {
    master,
    ambience: clamp01(settings.ambience),
    effects: clamp01(settings.effects),
    ui: clamp01(settings.ui),
  };
}

export class VoiceMixer {
  private readonly voices = new Map<number, VoiceRecord>();
  private readonly options: MixerOptions;
  private nextId = 1;
  private dropped = 0;

  constructor(options: Partial<MixerOptions> = {}) {
    this.options = {
      maxVoices: Math.max(1, options.maxVoices ?? DEFAULT_MIXER_OPTIONS.maxVoices),
      busVoices: { ...DEFAULT_MIXER_OPTIONS.busVoices, ...options.busVoices },
    };
  }

  get active(): readonly VoiceRecord[] { return [...this.voices.values()]; }
  get capacity(): number { return this.options.maxVoices; }
  get droppedCount(): number { return this.dropped; }

  counts(): Record<MixBus, number> {
    const counts: Record<MixBus, number> = { ambience: 0, effects: 0, ui: 0 };
    for (const voice of this.voices.values()) counts[voice.bus] += 1;
    return counts;
  }

  /** Decide whether a request plays, stealing the weakest voice when allowed. */
  request(request: VoiceRequest, now: number): VoiceDecision {
    this.prune(now);
    if (request.gain <= 0.001) return { admitted: false, stolen: null, id: null };

    const busCap = this.options.busVoices[request.bus] ?? this.options.maxVoices;
    const busCount = this.counts()[request.bus];
    const total = this.voices.size;

    if (total < this.options.maxVoices && busCount < busCap) return this.admit(request, now);

    // Candidate to steal: the quietest, then the oldest, lower-priority voice.
    // Cross-bus stealing is only allowed under global pressure; a bus overflow
    // may only displace a voice from the same bus.
    const overBudget = total >= this.options.maxVoices;
    let victim: VoiceRecord | undefined;
    for (const voice of this.voices.values()) {
      if (voice.priority > request.priority) continue;
      if (!overBudget && voice.bus !== request.bus) continue;
      if (!victim) { victim = voice; continue; }
      if (voice.priority < victim.priority) victim = voice;
      else if (voice.priority === victim.priority) {
        if (voice.gain < victim.gain) victim = voice;
        else if (voice.gain === victim.gain && voice.startedAt < victim.startedAt) victim = voice;
      }
    }

    // A same-priority voice is only replaced by a louder request, which keeps
    // a stream of quiet footsteps from cutting a loud interaction.
    if (!victim || (victim.priority === request.priority && victim.gain >= request.gain)) {
      this.dropped += 1;
      return { admitted: false, stolen: null, id: null };
    }

    this.voices.delete(victim.id);
    const decision = this.admit(request, now);
    return { admitted: true, stolen: victim.id, id: decision.id };
  }

  release(id: number): void { this.voices.delete(id); }

  /** Forget voices whose scheduled end has passed. */
  prune(now: number): void {
    for (const [id, voice] of this.voices) if (voice.endsAt <= now) this.voices.delete(id);
  }

  clear(): void {
    this.voices.clear();
    this.dropped = 0;
  }

  private admit(request: VoiceRequest, now: number): VoiceDecision {
    const id = this.nextId++;
    this.voices.set(id, { ...request, id, startedAt: now, endsAt: now + Math.max(0.02, request.duration) });
    return { admitted: true, stolen: null, id };
  }
}

/** Every bus name, for the settings panel and diagnostics. */
export const MIX_BUSES: readonly MixBus[] = AUDIO_BUSES.filter((bus): bus is MixBus => bus !== 'master');
