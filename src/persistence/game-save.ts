import { DISCOVERY_LIMIT, validPoint } from '../discovery/discovery';
import type { DiscoveryState } from '../discovery/discovery';
import { validateObjectSave } from './object-store';
import type { ObjectSave } from './object-store';
import { FLAG_LIMIT, FLAG_NAME_MAX, MISSION_LIMIT, OBJECTIVES_PER_MISSION } from '../game/objectives';
import { validateNarrativeState } from '../story/narrative-state';
import type { MissionProgress } from '../game/objectives';

/**
 * Phase 11 — versioned game save.
 *
 * v2 (current) adds `player.yaw`, `weather` (an arbitrary override id or
 * null) and `objectives` (mission progress). v1 saves are migrated in place:
 * yaw 0, weather null, empty objectives. Unknown or corrupt fields always
 * reject the slot — it is never overwritten — and every collection is
 * size-bounded so a hostile save cannot exhaust memory on load.
 */
export interface GameSave {
  format: 'wayfarer.game'; version: 2; savedAt: number; seed: string;
  player: { x: number; z: number; yaw: number };
  hour: number; cycling: boolean;
  /** Weather override id, or null for procedural weather. */
  weather: string | null;
  /** Mission/objective/flag progress. Definitions are content, not save data. */
  objectives: MissionProgress;
  /** Phase 11.3 story campaign snapshot (Echoes of Blackwood Valley). Optional. */
  story?: import('../story/narrative-state').NarrativeState;
  discovery: DiscoveryState; objects: ObjectSave;
}
export interface SaveStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type SlotResult = { status: 'empty' } | { status: 'ok'; save: GameSave } | { status: 'error'; reason: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const EMPTY_OBJECTIVES: MissionProgress = { flags: {}, started: [], completed: [], counts: {} };

function validateObjectives(value: unknown): MissionProgress {
  if (!record(value)) throw new Error('Invalid objectives.');
  const out: MissionProgress = { flags: {}, started: [], completed: [], counts: {} };
  if (record(value.flags)) {
    for (const [name, v] of Object.entries(value.flags)) {
      if (name.length === 0 || name.length > FLAG_NAME_MAX || !(typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string')) throw new Error('Invalid flag.');
      if (Object.keys(out.flags).length >= FLAG_LIMIT) break;
      out.flags[name] = v;
    }
  } else if (value.flags !== undefined) throw new Error('Invalid flags.');
  const ids = (v: unknown, label: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MISSION_LIMIT || !v.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) throw new Error(`Invalid ${label}.`);
    return [...new Set(v)] as string[];
  };
  out.started = ids(value.started, 'started missions');
  out.completed = ids(value.completed, 'completed missions');
  if (record(value.counts)) {
    for (const [key, v] of Object.entries(value.counts)) {
      if (key.length > 260 || typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Invalid objective counts.');
      if (Object.keys(out.counts).length >= MISSION_LIMIT * OBJECTIVES_PER_MISSION) break;
      out.counts[key] = Math.floor(v);
    }
  } else if (value.counts !== undefined) throw new Error('Invalid objective counts.');
  return out;
}

export function validateGameSave(value: unknown): GameSave {
  if (!record(value) || value.format !== 'wayfarer.game' || (value.version !== 1 && value.version !== 2)) throw new Error('Unsupported save format/version; slot preserved.');
  const d = value.discovery, p = value.player;
  if (typeof value.seed !== 'string' || value.seed.length > 128 || !record(p) || typeof p.x !== 'number' || typeof p.z !== 'number' || !validPoint({ x: p.x, z: p.z })) throw new Error('Invalid seed or player position.');
  if (typeof value.hour !== 'number' || !Number.isFinite(value.hour) || value.hour < 0 || value.hour >= 24 || typeof value.cycling !== 'boolean' || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) throw new Error('Invalid time.');
  if (!record(d) || !Array.isArray(d.cells) || d.cells.length > DISCOVERY_LIMIT || !d.cells.every(c => typeof c === 'string' && /^-?\d{1,10}:-?\d{1,10}$/.test(c))) throw new Error('Invalid discovery cells.');
  if (d.waypoint !== null && (!record(d.waypoint) || typeof d.waypoint.x !== 'number' || typeof d.waypoint.z !== 'number' || !validPoint({ x: d.waypoint.x, z: d.waypoint.z }))) throw new Error('Invalid waypoint.');
  const objects = validateObjectSave(value.objects);
  if (objects.status !== 'ok' || objects.save.version !== 1 || objects.save.seed !== value.seed) throw new Error('Invalid object snapshot.');
  // v2-only fields, migrated when absent (v1).
  const yaw = value.version === 2 && typeof p.yaw === 'number' && Number.isFinite(p.yaw) ? p.yaw : 0;
  if (value.version === 2 && typeof p.yaw !== 'number') throw new Error('Invalid player yaw.');
  const weather = value.version === 2 ? value.weather : null;
  if (weather !== null && (typeof weather !== 'string' || weather.length > 64)) throw new Error('Invalid weather override.');
  const objectives = value.version === 2 ? validateObjectives(value.objectives ?? EMPTY_OBJECTIVES) : { flags: {}, started: [], completed: [], counts: {} };
  // Story block is optional and lenient: invalid shapes drop to "no story state"
  // so a newer build's save never fails an older load.
  const story = value.version === 2 && value.story !== undefined
    ? (validateNarrativeState(value.story) ?? undefined)
    : undefined;
  return { format: 'wayfarer.game', version: 2, seed: value.seed, savedAt: value.savedAt,
    player: { x: p.x, z: p.z, yaw },
    hour: value.hour, cycling: value.cycling, weather, objectives, story,
    discovery: { cells: [...d.cells] as string[], waypoint: d.waypoint === null ? null : { x: (d.waypoint as {x:number}).x, z: (d.waypoint as {z:number}).z } }, objects: objects.save };
}
/** Each localStorage setItem is atomic. Never replace an unreadable/newer slot. */
export class GameSaveStore {
  constructor(private readonly storage: SaveStorage) {}
  private key(slot: number): string {
    // Slot 0 is the autosave; manual slots remain 1–3.
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error('Choose slot 0–3 (0 = autosave).');
    return slot === 0 ? 'wayfarer.game.autosave' : `wayfarer.game.slot.${slot}`;
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
