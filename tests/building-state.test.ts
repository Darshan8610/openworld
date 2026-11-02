import { describe, expect, it } from 'vitest';
import { BuildingState } from '../src/world/buildings/state';
import type { BuildingStorage } from '../src/world/buildings/state';
import { BUILDING_SETTINGS } from '../src/world/buildings/settings';

class MemoryStorage implements BuildingStorage {
  readonly data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const door = 'authored:building/door/entrance';

describe('building-only delta persistence', () => {
  it('persists door changes without serializing any generated baseline geometry', () => {
    const storage = new MemoryStorage(), state = new BuildingState('test', storage);
    state.setOpen(door, true); state.flush();
    expect(new BuildingState('test', storage).isOpen(door)).toBe(true);
    expect(new BuildingState('other-seed', storage).isOpen(door)).toBe(false);
    expect(storage.data.size).toBe(1);
    expect(JSON.parse([...storage.data.values()][0]!)).toEqual({ version: 1, seed: 'test', doors: { [door]: true } });
  });
  it('roundtrips data-only snapshots for the central save adapter', () => {
    const state = new BuildingState('test'); state.setOpen(door, true);
    const again = new BuildingState('test'); again.restore(state.snapshot());
    expect(again.snapshot()).toEqual(state.snapshot());
  });
  it('does not overwrite corrupt, foreign-seed or newer-format saves', () => {
    for (const raw of ['{bad json', JSON.stringify({ version: 2, seed: 'test', doors: {} }), JSON.stringify({ version: 1, seed: 'foreign', doors: {} })]) {
      const storage = new MemoryStorage(), warnings: string[] = [];
      storage.setItem('wayfarer.buildings.v1:test', raw);
      const state = new BuildingState('test', storage, (warning) => warnings.push(warning));
      state.setOpen(door, true); state.flush();
      expect(storage.getItem('wayfarer.buildings.v1:test')).toBe(raw);
      expect(warnings.length).toBe(1); expect(state.stats.storageWritable).toBe(false);
    }
  });
  it('validates restored state atomically and bounds modifications', () => {
    const warnings: string[] = [], state = new BuildingState('test', undefined, (w) => warnings.push(w));
    state.setOpen(door, true);
    expect(() => state.restore({ version: 1, seed: 'test', doors: { [door]: false, garbage: true } })).toThrow(/Invalid/);
    expect(state.isOpen(door)).toBe(true);
    for (let i = 1; i < BUILDING_SETTINGS.maxDoorModifications; i++) state.setOpen(`authored:b${i}/door/entrance`, true);
    expect(state.setOpen('authored:overflow/door/entrance', true)).toBe(false);
    expect(state.stats.modifiedDoors).toBe(BUILDING_SETTINGS.maxDoorModifications); expect(warnings.length).toBe(1);
  });
  it('retains the previous save on quota/write failure and reports it', () => {
    const storage = new MemoryStorage(), warnings: string[] = [];
    const state = new BuildingState('test', storage, (w) => warnings.push(w));
    state.setOpen(door, true); state.flush();
    storage.setItem = () => { throw new Error('quota exceeded'); };
    state.setOpen(door, false); state.flush();
    expect(new BuildingState('test', storage).isOpen(door)).toBe(true);
    expect(state.isOpen(door)).toBe(false); expect(warnings[0]).toContain('quota exceeded');
  });
});
