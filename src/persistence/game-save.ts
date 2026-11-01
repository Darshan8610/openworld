import { DISCOVERY_LIMIT, validPoint } from '../discovery/discovery';
import type { DiscoveryState } from '../discovery/discovery';
import { validateObjectSave } from './object-store';
import type { ObjectSave } from './object-store';

export interface GameSave {
  format: 'wayfarer.game'; version: 1; savedAt: number; seed: string;
  player: { x: number; z: number }; hour: number; cycling: boolean;
  discovery: DiscoveryState; objects: ObjectSave;
}
export interface SaveStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type SlotResult = { status: 'empty' } | { status: 'ok'; save: GameSave } | { status: 'error'; reason: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateGameSave(value: unknown): GameSave {
  if (!record(value) || value.format !== 'wayfarer.game' || value.version !== 1) throw new Error('Unsupported save format/version; slot preserved.');
  const d = value.discovery, p = value.player;
  if (typeof value.seed !== 'string' || value.seed.length > 128 || !record(p) || typeof p.x !== 'number' || typeof p.z !== 'number' || !validPoint({ x: p.x, z: p.z })) throw new Error('Invalid seed or player position.');
  if (typeof value.hour !== 'number' || !Number.isFinite(value.hour) || value.hour < 0 || value.hour >= 24 || typeof value.cycling !== 'boolean' || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) throw new Error('Invalid time.');
  if (!record(d) || !Array.isArray(d.cells) || d.cells.length > DISCOVERY_LIMIT || !d.cells.every(c => typeof c === 'string' && /^-?\d{1,10}:-?\d{1,10}$/.test(c))) throw new Error('Invalid discovery cells.');
  if (d.waypoint !== null && (!record(d.waypoint) || typeof d.waypoint.x !== 'number' || typeof d.waypoint.z !== 'number' || !validPoint({ x: d.waypoint.x, z: d.waypoint.z }))) throw new Error('Invalid waypoint.');
  const objects = validateObjectSave(value.objects);
  if (objects.status !== 'ok' || objects.save.version !== 1 || objects.save.seed !== value.seed) throw new Error('Invalid object snapshot.');
  return { format: 'wayfarer.game', version: 1, seed: value.seed, savedAt: value.savedAt, player: { x: p.x, z: p.z }, hour: value.hour, cycling: value.cycling,
    discovery: { cells: [...d.cells] as string[], waypoint: d.waypoint === null ? null : { x: (d.waypoint as {x:number}).x, z: (d.waypoint as {z:number}).z } }, objects: objects.save };
}
/** Each localStorage setItem is atomic. Never replace an unreadable/newer slot. */
export class GameSaveStore {
  constructor(private readonly storage: SaveStorage) {}
  private key(slot: number): string {
    if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('Choose slot 1–3.');
    return `wayfarer.game.slot.${slot}`;
  }
  load(slot: number): SlotResult {
    try {
      const raw = this.storage.getItem(this.key(slot));
      if (raw === null) return { status: 'empty' };
      if (raw.length > 4_000_000) throw new Error('Save exceeds size budget.');
      return { status: 'ok', save: validateGameSave(JSON.parse(raw)) };
    } catch (error) { return { status: 'error', reason: String(error) }; }
  }
  save(slot: number, save: GameSave): SlotResult {
    try {
      const previous = this.load(slot);
      if (previous.status === 'error') return previous;
      const clean = validateGameSave(save), raw = JSON.stringify(clean);
      if (raw.length > 4_000_000) throw new Error('Save exceeds size budget.');
      this.storage.setItem(this.key(slot), raw);
      return { status: 'ok', save: clean };
    } catch (error) { return { status: 'error', reason: String(error) }; }
  }
}
