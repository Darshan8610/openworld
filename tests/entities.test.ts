import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three/webgpu';
import { EventBus } from '../src/game/events';
import { createEntity, resetEntityIds, SIMULATION_BACKGROUND, SIMULATION_FULL, SIMULATION_REDUCED, SIMULATION_DORMANT } from '../src/game/entity';
import { EntityRegistry } from '../src/game/entity-registry';
import type { StreamingBudgets } from '../src/game/entity-registry';

const budgets: StreamingBudgets = {
  fullDistance: 100,
  reducedDistance: 300,
  backgroundDistance: 1000,
  maxFull: 2,
  maxReduced: 2,
  maxBackground: 2,
};

function prop(x: number, z: number, extra: { priority?: number; visual?: Object3D; kind?: 'prop' | 'building' } = {}) {
  return createEntity({
    kind: extra.kind ?? 'prop',
    position: new Vector3(x, 10, z),
    radius: 0.5,
    height: 1,
    ...(extra.priority !== undefined ? { priority: extra.priority } : {}),
    ...(extra.visual ? { visual: extra.visual } : {}),
  });
}

describe('entity registry', () => {
  it('registers, indexes and removes entities by stable id', () => {
    resetEntityIds();
    const registry = new EntityRegistry();
    const first = registry.add(prop(0, 0));
    const second = registry.add(prop(500, 0));
    expect(first.id).toBe('prop-1');
    expect(registry.size).toBe(2);
    expect(registry.get(first.id)).toBe(first);
    expect(() => registry.add(first)).toThrow(/already registered/);
    expect(registry.remove(first.id)).toBe(true);
    expect(registry.remove(first.id)).toBe(false);
    expect(registry.size).toBe(1);
    expect(registry.get(second.id)).toBe(second);
  });

  it('answers nearby queries nearest-first with kind and limit filters', () => {
    const registry = new EntityRegistry();
    const near = registry.add(prop(10, 0));
    const middle = registry.add(prop(40, 0));
    const far = registry.add(prop(90, 0));
    const building = registry.add(prop(20, 0, { kind: 'building' }));
    const all = registry.nearby(0, 0, 100);
    expect(all.map((entity) => entity.id)).toEqual([near.id, building.id, middle.id, far.id]);
    expect(registry.nearby(0, 0, 100, { kinds: ['building'] })).toHaveLength(1);
    expect(registry.nearby(0, 0, 100, { limit: 2 })).toHaveLength(2);
    expect(registry.nearest(0, 0, 100)?.id).toBe(near.id);
    expect(registry.nearby(0, 0, 5)).toHaveLength(0);
  });

  it('measures reach to the entity footprint, not the centre', () => {
    const registry = new EntityRegistry();
    registry.add(createEntity({ kind: 'building', position: new Vector3(0, 0, 0), radius: 40, height: 12 }));
    // A 40 m footprint at the origin is reachable from 30 m away.
    expect(registry.nearby(30, 0, 1)).toHaveLength(1);
    expect(registry.nearby(60, 0, 1)).toHaveLength(0);
  });

  it('re-indexes entities that cross a spatial cell boundary', () => {
    const registry = new EntityRegistry(64);
    const entity = registry.add(prop(0, 0));
    registry.move(entity.id, 5000, 5000);
    expect(entity.position.x).toBe(5000);
    expect(registry.nearby(4990, 5000, 20)).toHaveLength(1);
    expect(registry.nearby(0, 0, 20)).toHaveLength(0);
  });

  it('assigns tiered simulation levels from distance and enforces the cascade', () => {
    const registry = new EntityRegistry();
    const positions = [10, 20, 30, 40, 200, 300, 5000];
    for (const z of positions) registry.add(prop(0, z));
    const stats = registry.stream(new Vector3(0, 0, 0), budgets);
    expect(stats.full).toBe(2);
    expect(stats.reduced).toBe(2);
    expect(stats.background).toBe(2);
    expect(stats.dormant).toBe(1);
    expect(stats.changed).toBe(true);
    // Re-streaming with unchanged positions is a no-op.
    expect(registry.stream(new Vector3(0, 0, 0), budgets).changed).toBe(false);
  });

  it('never dims the player and hides dormant visuals', () => {
    const registry = new EntityRegistry();
    const visual = new Object3D();
    const far = registry.add(prop(0, 9000, { visual }));
    const player = registry.add(createEntity({ kind: 'player', position: new Vector3(0, 9000, 0) }));
    registry.stream(new Vector3(0, 0, 0), budgets);
    expect(far.simulation).toBe(SIMULATION_DORMANT);
    expect(far.lifecycle).toBe('dormant');
    expect(far.visual?.visible).toBe(false);
    expect(player.simulation).toBe(SIMULATION_FULL);
    expect(player.lifecycle).toBe('active');
  });

  it('runs full-fidelity ticks every frame and reduced ticks at a lower cadence', () => {
    const registry = new EntityRegistry();
    let fullTicks = 0, reducedTicks = 0;
    const near = prop(0, 10);
    near.tick = () => { fullTicks += 1; };
    const medium = prop(0, 200);
    medium.tick = () => { reducedTicks += 1; };
    registry.add(near);
    registry.add(medium);
    registry.stream(new Vector3(0, 0, 0), budgets);
    expect(near.simulation).toBe(SIMULATION_FULL);
    expect(medium.simulation).toBe(SIMULATION_REDUCED);
    let executed = 0;
    for (let frame = 0; frame < 60; frame++) executed += registry.tick(1 / 60);
    expect(fullTicks).toBe(60);
    expect(reducedTicks).toBeGreaterThanOrEqual(14);
    expect(reducedTicks).toBeLessThanOrEqual(16);
    expect(executed).toBe(fullTicks + reducedTicks);
  });

  it('translates attached visuals during a floating-origin rebase', () => {
    const registry = new EntityRegistry();
    const visual = new Object3D();
    visual.position.set(-10, -10, -10);
    registry.add(prop(0, 0, { visual }));
    registry.rebase(new Vector3(2048, 0, 0));
    expect(visual.position.x).toBeCloseTo(-2058, 6);
    // Canonical data is untouched.
    expect(registry.entities().next().value?.position.x).toBe(0);
  });

  it('reports counts by kind and level without iterating consumers', () => {
    const registry = new EntityRegistry();
    registry.add(prop(0, 0));
    registry.add(prop(10, 0));
    registry.add(prop(20, 0, { kind: 'building' }));
    registry.stream(new Vector3(0, 0, 0), budgets);
    const stats = registry.stats();
    expect(stats.total).toBe(3);
    expect(stats.kinds.prop).toBe(2);
    expect(stats.kinds.building).toBe(1);
    expect(stats.cells).toBeGreaterThan(0);
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.stats().cells).toBe(0);
  });
});

describe('event bus', () => {
  it('delivers typed events to subscribers and unsubscribes cleanly', () => {
    const bus = new EventBus();
    const seeds: string[] = [];
    const unsubscribe = bus.on('world:seed-changed', (payload) => seeds.push(payload.seed));
    bus.emit('world:seed-changed', { seed: 'alpha' });
    unsubscribe();
    bus.emit('world:seed-changed', { seed: 'beta' });
    expect(seeds).toEqual(['alpha']);
    expect(bus.listenerCount('world:seed-changed')).toBe(0);
  });

  it('supports one-shot listeners', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.once('world:ready', () => { calls += 1; });
    bus.emit('world:ready', { seed: 'a', backend: 'WebGPU', physics: true });
    bus.emit('world:ready', { seed: 'b', backend: 'WebGPU', physics: true });
    expect(calls).toBe(1);
  });

  it('isolates failing listeners and keeps the rest of the dispatch', () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.onError = (error) => errors.push(error);
    const received: number[] = [];
    bus.on('world:tick', () => { throw new Error('handler bug'); });
    bus.on('world:tick', (payload) => received.push(payload.fixedSteps));
    bus.emit('world:tick', { fixedSteps: 3, dt: 0.016 });
    expect(received).toEqual([3]);
    expect(errors).toHaveLength(1);
  });

  it('keeps a bounded event history for debugging', () => {
    const bus = new EventBus(4);
    for (let i = 0; i < 10; i++) bus.emit('world:quality-changed', { quality: 'high' });
    const history = bus.history();
    expect(history).toHaveLength(4);
    expect(history[history.length - 1]!.type).toBe('world:quality-changed');
    bus.clear();
    expect(bus.history()).toHaveLength(0);
  });

  it('allows unsubscribe from inside a handler', () => {
    const bus = new EventBus();
    const order: string[] = [];
    const off = bus.on('entity:spawned', () => {
      order.push('first');
      off();
    });
    bus.on('entity:spawned', () => order.push('second'));
    bus.emit('entity:spawned', { id: 'prop-1', kind: 'prop' });
    bus.emit('entity:spawned', { id: 'prop-2', kind: 'prop' });
    expect(order).toEqual(['first', 'second', 'second']);
  });
});

describe('simulation level constants', () => {
  it('orders fidelity levels from full to dormant', () => {
    expect(SIMULATION_FULL).toBeLessThan(SIMULATION_REDUCED);
    expect(SIMULATION_REDUCED).toBeLessThan(SIMULATION_BACKGROUND);
    expect(SIMULATION_BACKGROUND).toBeLessThan(SIMULATION_DORMANT);
  });
});
