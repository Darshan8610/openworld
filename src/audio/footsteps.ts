import type { WorldPoint } from '../core/coordinates';
import type { SurfaceKind } from '../physics/surfaces';
import { footstepSoundFor } from './recipes';
import type { SoundId } from './types';

/**
 * Footstep cadence.
 *
 * Steps are driven by distance travelled, not by a timer, so they follow the
 * actual locomotion speed the character solver produced. Stance changes stride
 * length and loudness; landings are derived from the airborne → grounded
 * transition and the impact speed. Pure logic: the director turns events into
 * audio requests, tests assert cadence without a browser.
 */

export interface FootstepState {
  readonly position: WorldPoint;
  /** Horizontal speed, metres per second. */
  readonly speed: number;
  readonly verticalSpeed: number;
  readonly grounded: boolean;
  /** Character stance (`stand`, `crouch`, …) as reported by the controller. */
  readonly stance: string;
  readonly swimming: boolean;
  readonly surface: SurfaceKind;
}

export interface FootstepEvent {
  readonly kind: 'step' | 'land' | 'splash';
  readonly sound: SoundId;
  /** Overall loudness of this event, 0..1. */
  readonly gain: number;
  /** Pitch multiplier for variety, 0.85..1.15. */
  readonly rate: number;
  readonly surface: SurfaceKind;
}

export interface FootstepOptions {
  /** Base stride length at walking pace, metres. */
  readonly stride: number;
  /** Below this speed the character is standing and makes no steps. */
  readonly minSpeed: number;
  /** Impact speed at which a landing becomes a hard landing. */
  readonly hardLandingSpeed: number;
}

export const DEFAULT_FOOTSTEP_OPTIONS: FootstepOptions = {
  stride: 0.78,
  minSpeed: 0.35,
  hardLandingSpeed: 4.2,
};

const STANCE_STRIDE: Record<string, number> = {
  crouch: 0.55, walk: 0.82, jog: 1, sprint: 1.12, stand: 1, swim: 1,
};

const STANCE_GAIN: Record<string, number> = {
  crouch: 0.35, walk: 0.55, jog: 0.8, sprint: 1, stand: 0.7, swim: 0.6,
};

export class FootstepDriver {
  private travelled = 0;
  /** Starts grounded: a landing is only reported after an observed airborne frame. */
  private wasGrounded = true;
  private steps = 0;
  private readonly options: FootstepOptions;

  constructor(options: Partial<FootstepOptions> = {}) {
    this.options = { ...DEFAULT_FOOTSTEP_OPTIONS, ...options };
  }

  get stepCount(): number { return this.steps; }

  reset(): void {
    this.travelled = 0;
    this.wasGrounded = true;
  }

  update(dt: number, state: FootstepState): FootstepEvent[] {
    if (dt <= 0) return [];
    const events: FootstepEvent[] = [];
    const stance = state.stance in STANCE_STRIDE ? state.stance : 'walk';
    const stride = this.options.stride * (STANCE_STRIDE[stance] ?? 1);
    const loudness = STANCE_GAIN[stance] ?? 0.7;

    if (!state.grounded && !state.swimming) {
      this.travelled = 0;
    } else if (state.swimming) {
      this.travelled += state.speed * dt;
      if (this.travelled >= stride * 1.6) {
        this.travelled = 0;
        this.steps += 1;
        events.push({
          kind: 'splash', sound: 'step-water',
          gain: 0.5 + Math.min(0.4, state.speed * 0.08),
          rate: 0.95 + (this.steps % 3) * 0.03,
          surface: 'water',
        });
      }
    } else if (state.speed > this.options.minSpeed) {
      this.travelled += state.speed * dt;
      if (this.travelled >= stride) {
        this.travelled -= stride;
        this.steps += 1;
        const intensity = Math.min(1, 0.4 + state.speed / 6) * loudness;
        events.push({
          kind: 'step',
          sound: footstepSoundFor(state.surface),
          gain: Math.max(0.08, Math.min(1, intensity)),
          rate: 0.9 + ((this.steps % 5) * 0.045),
          surface: state.surface,
        });
      }
    } else {
      // Standing still resets the accumulator so the next first step is immediate.
      this.travelled = Math.min(this.travelled, stride * 0.5);
    }

    if (state.grounded && !this.wasGrounded) {
      const impact = Math.abs(Math.min(0, state.verticalSpeed));
      const hard = impact >= this.options.hardLandingSpeed;
      events.push({
        kind: 'land',
        sound: hard ? 'land-hard' : 'land-soft',
        gain: Math.max(0.15, Math.min(1, (hard ? 0.55 : 0.3) + impact / 14)),
        rate: 0.95 + Math.min(0.1, impact / 60),
        surface: state.surface,
      });
    }
    this.wasGrounded = state.grounded;
    if (events.length > 3) return events.slice(-3);
    return events;
  }
}
