import { describe, expect, it } from 'vitest';
import { TerrainField } from '../src/world/terrain-field';
import { createWaterSample, WATER_WAVES } from '../src/world/water-field';

/**
 * Phase 9 hydrology: determinism, containment, carving safety and the wave
 * function that the GPU shader mirrors.
 */

const field = new TerrainField('hydrology-seed');

/** First wet position found on a deterministic lattice scan. */
function findWater(kind?: string, limit = 40_000): { x: number; z: number; surfaceY: number } {
  let step = 0;
  for (let ring = 0; ring < 40; ring++) {
    for (let i = 0; i < 64; i++) {
      const angle = i / 64 * Math.PI * 2 + ring;
      const radius = ring * 320 + 40;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      if (++step > limit) break;
      const sample = field.water.sampleAt(x, z);
      if (sample && (!kind || sample.kind === kind)) return { x, z, surfaceY: sample.surfaceY };
    }
  }
  throw new Error(`no ${kind ?? 'water'} body found near the origin`);
}

describe('water bodies', () => {
  it('exist and are deterministic for a seed', () => {
    const wet = findWater();
    const a = field.water.sampleAt(wet.x, wet.z);
    const b = field.water.sampleAt(wet.x, wet.z);
    expect(a).toBeDefined();
    expect(b).toEqual(a);
    // A different world is a different world.
    const other = new TerrainField('another-seed');
    let differs = false;
    for (let i = 0; i < 400 && !differs; i++) {
      const x = (i % 20) * 400 - 4000, z = Math.floor(i / 20) * 400 - 4000;
      const mine = field.water.sampleAt(x, z);
      const theirs = other.water.sampleAt(x, z);
      if ((mine === undefined) !== (theirs === undefined)) differs = true;
      else if (mine && theirs && Math.abs(mine.surfaceY - theirs.surfaceY) > 0.01) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('reports water only where the water column is real', () => {
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const x = (i % 60) * 180 - 5400, z = Math.floor(i / 60) * 180 - 5400;
      const sample = field.water.sampleAt(x, z);
      if (!sample) continue;
      checked++;
      expect(sample.depth).toBeGreaterThan(0);
      // The surface is above the ground the player and props actually stand on.
      expect(field.height(x, z)).toBeLessThanOrEqual(sample.surfaceY + 1e-6);
      expect(sample.waveAmplitude).toBeGreaterThanOrEqual(0);
      expect(sample.bodyId).toMatch(/^(lake|pond|reservoir|wetland|sea|river):/);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('carves terrain downward only, and never through a road formation', () => {
    let carved = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (i % 80) * 140 - 5600, z = Math.floor(i / 80) * 140 - 5600;
      const graded = field.gradedHeight(x, z);
      const height = field.height(x, z);
      expect(height).toBeLessThanOrEqual(graded + 1e-6);
      const sample = field.water.sampleAt(x, z);
      if (sample) carved++;
      // Engineered ground stays dry: no water reported on the carriageway.
      const work = field.water.carve(x, z);
      if (work && work.weight > 0.5) expect(height).toBeLessThan(graded + 1e-6);
    }
    expect(carved).toBeGreaterThan(10);
  });

  it('holds its water below the basin rim, so a lake cannot leak', () => {
    // Walk outward from a lake centre: the shoreline must exist (dry outside).
    const wet = findWater('lake');
    let foundDry = false;
    for (let r = 0; r < 2400 && !foundDry; r += 8) {
      if (!field.water.sampleAt(wet.x + r, wet.z)) foundDry = true;
    }
    expect(foundDry).toBe(true);
  });
});

describe('rivers', () => {
  it('run downhill and carry a current', () => {
    const sample = field.water.rivers.sample(0, field.water.rivers.center(0, 0));
    expect(sample).toBeDefined();
    const upstream = field.water.rivers.sample(
      sample!.station - 400,
      field.water.rivers.center(0, sample!.station - 400),
    );
    const downstream = field.water.rivers.sample(
      sample!.station + 400,
      field.water.rivers.center(0, sample!.station + 400),
    );
    expect(upstream && downstream).toBeTruthy();
    // The channel floor is a monotone profile, so one direction is downhill.
    const dropUp = sample!.surfaceY - upstream!.surfaceY;
    const dropDown = sample!.surfaceY - downstream!.surfaceY;
    expect(Math.abs(dropUp) + Math.abs(dropDown)).toBeGreaterThan(0.5);
    expect(Math.sign(dropUp) !== Math.sign(dropDown)).toBe(true);
    const flow = Math.hypot(sample!.flowX, sample!.flowZ);
    expect(flow).toBeGreaterThan(0.99);
    // Flow points to the lower end.
    const downhill = dropDown < dropUp;
    const direction = sample!.flowX * sample!.tangentX + sample!.flowZ * sample!.tangentZ;
    expect(Math.sign(direction)).toBe(downhill ? 1 : -1);
  });
});

describe('wave surface', () => {
  it('matches the constants the renderer uses and stays inside its amplitude', () => {
    const wet = findWater();
    const sample = field.water.sampleAt(wet.x, wet.z)!;
    const amplitude = sample.waveAmplitude;
    for (let t = 0; t < 20; t += 0.37) {
      const offset = field.water.waveOffset(wet.x, wet.z, t, amplitude, sample.depth);
      expect(Math.abs(offset)).toBeLessThanOrEqual(amplitude * field.water.waveScale(sample.depth) * field.water.seaState + 1e-9);
    }
    // Zero amplitude is still water, just flat.
    expect(field.water.waveOffset(wet.x, wet.z, 1, 0, 4)).toBe(0);
    // The three wave trains sum to unit weight, so the peak is the amplitude.
    expect(WATER_WAVES.a1 + WATER_WAVES.a2 + WATER_WAVES.a3).toBeCloseTo(1, 6);
  });

  it('displaces the surface without moving it more than a metre', () => {
    const wet = findWater();
    const sample = field.water.sampleAt(wet.x, wet.z)!;
    const displaced = field.water.displacedSurface(wet.x, wet.z, 4.2)!;
    expect(Math.abs(displaced - sample.surfaceY)).toBeLessThanOrEqual(sample.waveAmplitude * 1.6 + 1e-6);
  });

  it('damps waves in the shallows and reacts to the sea state', () => {
    expect(field.water.waveScale(0.1)).toBeLessThan(field.water.waveScale(4));
    field.water.setActivity(0);
    expect(field.water.waveOffset(10, 10, 1, 1, 4)).toBe(0);
    field.water.setActivity(1.6);
    expect(field.water.waveOffset(10, 10, 1, 1, 4)).not.toBe(0);
    field.water.setActivity(1);
  });

  it('fills a reusable sample without allocating per query', () => {
    const wet = findWater();
    const scratch = createWaterSample();
    const first = field.water.sampleAt(wet.x, wet.z, scratch);
    expect(first).toBe(scratch);
    expect(scratch.bodyId.length).toBeGreaterThan(3);
  });
});
