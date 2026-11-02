import { describe, expect, it } from 'vitest';
import { AdaptiveQualityController, QUALITY_LADDER } from '../src/core/adaptive-quality';
import type { QualityName } from '../src/config';

const feed = (
  controller: AdaptiveQualityController,
  seconds: number,
  frameP95Ms: number,
  current: QualityName = 'high',
  ceiling: QualityName = 'ultra',
): QualityName | null => {
  let recommendation: QualityName | null = null;
  for (let t = 0; t < seconds; t++) {
    const step = controller.update({ frameP95Ms, current, ceiling }, 1);
    if (step) recommendation = step;
  }
  return recommendation;
};

describe('Phase 13 adaptive quality', () => {
  it('exposes a monotone ladder', () => {
    expect(QUALITY_LADDER).toEqual(['low', 'balanced', 'high', 'ultra']);
  });

  it('steps down only after a sustained budget miss', () => {
    const controller = new AdaptiveQualityController({ downSeconds: 10, cooldownSeconds: 60 });
    expect(feed(controller, 9, 50)).toBeNull(); // not sustained yet
    expect(feed(controller, 1, 50)).toBe('balanced'); // 10th second
    // Cooldown: immediately bad again must not cascade.
    expect(feed(controller, 10, 50)).toBeNull();
  });

  it('steps back up only below the up-budget, and only to the ceiling', () => {
    const controller = new AdaptiveQualityController({ upSeconds: 5, downSeconds: 10, cooldownSeconds: 1 });
    expect(feed(controller, 10, 50, 'high', 'ultra')).toBe('balanced');
    // Now frames are excellent: after the cooldown it climbs, but stops at the
    // ceiling the player chose (high here — one step above current balanced).
    expect(feed(controller, 5, 10, 'balanced', 'high')).toBe('high');
    expect(feed(controller, 30, 10, 'high', 'high')).toBeNull(); // ceiling respected
  });

  it('holds in the mid band between budgets', () => {
    const controller = new AdaptiveQualityController({ downSeconds: 5, upSeconds: 5, cooldownSeconds: 0 });
    expect(feed(controller, 30, 24, 'high', 'ultra')).toBeNull(); // 15 < 24 < 33
  });

  it('never recommends anything for an unknown preset or disabled state', () => {
    const controller = new AdaptiveQualityController({ downSeconds: 1, cooldownSeconds: 0 });
    expect(feed(controller, 10, 100, 'bogus' as QualityName, 'ultra')).toBeNull();
    // A gap in the ladder between current and ceiling cannot be jumped blindly:
    expect(QUALITY_LADDER.indexOf('ultra')).toBe(3);
  });

  it('ignores non-positive dt and clamps huge stalls', () => {
    const controller = new AdaptiveQualityController({ downSeconds: 10, cooldownSeconds: 60 });
    const input = { frameP95Ms: 99, current: 'high' as QualityName, ceiling: 'ultra' as QualityName };
    expect(controller.update(input, 0)).toBeNull();
    expect(controller.update(input, -1)).toBeNull();
    // A single 10 s stall counts as at most 2 s of credit (clamped).
    expect(controller.update(input, 10)).toBeNull(); // 2 s
    expect(controller.update(input, 10)).toBeNull(); // 4 s
    expect(controller.update(input, 10)).toBeNull(); // 6 s
    expect(controller.update(input, 10)).toBeNull(); // 8 s
    expect(controller.update(input, 10)).toBe('balanced'); // 10 s sustained
  });

  it('reset clears windows and cooldown (used on enable/disable, not on apply)', () => {
    const controller = new AdaptiveQualityController({ downSeconds: 3, cooldownSeconds: 60 });
    expect(feed(controller, 5, 50)).toBe('balanced'); // applied -> cooldown starts
    expect(feed(controller, 20, 50)).toBeNull(); // inside the cooldown
    controller.reset();
    expect(feed(controller, 3, 50)).toBe('balanced'); // eligible again after reset
  });
});
