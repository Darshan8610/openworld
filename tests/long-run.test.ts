import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { Discovery, DISCOVERY_LIMIT } from '../src/discovery/discovery';
import { GameEventBus } from '../src/core/events';
import { ObjectiveRuntime } from '../src/game/objectives';
import { FrameProfiler } from '../src/core/profiler';
import { GameSaveStore, validateGameSave } from '../src/persistence/game-save';
import type { GameSave } from '../src/persistence/game-save';

/**
 * Phase 13 — long-run streaming soak.
 *
 * A synthetic 30-minute walk (108k fixed steps, ~30 km, many floating-origin
 * rebases) through the cheap headless systems: floating origin, discovery
 * cells, event bus, objectives, profiler and the save pipeline. Asserts the
 * bounded-state guarantees the whole game relies on: no unbounded collections,
 * no NaN drift, saves that stay valid and under budget, and rebases that stay
 * pinned to the grid.
 */
describe('Phase 13 long-run streaming soak', () => {
  it('holds bounds and validity across a 30-minute walk', () => {
    const STEP = 1 / 60;
    const SECONDS = 30 * 60;
    const origin = new FloatingOrigin();
    const discovery = new Discovery();
    const events = new GameEventBus();
    const objectives = new ObjectiveRuntime(events);
    const profiler = new FrameProfiler();
    const storage = new Map<string, string>();
    const store = new GameSaveStore({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
    });

    objectives.register([{
      id: 'soak', title: 'Soak',
      objectives: [
        { id: 'walk', kind: 'reach', label: 'Far point', point: { x: 28000, z: 0, radius: 120 } },
        { id: 'seen', kind: 'event', label: 'Events', event: 'world:locationDiscovered', count: 50 },
      ],
    }]);
    objectives.start('soak');

    const player = new Vector3(0, 100, 0);
    const visited: string[] = [];
    let savesChecked = 0;
    let eventsEmitted = 0;

    for (let step = 0; step < SECONDS / STEP; step++) {
      // Fast traverse east (~16 m/s) with a gentle sine drift in Z: ~29 km total.
      player.x += 16 * STEP;
      player.z = Math.sin(step * 0.0004) * 60;
      origin.update(player);
      if (!Number.isFinite(player.x) || !Number.isFinite(player.z)) throw new Error('player drifted to NaN');

      // Discovery cells every 256 m of travel.
      if (step % Math.round(256 / 16 / STEP) === 0) {
        if (discovery.visit({ x: player.x, z: player.z })) {
          events.emit('world:locationDiscovered', { x: player.x, z: player.z, cell: 'soak' });
          eventsEmitted++;
          visited.push(`${player.x}`);
        }
      }
      objectives.updatePlayer(player.x, player.z);
      // Simulated render frames at the same rate (profiler bound).
      profiler.record(16 + (step % 7), 4, 8);

      // Save roundtrip every simulated 5 minutes.
      if (step > 0 && step % (300 / STEP | 0) === 0) {
        const save: GameSave = {
          format: 'wayfarer.game', version: 2, savedAt: Date.now(), seed: 'soak',
          player: { x: player.x, z: player.z, yaw: 0.25 },
          hour: (step / 3600) % 24, cycling: true, weather: 'clear',
          objectives: objectives.snapshot(),
          discovery: discovery.snapshot(),
          objects: { format: 'wayfarer.objects', version: 1, seed: 'soak', savedAt: 1, objects: {}, inventory: [] },
        };
        const result = store.save(0, save);
        expect(result.status).toBe('ok');
        const raw = storage.get('wayfarer.game.autosave')!;
        expect(raw.length).toBeLessThan(4_000_000);
        const loaded = store.load(0);
        expect(loaded.status).toBe('ok');
        if (loaded.status === 'ok') {
          expect(loaded.save.player.x).toBeCloseTo(player.x, 6);
          expect(loaded.save.version).toBe(2);
        }
        savesChecked++;
      }
    }

    // --- Bounds -----------------------------------------------------------
    const cells = discovery.snapshot().cells.length;
    expect(cells).toBeLessThanOrEqual(DISCOVERY_LIMIT);
    // ~29 km / 256 m ≈ 113 cells; linear growth, not quadratic.
    expect(cells).toBeGreaterThan(90);
    expect(cells).toBeLessThan(160);
    expect(profiler.samples).toBeLessThanOrEqual(240);
    expect(savesChecked).toBe(5); // every 5 minutes (10, 20, 30… min marks)
    expect(eventsEmitted).toBe(cells);

    // --- Floating origin --------------------------------------------------
    // After a 30 km walk the origin must sit on the 2048 m grid within 2048 m
    // of the player, and local coordinates must have stayed small.
    const local = origin.toLocal(player, new Vector3());
    expect(Math.abs(local.x)).toBeLessThanOrEqual(2048);
    expect(Math.abs(local.z)).toBeLessThanOrEqual(2048);
    expect(origin.shifts).toBeGreaterThan(10);
    expect(origin.shifts).toBeLessThan(40); // ~29 km / 2048 m ≈ 14, allow headroom
    // Math.abs: a never-rebased axis can legitimately be −0.
    expect(Math.abs(origin.absolute.x % 2048)).toBe(0);
    expect(Math.abs(origin.absolute.z % 2048)).toBe(0);

    // --- Objectives completed by the journey ------------------------------
    const snapshot = objectives.snapshotMission('soak');
    expect(snapshot?.state).toBe('completed');
    expect(objectives.snapshot().flags).toBeDefined();

    // Restore path stays bounded too.
    objectives.restore({
      flags: {}, started: ['soak'], completed: [], counts: { 'soak:seen': 49 },
    });
    expect(objectives.snapshotMission('soak')?.objectives[1]?.progress).toBe(49);
    objectives.dispose();
  });

  it('refuses to grow past the save validator even when the world keeps changing', () => {
    const storage = new Map<string, string>();
    const store = new GameSaveStore({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } });
    const base: GameSave = {
      format: 'wayfarer.game', version: 2, savedAt: 1, seed: 'grow',
      player: { x: 0, z: 0, yaw: 0 }, hour: 1, cycling: true, weather: null,
      objectives: { flags: {}, started: [], completed: [], counts: {} },
      discovery: { cells: ['0:0'], waypoint: null },
      objects: { format: 'wayfarer.objects', version: 1, seed: 'grow', savedAt: 1, objects: {}, inventory: [] },
    };
    for (let i = 0; i < 100; i++) {
      const result = store.save(3, { ...base, savedAt: i });
      expect(result.status).toBe('ok');
    }
    // Oversized discovery is rejected, not stored.
    const oversized: GameSave = { ...base, discovery: { cells: Array(8193).fill('0:0'), waypoint: null } };
    expect(() => validateGameSave(oversized)).toThrow();
    expect(store.save(3, oversized).status).toBe('error');
    expect(storage.get('wayfarer.game.slot.3')!.length).toBeLessThan(4_000_000);
  });
});
