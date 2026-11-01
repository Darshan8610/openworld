import type { QualityName } from '../config';

/**
 * Phase 13 — adaptive quality controller.
 *
 * Pure decision logic over profiler p95: steps the preset down after a
 * sustained frame-budget miss and back up after a longer sustained surplus.
 * Safety rails from the project directive:
 *
 *  - never above the player's chosen preset (the ceiling);
 *  - changes are recommendations — the caller applies them (and may toast);
 *  - long cooldowns, so re-streaming from a quality change stays rare;
 *  - disabled by default in tests / explicit opt-out.
 */

export const QUALITY_LADDER: readonly QualityName[] = ['low', 'balanced', 'high', 'ultra'];

export interface AdaptiveInput {
  /** p95 frame time over the profiler window, milliseconds. */
  readonly frameP95Ms: number;
  readonly current: QualityName;
  /** Player-chosen preset; adaptive never exceeds it. */
  readonly ceiling: QualityName;
}

export interface AdaptiveOptions {
  /** Step down when p95 exceeds this for `downSeconds`. Default 33 ms (~30 fps). */
  readonly budgetMs?: number;
  /** Step up when p95 stays under this for `upSeconds`. Default 15 ms. */
  readonly upBudgetMs?: number;
  readonly downSeconds?: number;
  readonly upSeconds?: number;
  /** Minimum seconds between changes (applies to both directions). */
  readonly cooldownSeconds?: number;
}

const DEFAULTS = { budgetMs: 33, upBudgetMs: 15, downSeconds: 10, upSeconds: 45, cooldownSeconds: 60 };

export class AdaptiveQualityController {
  private readonly options: Required<AdaptiveOptions>;
  private overMs = 0;
  private underMs = 0;
  private sinceChangeMs = Number.POSITIVE_INFINITY;

  constructor(options: AdaptiveOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Feed the latest p95 and elapsed seconds since the previous call.
   * Returns the preset to switch to, or null.
   */
  update(input: AdaptiveInput, dtSeconds: number): QualityName | null {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return null;
    const dt = Math.min(dtSeconds, 2); // a stall must not charge the whole cooldown
    this.sinceChangeMs += dt;
    if (input.frameP95Ms > this.options.budgetMs) {
      this.overMs += dt;
      this.underMs = 0;
    } else if (input.frameP95Ms < this.options.upBudgetMs) {
      this.underMs += dt;
      this.overMs = 0;
    } else {
      this.overMs = 0;
      this.underMs = 0;
    }
    if (this.sinceChangeMs < this.options.cooldownSeconds) return null;
    const index = QUALITY_LADDER.indexOf(input.current);
    if (index < 0) return null;
    if (this.overMs >= this.options.downSeconds && index > 0) {
      this.commit();
      return QUALITY_LADDER[index - 1]!;
    }
    const ceilingIndex = QUALITY_LADDER.indexOf(input.ceiling);
    if (this.underMs >= this.options.upSeconds && index < ceilingIndex) {
      this.commit();
      return QUALITY_LADDER[index + 1]!;
    }
    return null;
  }

  private commit(): void {
    this.overMs = 0;
    this.underMs = 0;
    this.sinceChangeMs = 0;
  }

  reset(): void {
    this.overMs = 0;
    this.underMs = 0;
    this.sinceChangeMs = Number.POSITIVE_INFINITY;
  }
}
