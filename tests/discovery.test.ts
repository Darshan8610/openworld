import { describe, expect, it } from 'vitest';
import { Discovery, DISCOVERY_LIMIT } from '../src/discovery/discovery';
import { GameSaveStore, validateGameSave } from '../src/persistence/game-save';
import type { GameSave } from '../src/persistence/game-save';
const sample = (): GameSave => ({ format: 'wayfarer.game', version: 1, seed: 'test', savedAt: 1, player: { x: -100000, z: 2048 }, hour: 12, cycling: true, discovery: { cells: ['-1:8'], waypoint: { x: 1, z: 2 } }, objects: { format: 'wayfarer.objects', version: 1, seed: 'test', savedAt: 1, objects: {}, inventory: [] } });
const storage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
describe('Phase 11 discovery', () => {
  it('uses floor for negative canonical coordinates and ignores duplicate visits', () => { const d = new Discovery(); expect(d.visit({ x: -1, z: -1 })).toBe(true); expect(d.visit({ x: -255, z: -255 })).toBe(false); expect(d.snapshot().cells).toEqual(['-1:-1']); });
  it('bounds exploration memory without evicting discovered cells', () => { const d = new Discovery(); for (let i = 0; i < DISCOVERY_LIMIT + 2; i++) d.visit({ x: i * 256, z: 0 }); expect(d.snapshot().cells.length).toBe(DISCOVERY_LIMIT); });
  it('roundtrips large canonical coordinates without any render-origin dependency', () => { const d = new Discovery(); d.visit({ x: 1e9, z: -1e9 }); d.setWaypoint({ x: -1e8, z: 1e8 }); const copy = new Discovery(); copy.restore(d.snapshot()); expect(copy.snapshot()).toEqual(d.snapshot()); });
  it('rejects nonfinite waypoints and visits', () => { const d = new Discovery(); expect(d.visit({ x: NaN, z: 0 })).toBe(false); expect(() => d.setWaypoint({ x: Infinity, z: 0 })).toThrow(); });
});
describe('Phase 11 slots', () => {
  it('roundtrips isolated slots', () => { const store = new GameSaveStore(storage()); expect(store.save(1, sample()).status).toBe('ok'); expect(store.load(2).status).toBe('empty'); expect(store.load(1)).toEqual({ status: 'ok', save: sample() }); });
  it.each(['{broken', JSON.stringify({ ...sample(), version: 99 })])('preserves corrupt/newer data: %s', raw => { const s = storage(); s.setItem('wayfarer.game.slot.1', raw); expect(new GameSaveStore(s).save(1, sample()).status).toBe('error'); expect(s.getItem('wayfarer.game.slot.1')).toBe(raw); });
  it('rejects wrong seeds, invalid time, oversized discovery and invalid slots', () => {
    expect(() => validateGameSave({ ...sample(), objects: { ...sample().objects, seed: 'other' } })).toThrow();
    expect(() => validateGameSave({ ...sample(), hour: NaN })).toThrow();
    expect(() => validateGameSave({ ...sample(), discovery: { cells: Array(8193).fill('0:0'), waypoint: null } })).toThrow();
    expect(new GameSaveStore(storage()).load(4).status).toBe('error');
  });
  it('reports quota failures and leaves the previous atomic value intact', () => { const s = storage(); const store = new GameSaveStore(s); store.save(1, sample()); const raw = s.getItem('wayfarer.game.slot.1'); const blocked = new GameSaveStore({ getItem: s.getItem, setItem() { throw new Error('quota'); } }); expect(blocked.save(1, { ...sample(), hour: 4 }).status).toBe('error'); expect(s.getItem('wayfarer.game.slot.1')).toBe(raw); });
});
