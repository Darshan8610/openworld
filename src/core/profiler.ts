/**
 * Phase 13 — bounded frame-time profiler.
 *
 * Fixed-size ring buffers for wall-clock frame, accumulated fixed-step and
 * render-callback durations. No allocation in the steady state; percentile
 * queries copy at most `CAPACITY` doubles on demand (throttled by the overlay
 * and the adaptive-quality controller). Canonical units: milliseconds.
 */

const CAPACITY = 240; // ~4 s of history at 60 fps

export interface ProfilerSnapshot {
  readonly samples: number;
  readonly frameAvgMs: number;
  readonly frameP95Ms: number;
  readonly frameMaxMs: number;
  readonly fixedAvgMs: number;
  readonly renderAvgMs: number;
}

export class FrameProfiler {
  private readonly frame = new Float64Array(CAPACITY);
  private readonly fixed = new Float64Array(CAPACITY);
  private readonly render = new Float64Array(CAPACITY);
  private cursor = 0;
  private filled = 0;

  /** Record one rendered frame. Durations are milliseconds. */
  record(frameMs: number, fixedMs: number, renderMs: number): void {
    if (!Number.isFinite(frameMs) || frameMs < 0) frameMs = 0;
    if (!Number.isFinite(fixedMs) || fixedMs < 0) fixedMs = 0;
    if (!Number.isFinite(renderMs) || renderMs < 0) renderMs = 0;
    this.frame[this.cursor] = frameMs;
    this.fixed[this.cursor] = fixedMs;
    this.render[this.cursor] = renderMs;
    this.cursor = (this.cursor + 1) % CAPACITY;
    if (this.filled < CAPACITY) this.filled++;
  }

  get samples(): number { return this.filled; }

  frameAvgMs(): number { return this.avg(this.frame); }
  fixedAvgMs(): number { return this.avg(this.fixed); }
  renderAvgMs(): number { return this.avg(this.render); }
  frameMaxMs(): number { return this.max(this.frame); }

  /** p95 of the frame ring (nearest-rank). 0 when empty. */
  frameP95Ms(): number { return this.percentile(this.frame, 0.95); }

  snapshot(): ProfilerSnapshot {
    return {
      samples: this.filled,
      frameAvgMs: this.frameAvgMs(),
      frameP95Ms: this.frameP95Ms(),
      frameMaxMs: this.frameMaxMs(),
      fixedAvgMs: this.fixedAvgMs(),
      renderAvgMs: this.renderAvgMs(),
    };
  }

  private avg(ring: Float64Array): number {
    if (this.filled === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.filled; i++) total += ring[i]!;
    return total / this.filled;
  }

  private max(ring: Float64Array): number {
    let worst = 0;
    for (let i = 0; i < this.filled; i++) if (ring[i]! > worst) worst = ring[i]!;
    return worst;
  }

  private percentile(ring: Float64Array, fraction: number): number {
    if (this.filled === 0) return 0;
    const copy = ring.slice(0, this.filled);
    copy.sort();
    const rank = Math.min(this.filled - 1, Math.max(0, Math.ceil(fraction * this.filled) - 1));
    return copy[rank]!;
  }
}
