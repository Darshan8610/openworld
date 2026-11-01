import { describe, expect, it } from 'vitest';
import { FrameProfiler } from '../src/core/profiler';

describe('Phase 13 frame profiler', () => {
  it('is safe and empty before any samples', () => {
    const profiler = new FrameProfiler();
    expect(profiler.samples).toBe(0);
    expect(profiler.frameAvgMs()).toBe(0);
    expect(profiler.frameP95Ms()).toBe(0);
    expect(profiler.frameMaxMs()).toBe(0);
    expect(profiler.snapshot().fixedAvgMs).toBe(0);
  });

  it('computes average, p95 and max over the window', () => {
    const profiler = new FrameProfiler();
    for (let i = 1; i <= 100; i++) profiler.record(i, i / 2, i / 4);
    expect(profiler.samples).toBe(100);
    expect(profiler.frameAvgMs()).toBeCloseTo(50.5, 6);
    expect(profiler.frameMaxMs()).toBe(100);
    // Nearest-rank p95 of 1..100 → the 95th value.
    expect(profiler.frameP95Ms()).toBe(95);
    const snapshot = profiler.snapshot();
    expect(snapshot.fixedAvgMs).toBeCloseTo(25.25, 6);
    expect(snapshot.renderAvgMs).toBeCloseTo(12.625, 6);
  });

  it('stays bounded: ring wrap keeps memory and stats finite', () => {
    const profiler = new FrameProfiler();
    for (let i = 0; i < 5000; i++) profiler.record(16 + (i % 7), 5, 8);
    expect(profiler.samples).toBe(240); // capped window
    const snapshot = profiler.snapshot();
    expect(Number.isFinite(snapshot.frameP95Ms)).toBe(true);
    expect(snapshot.frameMaxMs).toBeLessThan(100);
    expect(snapshot.frameAvgMs).toBeGreaterThan(0);
    // After wrap, the oldest samples are gone: a huge late frame dominates
    // only until it scrolls out of the window.
    profiler.record(500, 5, 8);
    expect(profiler.frameMaxMs()).toBe(500);
    for (let i = 0; i < 240; i++) profiler.record(16, 5, 8);
    expect(profiler.frameMaxMs()).toBe(16);
  });

  it('ignores non-finite and negative durations', () => {
    const profiler = new FrameProfiler();
    profiler.record(Number.NaN, -5, Infinity);
    expect(profiler.samples).toBe(1);
    expect(profiler.snapshot()).toMatchObject({ frameAvgMs: 0, fixedAvgMs: 0, renderAvgMs: 0 });
  });
});
