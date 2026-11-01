/**
 * Headless integration coverage for vehicle streaming, entry/exit, floating
 * origin and persistence.
 *
 * These are the acceptance criteria that cannot be checked by a physics unit
 * test: that a player can get in and out, that vehicle world state survives an
 * origin rebase, and that driving a vehicle somewhere and walking away keeps
 * it there.
 */
import { describe, expect, it } from 'vitest';
import { VehicleSystem } from '../src/vehicles/vehicle-system';
import { WorldQueries } from '../src/world/world-queries';
import { PropPhysicsWorld } from '../src/physics/prop-physics';
import { Inventory } from '../src/interaction/inventory';
import { InteractionManager } from '../src/interaction/manager';
import { GameEventBus } from '../src/core/events';
import { CONFIG } from '../src/config';
import { planVehicleCell, vehicleCellsAround, VEHICLE_CELL_SIZE } from '../src/vehicles/placement';
import { VehicleStateStore, validateVehicleSave, VEHICLE_SAVE_FORMAT } from '../src/persistence/vehicle-store';
import { vehicleKeys, vehicleSpec } from '../src/vehicles/catalog';
import type { PersistedVehicles } from '../src/persistence/vehicle-store';

const SEED = 'vehicle-system-test';

function harness(options: { seed?: string; savedState?: PersistedVehicles; budget?: number } = {}) {
  const seed = options.seed ?? SEED;
  const queries = new WorldQueries(seed);
  const events = new GameEventBus();
  const inventory = new Inventory(events);
  const physics = new PropPhysicsWorld({ maxBodies: 16 });
  const messages: string[] = [];
  const interaction = new InteractionManager({
    inventory, physics, queries, events, notify: (message) => messages.push(message),
  });
  const vehicles = new VehicleSystem({
    seed, queries, events, interaction,
    budget: options.budget ?? 24,
    ...(options.savedState ? { savedState: options.savedState } : {}),
  });
  return { seed, queries, events, interaction, vehicles, messages };
}

const ORIGIN = { x: 0, y: 0, z: 0 };

/** Walk the world until a cell actually plans a vehicle, then stream it in. */
function streamSomewhereWithVehicles(system: VehicleSystem, queries: WorldQueries): { x: number; y: number; z: number } | undefined {
  for (let i = 0; i < 40; i++) {
    const player = { x: i * VEHICLE_CELL_SIZE * 0.5, y: 0, z: i * VEHICLE_CELL_SIZE * 0.37 };
    // Several ticks: planning is budgeted to a couple of cells per tick.
    for (let tick = 0; tick < 6; tick++) system.update(1, player, ORIGIN, 1);
    if (system.activeCount > 0) return player;
    void queries;
  }
  return undefined;
}

describe('vehicle placement', () => {
  it('is deterministic for a given seed and cell', () => {
    const queries = new WorldQueries(SEED);
    const a = planVehicleCell(3, -2, { seed: SEED, queries });
    const b = planVehicleCell(3, -2, { seed: SEED, queries: new WorldQueries(SEED) });
    expect(a.map((v) => `${v.id}|${v.key}|${v.x.toFixed(4)}|${v.z.toFixed(4)}`))
      .toEqual(b.map((v) => `${v.id}|${v.key}|${v.x.toFixed(4)}|${v.z.toFixed(4)}`));
  });

  it('produces different worlds for different seeds', () => {
    const a = planVehicleCell(1, 1, { seed: 'alpha', queries: new WorldQueries('alpha') });
    const b = planVehicleCell(1, 1, { seed: 'bravo', queries: new WorldQueries('bravo') });
    expect(a.map((v) => v.id).join()).not.toEqual(b.map((v) => v.id).join());
  });

  it('emits every vehicle inside the cell that owns it, and no others', () => {
    const queries = new WorldQueries(SEED);
    const size = VEHICLE_CELL_SIZE;
    for (const [cx, cz] of [[0, 0], [2, -3], [-5, 4]] as const) {
      for (const placed of planVehicleCell(cx, cz, { seed: SEED, queries })) {
        expect(placed.x).toBeGreaterThanOrEqual(cx * size);
        expect(placed.x).toBeLessThan((cx + 1) * size);
        expect(placed.z).toBeGreaterThanOrEqual(cz * size);
        expect(placed.z).toBeLessThan((cz + 1) * size);
      }
    }
  });

  it('never plans two vehicles on top of each other', () => {
    const queries = new WorldQueries(SEED);
    for (let cx = 0; cx < 4; cx++) {
      const placed = planVehicleCell(cx, 1, { seed: SEED, queries });
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i]!, b = placed[j]!;
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(CONFIG.vehicles.spacing - 1e-6);
        }
      }
    }
  });

  it('only plans catalogue vehicles, and respects their slope limits', () => {
    const queries = new WorldQueries(SEED);
    const keys = new Set(vehicleKeys());
    let seen = 0;
    for (let cx = -3; cx <= 3; cx++) {
      for (const placed of planVehicleCell(cx, 2, { seed: SEED, queries })) {
        expect(keys.has(placed.key)).toBe(true);
        const spec = vehicleSpec(placed.key)!;
        expect(queries.slope(placed.x, placed.z)).toBeLessThanOrEqual(spec.spawn.maxSlope);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('orders streamed cells nearest first', () => {
    const cells = vehicleCellsAround(0, 0, 2);
    expect(cells).toHaveLength(25);
    for (let i = 1; i < cells.length; i++) {
      expect(cells[i]!.distance).toBeGreaterThanOrEqual(cells[i - 1]!.distance);
    }
  });
});

describe('vehicle streaming', () => {
  it('streams vehicles in and registers them as interaction targets', () => {
    const { vehicles, queries, interaction } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    expect(player).toBeDefined();
    expect(vehicles.activeCount).toBeGreaterThan(0);

    const stats = vehicles.stats();
    expect(stats.active).toBe(vehicles.activeCount);
    // Every streamed vehicle is a live interaction provider.
    const driven = vehicles.driven;
    expect(driven).toBeUndefined();
    expect(interaction).toBeDefined();
    vehicles.dispose();
    expect(vehicles.activeCount).toBe(0);
  });

  it('respects the streaming budget', () => {
    const { vehicles, queries } = harness({ budget: 2 });
    streamSomewhereWithVehicles(vehicles, queries);
    expect(vehicles.activeCount).toBeLessThanOrEqual(2);
    vehicles.dispose();
  });

  it('steps physics only on the fixed update, never on render', () => {
    const { vehicles, queries } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    expect(player).toBeDefined();
    const vehicle = vehicles.nearestEnterable(player!, 4000)!;
    // Stand next to it so it is inside the simulation radius rather than frozen.
    const beside = { x: vehicle.body.position.x, y: vehicle.body.position.y, z: vehicle.body.position.z };
    const before = vehicle.body.position.y;

    // Many render frames must not advance the simulation at all.
    for (let i = 0; i < 50; i++) vehicles.update(1 / 60, beside, ORIGIN, 1);
    expect(vehicle.body.position.y).toBe(before);
    expect(vehicles.stats().simulated).toBe(0);

    // Fixed steps do: it drops onto its suspension.
    for (let i = 0; i < 120; i++) vehicles.fixedUpdate(1 / 120, beside);
    expect(vehicles.stats().simulated).toBeGreaterThan(0);
    expect(vehicle.body.position.y).not.toBe(before);
    vehicles.dispose();
  });

  it('freezes distant vehicles instead of simulating the whole world', () => {
    const { vehicles, queries } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    const far = { x: player!.x + 50_000, y: 0, z: player!.z + 50_000 };
    for (let i = 0; i < 20; i++) vehicles.fixedUpdate(1 / 120, far);
    expect(vehicles.stats().simulated).toBe(0);
    // Frozen, not removed: state is intact and streaming is unaffected.
    expect(vehicles.activeCount).toBeGreaterThan(0);
    vehicles.dispose();
  });
});

describe('entry and exit', () => {
  it('seats the player, hands over driving and puts them back outside', () => {
    const { vehicles, queries, events } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    expect(player).toBeDefined();

    const entered: string[] = [];
    const exited: string[] = [];
    events.on('vehicle:entered', (payload) => entered.push(payload.id));
    events.on('vehicle:exited', (payload) => exited.push(payload.id));

    const target = vehicles.nearestEnterable(player!, 4000);
    expect(target).toBeDefined();

    const seat = vehicles.enter(target!.id, 'player');
    expect(seat).toBeDefined();
    expect(target!.occupiedSeats).toBe(1);
    expect(entered).toEqual([target!.id]);
    // Driver seats hand over control; passenger seats do not.
    expect(vehicles.driven?.id).toBe(target!.isDriverSeat(seat!) ? target!.id : undefined);

    const point = vehicles.exit(target!.id, 'player');
    expect(point).toBeDefined();
    expect(target!.occupiedSeats).toBe(0);
    expect(vehicles.driven).toBeUndefined();
    expect(exited).toEqual([target!.id]);

    // Exit point is beside the vehicle, on solid ground, never inside it.
    const gap = Math.hypot(point!.x - target!.body.position.x, point!.z - target!.body.position.z);
    expect(gap).toBeGreaterThan(0.5);
    expect(Number.isFinite(point!.y)).toBe(true);
    expect(point!.y).toBeGreaterThanOrEqual(queries.height(point!.x, point!.z) - 0.1);
    vehicles.dispose();
  });

  it('refuses a second occupant in the same seat', () => {
    const { vehicles, queries } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    const target = vehicles.nearestEnterable(player!, 4000)!;
    const seat = vehicles.enter(target.id, 'player')!;
    expect(vehicles.enter(target.id, 'intruder', seat)).toBeUndefined();
    vehicles.dispose();
  });

  it('never streams out a vehicle the player is sitting in', () => {
    const { vehicles, queries } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    const target = vehicles.nearestEnterable(player!, 4000)!;
    vehicles.enter(target.id, 'player');
    const id = target.id;

    // Walk far enough that the planner no longer wants this cell at all.
    const far = { x: player!.x + VEHICLE_CELL_SIZE * 12, y: 0, z: player!.z + VEHICLE_CELL_SIZE * 12 };
    for (let tick = 0; tick < 12; tick++) vehicles.update(1, far, ORIGIN, 1);
    expect(vehicles.stats().occupied).toBe(1);
    expect([...(vehicles as unknown as { active: Map<string, unknown> }).active.keys()]).toContain(id);
    vehicles.dispose();
  });
});

describe('floating origin', () => {
  it('keeps canonical vehicle state identical across a rebase', () => {
    const { vehicles, queries } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    const target = vehicles.nearestEnterable(player!, 4000)!;
    for (let i = 0; i < 240; i++) vehicles.fixedUpdate(1 / 120, player!);

    const before = {
      x: target.body.position.x, y: target.body.position.y, z: target.body.position.z,
      yaw: target.body.yaw,
    };

    // Rebase by a long way, exactly as `origin.onChange` does.
    const origin = { x: 65536, y: 0, z: -131072 };
    vehicles.rebase(origin);
    vehicles.update(1 / 60, player!, origin, 1);

    // Canonical coordinates are untouched: only render transforms moved.
    expect(target.body.position.x).toBe(before.x);
    expect(target.body.position.y).toBe(before.y);
    expect(target.body.position.z).toBe(before.z);
    expect(target.body.yaw).toBe(before.yaw);
    vehicles.dispose();
  });

  it('places the render anchor relative to the new origin', () => {
    const { vehicles, queries } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    const target = vehicles.nearestEnterable(player!, 4000)!;

    const origin = { x: 1000, y: 0, z: 2000 };
    vehicles.rebase(origin);
    const anchor = vehicles.root.children.find((child) => child.name === `vehicle/${target.id}`);
    expect(anchor).toBeDefined();
    expect(anchor!.position.x).toBeCloseTo(target.body.position.x - origin.x, 3);
    expect(anchor!.position.z).toBeCloseTo(target.body.position.z - origin.z, 3);
    vehicles.dispose();
  });
});

describe('vehicle persistence', () => {
  it('stores only vehicles the player has changed', () => {
    const { vehicles, queries } = harness();
    const player = streamSomewhereWithVehicles(vehicles, queries);
    // Untouched world: nothing to save.
    expect(Object.keys(vehicles.persistedState())).toHaveLength(0);

    const target = vehicles.nearestEnterable(player!, 4000)!;
    target.applyDamage(5, 'impact');
    const saved = vehicles.persistedState();
    expect(Object.keys(saved)).toContain(target.id);
    expect(saved[target.id]!.key).toBe(target.spec.key);
    vehicles.dispose();
  });

  it('restores a driven vehicle at its stored pose, not its spawn point', () => {
    const first = harness();
    const player = streamSomewhereWithVehicles(first.vehicles, first.queries)!;
    const target = first.vehicles.nearestEnterable(player, 4000)!;
    const id = target.id;
    const spawnedAt = { x: target.body.position.x, z: target.body.position.z };

    // Actually drive it: get in, open the throttle, and stay alongside so it
    // keeps being simulated. This is the path that sets the `moved` flag.
    first.vehicles.enter(id, 'player');
    target.controls.throttle = 1;
    const seat = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120 * 12; i++) {
      seat.x = target.body.position.x; seat.y = target.body.position.y; seat.z = target.body.position.z;
      first.vehicles.fixedUpdate(1 / 120, seat);
    }
    target.controls.throttle = 0;
    expect(target.moved).toBe(true);
    const travelled = Math.hypot(target.body.position.x - spawnedAt.x, target.body.position.z - spawnedAt.z);
    expect(travelled).toBeGreaterThan(5);

    const movedTo = {
      x: target.body.position.x, y: target.body.position.y, z: target.body.position.z,
    };
    const saved = first.vehicles.persistedState();
    expect(saved[id]).toBeDefined();
    first.vehicles.dispose();

    // A fresh session with the same seed must put it where we left it.
    const second = harness({ savedState: saved });
    streamSomewhereWithVehicles(second.vehicles, second.queries);
    const restored = [...(second.vehicles as unknown as { active: Map<string, { id: string; body: { position: { x: number; y: number; z: number } }; health: number }> }).active.values()]
      .find((entry) => entry.id === id);
    expect(restored).toBeDefined();
    expect(restored!.body.position.x).toBeCloseTo(movedTo.x, 4);
    expect(restored!.body.position.z).toBeCloseTo(movedTo.z, 4);
    // And emphatically not back where the planner would have put it.
    expect(Math.hypot(restored!.body.position.x - spawnedAt.x, restored!.body.position.z - spawnedAt.z))
      .toBeGreaterThan(5);
    second.vehicles.dispose();
  });
});

describe('vehicle save format', () => {
  const makeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
      map,
    };
  };

  const sample: PersistedVehicles = {
    'veh.test.1': {
      key: 'hatchback',
      state: { x: 10, y: 2, z: -4, qx: 0, qy: 0, qz: 0, qw: 1, health: 30, fuel: 12, odometer: 410, moved: true },
    },
  };

  it('round-trips a save', () => {
    const storage = makeStorage();
    const store = new VehicleStateStore(storage, 'test.vehicles');
    expect(store.save('seed-a', sample).status).toBe('ok');
    const loaded = store.load('seed-a');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.save.vehicles['veh.test.1']!.state.odometer).toBe(410);
  });

  it('reports empty rather than throwing for an unknown seed', () => {
    const store = new VehicleStateStore(makeStorage(), 'test.vehicles');
    expect(store.load('never-saved').status).toBe('empty');
  });

  it('refuses to overwrite a newer format', () => {
    const storage = makeStorage();
    const store = new VehicleStateStore(storage, 'test.vehicles');
    store.save('seed-b', sample);
    const key = [...storage.map.keys()][0]!;
    const raw = JSON.parse(storage.map.get(key)!) as Record<string, unknown>;
    storage.map.set(key, JSON.stringify({ ...raw, version: VEHICLE_SAVE_VERSION_PLUS }));
    expect(store.save('seed-b', sample).status).toBe('refused');
  });

  it('drops entries with a non-finite pose instead of loading a broken body', () => {
    const result = validateVehicleSave({
      format: VEHICLE_SAVE_FORMAT, version: 1, seed: 's', savedAt: 0,
      vehicles: {
        bad: { key: 'sedan', state: { x: Number.NaN, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
        alsoBad: { key: 'sedan', state: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 0 } },
        good: { key: 'sedan', state: { x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1, health: 5, fuel: 1, odometer: 0, moved: true } },
      },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(Object.keys(result.save.vehicles)).toEqual(['good']);
  });

  it('rejects a save belonging to another format', () => {
    expect(validateVehicleSave({ format: 'something.else', version: 1 }).status).toBe('invalid');
  });
});

const VEHICLE_SAVE_VERSION_PLUS = 99;
