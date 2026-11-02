import { describe, expect, it } from 'vitest';
import { SpatialGrid } from '../src/core/spatial';
import { EntityRegistry, simulationLevelFor } from '../src/core/entities';
import type { EntitySpec } from '../src/core/entities';
import { GameEventBus } from '../src/core/events';
import { distanceXZ, toRenderPoint } from '../src/core/coordinates';

describe('spatial grid', () => {
  it('finds values within a radius and sorts them nearest first', () => {
    const grid = new SpatialGrid<string>(32);
    grid.set('a', 0, 0, 'a');
    grid.set('b', 10, 0, 'b');
    grid.set('c', 200, 0, 'c');
    expect(grid.near(0, 0, 20)).toEqual(['a', 'b']);
    expect(grid.near(0, 0, 300)).toEqual(['a', 'b', 'c']);
    expect(grid.size).toBe(3);
  });

  it('handles negative coordinates and re-homing between cells', () => {
    const grid = new SpatialGrid<number>(16);
    grid.set('x', -40, -40, 1);
    expect(grid.near(-39, -39, 3)).toEqual([1]);
    grid.set('x', 40, 40, 2);
    expect(grid.near(-40, -40, 3)).toEqual([]);
    expect(grid.near(40, 40, 3)).toEqual([2]);
    expect(grid.delete('x')).toBe(true);
    expect(grid.delete('x')).toBe(false);
    expect(grid.size).toBe(0);
  });

  it('visits an XZ box without duplicates', () => {
    const grid = new SpatialGrid<string>(8);
    grid.set('a', 0, 0, 'a');
    grid.set('b', 4, 4, 'b');
    const seen: string[] = [];
    grid.forEachInBox(-10, -10, 10, 10, (value) => seen.push(value));
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('rejects a non-positive cell size', () => {
    expect(() => new SpatialGrid(0)).toThrow();
  });
});

describe('simulation levels', () => {
  it('bands distance into fidelity levels', () => {
    const radii = { full: 100, reduced: 200, background: 400 };
    expect(simulationLevelFor(50, radii)).toBe('full');
    expect(simulationLevelFor(150, radii)).toBe('reduced');
    expect(simulationLevelFor(300, radii)).toBe('background');
    expect(simulationLevelFor(500, radii)).toBe('culled');
  });
});

const spec = (id: string, x: number, z: number): EntitySpec<{ tag: string }> => ({
  id, kind: 'object', archetype: 'crate',
  position: { x, y: 0, z },
  radius: 0.5,
  radii: { full: 100, reduced: 200, background: 400 },
  persistence: 'world',
  data: { tag: id },
});

describe('entity registry', () => {
  it('registers, queries and unregisters entities by stable id', () => {
    const registry = new EntityRegistry<{ tag: string }>();
    registry.register(spec('obj.1', 0, 0));
    registry.register(spec('obj.2', 30, 0));
    expect(registry.size).toBe(2);
    expect(registry.near(0, 0, 50).map((entity) => entity.id)).toEqual(['obj.1', 'obj.2']);
    expect(registry.get('obj.1')?.data.tag).toBe('obj.1');
    expect(() => registry.register(spec('obj.1', 0, 0))).toThrow();
    expect(registry.unregister('obj.1')).toBe(true);
    expect(registry.unregister('obj.1')).toBe(false);
    expect(registry.near(0, 0, 50).map((entity) => entity.id)).toEqual(['obj.2']);
  });

  it('recomputes streaming levels and reports which entities changed', () => {
    const registry = new EntityRegistry<{ tag: string }>();
    registry.register(spec('near', 10, 0));
    registry.register(spec('mid', 150, 0));
    registry.register(spec('far', 1200, 0));
    const changed = registry.updateLevels({ x: 0, y: 0, z: 0 });
    // `far` starts culled, so only the two that changed band are reported.
    expect(changed.map((entity) => entity.id).sort()).toEqual(['mid', 'near']);
    const stats = registry.stats;
    expect(stats.byLevel.full).toBe(1);
    expect(stats.byLevel.reduced).toBe(1);
    expect(stats.byLevel.culled).toBe(1);
    // Nothing changes when the player has not moved.
    expect(registry.updateLevels({ x: 0, y: 0, z: 0 })).toEqual([]);
  });

  it('tracks lifecycle state and position updates', () => {
    const registry = new EntityRegistry<{ tag: string }>();
    const entity = registry.register(spec('moving', 0, 0), 12);
    expect(entity.registeredAt).toBe(12);
    registry.setPosition('moving', { x: 500, y: 0, z: 500 });
    expect(entity.position.x).toBe(500);
    expect(registry.near(500, 500, 5).length).toBe(1);
    registry.setState('moving', 'dormant');
    expect(registry.stats.dormant).toBe(1);
    registry.clear();
    expect(registry.stats.total).toBe(0);
  });
});

describe('typed game events', () => {
  it('delivers, unsubscribes and honours once()', () => {
    const bus = new GameEventBus();
    const seen: string[] = [];
    const off = bus.on('object:spawned', ({ id }) => seen.push(id));
    bus.emit('object:spawned', { id: 'a', archetype: 'crate', kind: 'container' });
    off();
    bus.emit('object:spawned', { id: 'b', archetype: 'crate', kind: 'container' });
    expect(seen).toEqual(['a']);

    let once = 0;
    bus.once('item:collected', () => once++);
    bus.emit('item:collected', { objectId: 'o', itemId: 'tool-kit', count: 1, total: 1 });
    bus.emit('item:collected', { objectId: 'o', itemId: 'tool-kit', count: 1, total: 2 });
    expect(once).toBe(1);
  });

  it('isolates a throwing handler from the rest of the simulation', () => {
    const bus = new GameEventBus();
    const originalError = console.error;
    console.error = () => {};
    try {
      bus.on('object:stateChanged', () => { throw new Error('boom'); });
      const seen: string[] = [];
      bus.on('object:stateChanged', ({ id }) => seen.push(id));
      expect(() => bus.emit('object:stateChanged', { id: 'x', archetype: 'a', state: {} })).not.toThrow();
      expect(seen).toEqual(['x']);
    } finally {
      console.error = originalError;
    }
  });

  it('keeps a bounded history for debugging', () => {
    const bus = new GameEventBus(3);
    for (let i = 0; i < 5; i++) bus.emit('object:despawned', { id: String(i) });
    expect(bus.history().length).toBe(3);
    expect(bus.history().at(-1)?.type).toBe('object:despawned');
    bus.clear();
    expect(bus.history().length).toBe(0);
  });
});

describe('world coordinates', () => {
  it('converts canonical positions to origin-relative render positions', () => {
    const render = toRenderPoint({ x: 5000, y: 120, z: -3000 }, { x: 4096, y: 0, z: -2048 }, { x: 0, y: 0, z: 0 });
    expect(render).toEqual({ x: 904, y: 120, z: -952 });
    expect(distanceXZ(0, 0, 3, 4)).toBe(5);
  });
});
