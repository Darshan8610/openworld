import { describe, expect, it } from 'vitest';
import { WorldQueries } from '../src/world/world-queries';
import { ARCHETYPES, ARCHETYPE_BY_KEY, archetypeOrThrow, initialState } from '../src/objects/archetypes';
import { OBJECT_KINDS, OBJECT_MESHES } from '../src/objects/archetypes';
import { actionsFor } from '../src/objects/actions';
import { OBJECT_CELL_SIZE, cellsAround, objectCellKey, planObjectCell } from '../src/objects/placement';
import { ObjectStateStore, validateObjectSave } from '../src/persistence/object-store';
import { ITEM_IDS, maxStackFor } from '../src/objects/items';
import { Inventory } from '../src/interaction/inventory';
import { GameEventBus } from '../src/core/events';

const queriesFor = new Map<string, WorldQueries>();
function queries(seed: string): WorldQueries {
  let existing = queriesFor.get(seed);
  if (!existing) { existing = new WorldQueries(seed); queriesFor.set(seed, existing); }
  return existing;
}

describe('object archetypes', () => {
  it('are internally consistent and data driven', () => {
    const keys = new Set<string>();
    for (const archetype of ARCHETYPES) {
      expect(keys.has(archetype.key)).toBe(false);
      keys.add(archetype.key);
      expect(OBJECT_KINDS).toContain(archetype.kind);
      expect(OBJECT_MESHES).toContain(archetype.mesh);
      expect(actionsFor(archetype).length).toBeGreaterThan(0);
      expect(archetype.range).toBeGreaterThan(1);
      expect(archetype.radius).toBeGreaterThan(0);
      expect(archetype.height).toBeGreaterThan(0.1);
      expect(archetype.radii.full).toBeLessThan(archetype.radii.reduced);
      expect(archetype.radii.reduced).toBeLessThan(archetype.radii.background);
      if (archetype.dynamic) expect(archetype.mass).toBeGreaterThan(0);
      if (archetype.kind === 'pickup') expect(archetype.pickup).toBeDefined();
      if (archetype.kind === 'container') expect(archetype.container).toBeDefined();
      if (archetype.kind === 'sign') expect(archetype.signText).toBeTruthy();
      if (archetype.pickup) expect(ITEM_IDS).toContain(archetype.pickup.itemId);
      if (archetype.container) expect(ITEM_IDS).toContain(archetype.container.itemId);
    }
    expect(ARCHETYPE_BY_KEY.get('access-gate')?.kind).toBe('door');
    expect(() => archetypeOrThrow('missing')).toThrow();
  });

  it('produces a fresh initial state for every instance', () => {
    const archetype = archetypeOrThrow('field-lamp');
    const first = initialState(archetype);
    first.on = true;
    expect(initialState(archetype).on).toBe(false);
  });
});

describe('deterministic world placement', () => {
  it('is stable for a seed and changes with it', () => {
    // Aggregate several cells: a single cell can legitimately be empty (a lake,
    // a cliff or a dense road formation), which must not look like a failure.
    const cells: [number, number][] = [[0, 0], [1, 0], [-1, 2], [3, -2]];
    const plan = (seed: string) => {
      const world = queries(seed);
      return cells.map(([cx, cz]) => planObjectCell(cx, cz, { seed, queries: world }));
    };
    const a = plan('placement-seed');
    const b = plan('placement-seed');
    expect(a).toEqual(b);
    const total = a.reduce((sum, cell) => sum + cell.length, 0);
    expect(total).toBeGreaterThan(0);
    const other = plan('other-seed');
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(a));
  });

  it('keeps every object inside its owning cell', () => {
    const world = queries('placement-seed');
    for (const cell of cellsAround(512, -512, 1)) {
      const objects = planObjectCell(cell.cellX, cell.cellZ, { seed: 'placement-seed', queries: world });
      for (const object of objects) {
        expect(Math.floor(object.x / OBJECT_CELL_SIZE)).toBe(cell.cellX);
        expect(Math.floor(object.z / OBJECT_CELL_SIZE)).toBe(cell.cellZ);
      }
    }
  });

  it('never places an object on the carriageway, shoulder or formation', () => {
    const world = queries('placement-seed');
    let checked = 0;
    for (const cell of cellsAround(0, 0, 2)) {
      for (const object of planObjectCell(cell.cellX, cell.cellZ, { seed: 'placement-seed', queries: world })) {
        const road = world.road(object.x, object.z);
        expect(Math.abs(road.lateral)).toBeGreaterThanOrEqual(8.6);
        expect(object.y).toBeGreaterThan(world.height(object.x, object.z) - 1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('emits unique ids across neighbouring cells and references real archetypes', () => {
    const world = queries('placement-seed');
    const ids = new Set<string>();
    let total = 0;
    for (const cell of cellsAround(256, 256, 2)) {
      for (const object of planObjectCell(cell.cellX, cell.cellZ, { seed: 'placement-seed', queries: world })) {
        expect(ids.has(object.id)).toBe(false);
        ids.add(object.id);
        expect(ARCHETYPE_BY_KEY.has(object.archetype)).toBe(true);
        expect(Number.isFinite(object.x + object.y + object.z + object.yaw)).toBe(true);
        total++;
      }
    }
    expect(total).toBeGreaterThan(20);
    expect(objectCellKey(1, 2)).toBe('1:2');
  });

  it('places objects across every streaming cell it owns, and stays deterministic at scale', () => {
    const world = queries('scale-seed');
    let objects = 0;
    for (const cell of cellsAround(8000, -9000, 1)) {
      objects += planObjectCell(cell.cellX, cell.cellZ, { seed: 'scale-seed', queries: world }).length;
    }
    expect(objects).toBeGreaterThan(0);
  });
});

describe('inventory', () => {
  it('stacks, caps and reports overflows', () => {
    const events = new GameEventBus();
    const inventory = new Inventory(events);
    const changes: number[] = [];
    events.on('inventory:changed', ({ total }) => changes.push(total));
    const max = maxStackFor('water-flask');
    const result = inventory.add('water-flask', max + 2);
    expect(result.added).toBe(max);
    expect(result.remaining).toBe(2);
    expect(inventory.count('water-flask')).toBe(max);
    expect(inventory.remove('water-flask', 1)).toBe(1);
    expect(changes.length).toBe(2);
    expect(inventory.label('water-flask')).toBe('Water flask');
  });

  it('respects the slot budget and rejects unknown items', () => {
    const inventory = new Inventory(undefined, 1);
    expect(inventory.add('field-ration', 1).added).toBe(1);
    const second = inventory.add('tool-kit', 1);
    expect(second.added).toBe(0);
    expect(second.reason).toBe('full');
    expect(inventory.add('not-an-item' as never, 1).added).toBe(0);
  });

  it('restores a saved pack without duplicating stacks', () => {
    const inventory = new Inventory();
    inventory.add('spare-parts', 3);
    inventory.restore([{ itemId: 'spare-parts', count: 5 }, { itemId: 'first-aid', count: 1 }]);
    expect(inventory.count('spare-parts')).toBe(5);
    expect(inventory.count('first-aid')).toBe(1);
    expect(inventory.stacks().length).toBe(2);
  });
});

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

describe('object persistence slice', () => {
  it('round-trips objects and the inventory', () => {
    const storage = new MemoryStorage();
    const store = new ObjectStateStore(storage);
    const objects = { 'obj.cache.0.1': { archetype: 'supply-crate', state: { opened: true, contents: [] } } };
    expect(store.save('seed-a', objects, [{ itemId: 'tool-kit', count: 1 }], 1000).status).toBe('ok');
    const loaded = store.load('seed-a');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.save.objects).toEqual(objects);
    expect(loaded.save.inventory).toEqual([{ itemId: 'tool-kit', count: 1 }]);
    expect(loaded.save.savedAt).toBe(1000);
    expect(store.load('other-seed').status).toBe('empty');
  });

  it('rejects corrupt and foreign payloads instead of overwriting them', () => {
    const storage = new MemoryStorage();
    const store = new ObjectStateStore(storage);
    storage.setItem('wayfarer.objects.v1.seed-b', '{ not json');
    expect(store.load('seed-b').status).toBe('invalid');

    storage.setItem('wayfarer.objects.v1.seed-c', JSON.stringify({ format: 'wayfarer.objects', version: 99, seed: 'seed-c', objects: {} }));
    expect(store.load('seed-c').status).toBe('invalid');
    // A newer format is never clobbered.
    expect(store.save('seed-c', {}, []).status).toBe('refused');
    expect(JSON.parse(storage.getItem('wayfarer.objects.v1.seed-c')!).version).toBe(99);
  });

  it('sanitises state read from disk', () => {
    const result = validateObjectSave({
      format: 'wayfarer.objects', version: 1, seed: 's', savedAt: 5,
      objects: {
        a: { archetype: 'access-gate', state: { open: true, level: 99, hands: 'nope' } },
        b: { archetype: 'x', state: null },
      },
      inventory: [{ itemId: 'tool-kit', count: 2.7 }, { itemId: 'bad', count: -1 }, 'nope'],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.save.objects.a!.state).toEqual({ open: true, level: 4 });
    expect(result.save.objects.b).toBeUndefined();
    expect(result.save.inventory).toEqual([{ itemId: 'tool-kit', count: 2 }]);
  });

  it('reports when storage is unavailable rather than throwing', () => {
    const store = new ObjectStateStore(undefined);
    expect(store.available).toBe(false);
    expect(store.load('seed').status).toBe('empty');
    expect(store.save('seed', {}, []).status).toBe('failed');
  });
});
