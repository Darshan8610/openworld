import { describe, expect, it } from 'vitest';
import { validateGameSave } from '../src/persistence/game-save';
import type { GameSave } from '../src/persistence/game-save';
import { DISCOVERY_LIMIT } from '../src/discovery/discovery';

/** Deterministic PRNG so failures are reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const valid = (): GameSave => ({
  format: 'wayfarer.game', version: 2, savedAt: 1717, seed: 'fuzz',
  player: { x: -4321, z: 98765, yaw: 1.5 },
  hour: 13.5, cycling: true, weather: 'rain',
  objectives: { flags: { 'gate.open': true, depth: 3 }, started: ['m1'], completed: [], counts: { 'm1:o1': 2 } },
  discovery: { cells: ['-3:12', '0:0'], waypoint: { x: 10, z: -10 } },
  objects: { format: 'wayfarer.objects', version: 1, seed: 'fuzz', savedAt: 1, objects: {}, inventory: [] },
});

/** Structural mutations a corrupt disk / hostile writer might produce. */
function mutate(value: unknown, random: () => number, depth = 0): unknown {
  if (depth > 4) return value;
  const pick = random();
  if (Array.isArray(value)) {
    if (pick < 0.15) return [];
    if (pick < 0.3) return value.slice(0, Math.floor(random() * value.length));
    if (pick < 0.45) return [...value, value[0]];
    return value.map((item) => mutate(item, random, depth + 1));
  }
  if (value && typeof value === 'object') {
    const record = { ...(value as Record<string, unknown>) };
    const keys = Object.keys(record);
    if (pick < 0.1 && keys.length > 0) delete record[keys[Math.floor(random() * keys.length)]!];
    if (pick < 0.2 && keys.length > 0) record['bogusKey'] = random();
    for (const key of keys) {
      if (random() < 0.3) record[key] = mutate(record[key], random, depth + 1);
    }
    return record;
  }
  if (typeof value === 'number') {
    const alternatives = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1e300, 24, -24, value + 1, String(value)];
    return pick < 0.6 ? (alternatives[Math.floor(random() * alternatives.length)] as number) : value;
  }
  if (typeof value === 'string') {
    return pick < 0.2 ? '' : pick < 0.35 ? 'x'.repeat(200) : value;
  }
  if (typeof value === 'boolean') return pick < 0.3 ? !value : value;
  return value;
}

describe('Phase 13 save validation fuzz', () => {
  it('the canonical save always passes and roundtrips its invariants', () => {
    const clean = validateGameSave(valid());
    expect(clean.version).toBe(2);
    expect(clean.hour).toBeGreaterThanOrEqual(0);
    expect(clean.hour).toBeLessThan(24);
    expect(Number.isFinite(clean.player.yaw)).toBe(true);
    expect(clean.discovery.cells.length).toBeLessThanOrEqual(DISCOVERY_LIMIT);
    // Roundtrip: validating an already-clean save is idempotent.
    expect(validateGameSave(clean)).toEqual(clean);
  });

  it('500 seeded mutations either validate cleanly or throw — never return garbage', () => {
    const random = mulberry32(0xc0ffee);
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 500; i++) {
      const candidate = mutate(valid(), random);
      let result: GameSave | undefined;
      try {
        result = validateGameSave(candidate);
      } catch {
        rejected++;
        continue;
      }
      accepted++;
      // Invariants that must hold for anything the validator lets through.
      expect(result.format).toBe('wayfarer.game');
      expect(result.version).toBe(2);
      expect(typeof result.seed).toBe('string');
      expect(result.seed.length).toBeLessThanOrEqual(128);
      expect(Number.isFinite(result.hour)).toBe(true);
      expect(result.hour).toBeGreaterThanOrEqual(0);
      expect(result.hour).toBeLessThan(24);
      expect(Number.isFinite(result.savedAt)).toBe(true);
      expect(Number.isFinite(result.player.x)).toBe(true);
      expect(Number.isFinite(result.player.z)).toBe(true);
      expect(Number.isFinite(result.player.yaw)).toBe(true);
      expect(result.weather === null || (typeof result.weather === 'string' && result.weather.length <= 64)).toBe(true);
      expect(result.discovery.cells.length).toBeLessThanOrEqual(DISCOVERY_LIMIT);
      expect(result.discovery.cells.every((c) => typeof c === 'string' && /^-?\d{1,10}:-?\d{1,10}$/.test(c))).toBe(true);
      expect(result.discovery.waypoint === null ||
        (Number.isFinite(result.discovery.waypoint.x) && Number.isFinite(result.discovery.waypoint.z))).toBe(true);
      expect(Object.keys(result.objectives.flags).length).toBeLessThanOrEqual(256);
      expect(result.objectives.started.length).toBeLessThanOrEqual(64);
      expect(result.objectives.completed.length).toBeLessThanOrEqual(64);
      expect(Object.values(result.objectives.counts).every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
      expect(result.objects.seed).toBe(result.seed);
    }
    // The mix must exercise both paths meaningfully.
    expect(rejected).toBeGreaterThan(100);
    expect(accepted).toBeGreaterThan(50);
  });

  it('rejects structurally hostile saves outright', () => {
    const hostile = valid() as unknown as Record<string, unknown>;
    hostile['format'] = 'evil.game';
    expect(() => validateGameSave(hostile)).toThrow();
    expect(() => validateGameSave(null)).toThrow();
    expect(() => validateGameSave('save')).toThrow();
    expect(() => validateGameSave([])).toThrow();
    expect(() => validateGameSave({ ...valid(), version: 3 })).toThrow();
    expect(() => validateGameSave({ ...valid(), hour: '13' })).toThrow();
    expect(() => validateGameSave({ ...valid(), player: { x: 0, z: 0 } })).toThrow(); // v2 needs yaw
  });
});
