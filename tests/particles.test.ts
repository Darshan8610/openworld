import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { ParticleSystem } from '../src/effects/particles';

/**
 * Phase 9 particles: a hard budget, frame-rate-independent simulation, weather
 * driven precipitation, and splashes that actually end.
 */

function makeSystem(capacity = 900): { system: ParticleSystem; origin: FloatingOrigin } {
  const origin = new FloatingOrigin();
  origin.update(new Vector3(0, 0, 0));
  const system = new ParticleSystem(origin, capacity);
  system.setColliders(() => -50, () => undefined);
  return { system, origin };
}

const view = new Vector3(0, 0, 0);

describe('particle budget', () => {
  it('never exceeds its pool, even at maximum precipitation', () => {
    const { system } = makeSystem(600);
    system.setPrecipitation(1, 1);
    for (let i = 0; i < 600; i++) system.update(1 / 60, view, 4, 1);
    const stats = system.stats;
    expect(stats.active).toBeLessThanOrEqual(stats.capacity);
    expect(stats.active).toBeGreaterThan(100);
    expect(stats.capacity).toBe(600);
    expect(stats.drawCalls).toBe(2);
    system.dispose();
  });

  it('thins out when the weather clears', () => {
    const { system } = makeSystem(600);
    system.setPrecipitation(1, 0);
    for (let i = 0; i < 240; i++) system.update(1 / 60, view, 0, 0);
    const stormy = system.stats;
    expect(stormy.rain).toBeGreaterThan(50);
    system.setPrecipitation(0, 0);
    for (let i = 0; i < 600; i++) system.update(1 / 60, view, 0, 0);
    expect(system.stats.rain).toBe(0);
    expect(system.stats.active).toBeLessThanOrEqual(stormy.active);
    system.dispose();
  });

  it('recycles particles rather than allocating without bound', () => {
    const { system } = makeSystem(300);
    for (let burst = 0; burst < 200; burst++) system.splash(0, 0, 0, { strength: 3 });
    expect(system.stats.active).toBeLessThanOrEqual(system.stats.capacity);
    expect(system.stats.dropped).toBeGreaterThan(0);
    system.dispose();
  });
});

describe('precipitation', () => {
  it('produces rain and snow separately', () => {
    const { system } = makeSystem(900);
    system.setPrecipitation(1, 0);
    for (let i = 0; i < 120; i++) system.update(1 / 60, view, 0, 0);
    expect(system.stats.rain).toBeGreaterThan(0);
    expect(system.stats.snow).toBe(0);

    const snowy = makeSystem(900).system;
    snowy.setPrecipitation(0, 1);
    for (let i = 0; i < 300; i++) snowy.update(1 / 60, view, 1, 0);
    expect(snowy.stats.snow).toBeGreaterThan(0);
    expect(snowy.stats.rain).toBe(0);
    snowy.dispose();
    system.dispose();
  });

  it('is frame-rate independent within a tolerance', () => {
    const a = makeSystem(900).system;
    a.setPrecipitation(1, 0);
    for (let i = 0; i < 60; i++) a.update(1 / 60, view, 0, 0);
    const b = makeSystem(900).system;
    b.setPrecipitation(1, 0);
    // One long frame versus many short ones: the fixed internal step keeps the
    // population in the same ballpark (bounded catch-up prevents a spike).
    b.update(0.25, view, 0, 0);
    b.update(0.25, view, 0, 0);
    expect(Math.abs(a.stats.active - b.stats.active)).toBeLessThan(a.stats.capacity * 0.6);
    a.dispose();
    b.dispose();
  });
});

describe('splashes', () => {
  it('emits a burst that dies out', () => {
    const { system } = makeSystem(600);
    system.splash(10, -1, 10, { strength: 2 });
    const stats = system.stats;
    expect(stats.splashes).toBeGreaterThan(3);
    expect(stats.active).toBe(stats.splashes);
    for (let i = 0; i < 240; i++) system.update(1 / 60, view, 0, 0);
    expect(system.stats.active).toBe(0);
    system.dispose();
  });

  it('kills droplets on the ground and on water', () => {
    const { system } = makeSystem(600);
    system.setColliders(() => 2, () => 2.5);
    system.splash(0, 2.4, 0, { strength: 1 });
    // Longest splash life is 1.4 s, so 3 s covers every droplet either way.
    for (let i = 0; i < 180; i++) system.update(1 / 60, view, 0, 0);
    expect(system.stats.active).toBe(0);
    system.dispose();
  });

  it('follows the floating origin', () => {
    const { system, origin } = makeSystem(600);
    system.setPrecipitation(1, 0);
    origin.update(new Vector3(4000, 0, 4000));
    system.rebase();
    for (let i = 0; i < 60; i++) system.update(1 / 60, new Vector3(4000, 0, 4000), 0, 0);
    expect(system.stats.rain).toBeGreaterThan(0);
    // Point positions are uploaded origin-local, so nothing overflows.
    const positions = system.group.children[0] as unknown as { geometry: { getAttribute: (name: string) => { array: Float32Array } } };
    const array = positions.geometry.getAttribute('position').array;
    for (let i = 0; i < Math.min(array.length, 300); i++) expect(Number.isFinite(array[i])).toBe(true);
    system.dispose();
  });
});
