import { describe, expect, it } from 'vitest';
import { BiomeField, createClimateSample } from '../src/world/biomes';
import { TerrainField } from '../src/world/terrain-field';
import { createSurfaceTexture } from '../src/rendering/surface-textures';

describe('climate-driven biomes', () => {
  it('is deterministic and independent of instance construction order', () => {
    const a = new BiomeField('climate'), b = new BiomeField('climate');
    a.sample(9000, -3000, 400, 0.1);
    expect(a.sample(123.4, -456.7, 400, 0.1)).toEqual(b.sample(123.4, -456.7, 400, 0.1));
  });
  it('has normalized weights and finite albedo across the world', () => {
    const field = new BiomeField('weights'), sample = createClimateSample(), color = new Float32Array(3);
    for (let i = 0; i < 160; i++) {
      const x = Math.sin(i * 2.4) * 1e6, z = Math.cos(i * 1.7) * 1e6, h = (i % 16) * 110;
      field.sample(x, z, h, (i % 9) / 10, sample);
      expect(sample.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(sample.weights.every((w) => w >= 0 && w <= 1)).toBe(true);
      field.color(x, z, sample, color, 0);
      expect(color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)).toBe(true);
    }
  });
  it('blends across climate boundaries instead of snapping', () => {
    const field = new BiomeField('continuity');
    for (let i = -20; i < 20; i++) {
      const x = i * 137.1;
      const a = field.sample(x, 400, 450, 0.1), b = field.sample(x + 0.01, 400, 450, 0.1);
      for (let k = 0; k < 5; k++) expect(Math.abs(a.weights[k]! - b.weights[k]!)).toBeLessThan(0.001);
    }
  });
  it('raises tundra and snow with altitude and exposes steep rock', () => {
    const field = new BiomeField('altitude');
    const low = field.sample(0, 0, 100, 0.05), tundra = field.sample(0, 0, 1000, 0.05), snow = field.sample(0, 0, 1600, 0.05);
    expect(low.weights[0]! + low.weights[1]! + low.weights[2]!).toBeGreaterThan(0.9);
    expect(tundra.weights[3]).toBeGreaterThan(0.5);
    expect(snow.snow).toBeGreaterThan(0.9);
    expect(field.sample(0, 0, 400, 0.7).rock).toBeGreaterThan(0.9);
  });
  it('preserves each seed landform while giving different seeds different climates', () => {
    const a = new TerrainField('seed-a'), again = new TerrainField('seed-a'), b = new TerrainField('seed-b');
    expect(a.height(1234, -4567)).toBe(again.height(1234, -4567));
    expect(a.height(1234, -4567)).not.toBe(b.height(1234, -4567));
    expect(a.sample(1234, -4567, 400, 0.1).moisture).not.toBe(b.sample(1234, -4567, 400, 0.1).moisture);
  });
});

describe('procedural surface textures', () => {
  it('creates deterministic, seamless, mipmapped power-of-two textures', () => {
    for (const kind of ['grass', 'rock', 'snow'] as const) {
      const a = createSurfaceTexture(kind), b = createSurfaceTexture(kind);
      const data = a.image.data as Uint8Array, size = a.image.width;
      expect(data).toEqual(b.image.data);
      expect(size).toBe(256);
      expect(a.generateMipmaps).toBe(true);
      for (let i = 0; i < size; i++) {
        const left = (i * size) * 4, right = (i * size + size - 1) * 4;
        const top = i * 4, bottom = ((size - 1) * size + i) * 4;
        expect(Math.abs(data[left]! - data[right]!)).toBeLessThan(65);
        expect(Math.abs(data[top]! - data[bottom]!)).toBeLessThan(65);
      }
      a.dispose(); b.dispose();
    }
  });
});
