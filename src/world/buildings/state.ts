import { BUILDING_SETTINGS } from './settings';

export interface BuildingStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
export interface BuildingModifications { version: 1; seed: string; doors: Record<string, boolean> }

/** Only door deltas, never generated world data. Replace this adapter with Phase 6's save service. */
export class BuildingState {
  private doors = new Map<string, boolean>();
  private writable = true;
  private dirty = false;
  private readonly key: string;
  constructor(readonly seed: string, private readonly storage?: BuildingStorage, private readonly warn: (message: string) => void = console.warn) {
    this.key = `wayfarer.buildings.v1:${encodeURIComponent(seed)}`;
    if (!storage) return;
    try {
      const raw = storage.getItem(this.key);
      if (raw !== null) this.restore(JSON.parse(raw));
    } catch (error) { this.writable = false; this.warn(`Building save was not loaded or overwritten: ${error instanceof Error ? error.message : String(error)}`); }
  }
  isOpen(id: string): boolean { return this.doors.get(id) ?? false; }
  setOpen(id: string, open: boolean): boolean {
    if (!this.validDoorId(id) || typeof open !== 'boolean') throw new Error('Invalid persistent building door');
    if (!this.doors.has(id) && this.doors.size >= BUILDING_SETTINGS.maxDoorModifications) { this.warn('Building door modification budget reached; use the central save adapter to expand it.'); return false; }
    this.doors.set(id, open); this.dirty = true;
    return true;
  }
  snapshot(): BuildingModifications { return { version: 1, seed: this.seed, doors: Object.fromEntries(this.doors) }; }
  restore(value: unknown): void {
    if (!value || typeof value !== 'object') throw new Error('Invalid building save');
    const data = value as Partial<BuildingModifications>;
    if (data.version !== 1 || data.seed !== this.seed || !data.doors || typeof data.doors !== 'object' || Array.isArray(data.doors)) throw new Error('Unsupported building save version, seed or schema');
    const entries = Object.entries(data.doors);
    if (entries.length > BUILDING_SETTINGS.maxDoorModifications || entries.some(([id, open]) => !this.validDoorId(id) || typeof open !== 'boolean')) throw new Error('Invalid building door modifications');
    this.doors = new Map(entries);
  }
  flush(): void {
    if (!this.storage || !this.writable || !this.dirty) return;
    try {
      const value = JSON.stringify(this.snapshot());
      this.storage.setItem(`${this.key}:pending`, value);
      this.storage.setItem(this.key, value);
      this.storage.removeItem(`${this.key}:pending`);
      this.dirty = false;
    } catch (error) { this.writable = false; this.warn(`Building state remains in memory; storage write failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private validDoorId(id: string): boolean { return id.length < 240 && /^(b1:[0-9a-f]+:-?\d+:-?\d+:-?1|authored:[a-zA-Z0-9_-]+)\/door\/[a-zA-Z0-9_-]+$/.test(id); }
  get stats() { return { modifiedDoors: this.doors.size, storageWritable: this.writable && !!this.storage }; }
}
