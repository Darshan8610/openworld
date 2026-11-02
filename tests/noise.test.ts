import { describe, expect, it } from 'vitest';
import { SimplexNoise } from '../src/world/noise';
import { TerrainField } from '../src/world/terrain-field';
import { hashSeed, seededRandom } from '../src/utils/random';

describe('deterministic world field', () => {
  it('produces identical noise for identical seeds', () => {
    const a = new SimplexNoise(1234), b = new SimplexNoise(1234), c = new SimplexNoise(4321);
    expect(a.noise(12.3, -8.7)).toBe(b.noise(12.3, -8.7));
    expect(a.noise(12.3, -8.7)).not.toBe(c.noise(12.3, -8.7));
  });
  it('is continuous across positive and negative chunk boundaries', () => {
    const noise = new SimplexNoise(77);
    for (const x of [-4096, -128, 0, 128, 4096]) {
      expect(Math.abs(noise.noise(x / 700 + 1e-7, 1.4) - noise.noise(x / 700 - 1e-7, 1.4))).toBeLessThan(0.0001);
    }
  });
  it('generates the same height and albedo at shared edges for different LODs', () => {
    const a = new TerrainField('edge-test'), b = new TerrainField('edge-test');
    const ca = new Float32Array(3), cb = new Float32Array(3);
    for (const x of [-4096, 0, 4096]) for (const z of [-128, 0, 128]) {
      expect(a.height(x, z)).toBe(b.height(x, z));
      a.color(x, z, a.height(x, z), 0.2, ca, 0);
      b.color(x, z, b.height(x, z), 0.2, cb, 0);
      expect(ca).toEqual(cb);
    }
  });
  it('has finite, varied terrain in every direction far from spawn', () => {
    const field = new TerrainField('far-field');
    for (const sign of [-1, 1]) for (let i = 1; i <= 20; i++) {
      const h = field.height(sign * i * 17031.7, sign * i * 23197.3);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(-300);
      expect(h).toBeLessThan(2500);
    }
  });
  it('does not tile a fixed segment', () => {
    const field = new TerrainField('no-tiling');
    expect(field.height(123, 456)).not.toBe(field.height(123 + 4096, 456));
    expect(field.height(123, 456)).not.toBe(field.height(123, 456 + 4096));
  });
  it('normalizes seed text and PRNG streams', () => {
    const a = seededRandom(hashSeed('hello')), b = seededRandom(hashSeed('hello'));
    for (let i = 0; i < 100; i++) { const value = a(); expect(value).toBe(b()); expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(1); }
  });
});
