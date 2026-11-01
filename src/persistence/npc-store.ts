import { clamp } from '../utils/math';
import { isNpcRole, NPC_ACTIVITIES, NPC_BEHAVIOURS } from '../npc/types';
import type { PersistedNpcs } from '../npc/types';

/**
 * Versioned persistence slice for Phase 8 NPC state.
 *
 * It follows the Phase 6 object-store contract exactly: a versioned envelope
 * keyed by seed, strict validation on load, unknown fields dropped, a *newer*
 * format refused rather than overwritten, and only the diff from the
 * deterministic baseline written. The world itself is never stored — an NPC that
 * nobody met is reproducible from the seed alone.
 *
 * Save slots, the player and the rest of world state remain Phase 11.
 */
export const NPC_SAVE_FORMAT = 'wayfarer.npcs';
export const NPC_SAVE_VERSION = 1;
/** Hard cap so a long session cannot grow the save without bound. */
export const NPC_SAVE_LIMIT = 512;

export interface NpcSave {
  readonly format: typeof NPC_SAVE_FORMAT;
  readonly version: number;
  readonly seed: string;
  readonly savedAt: number;
  readonly npcs: PersistedNpcs;
}

export type NpcLoadResult =
  | { readonly status: 'empty' }
  | { readonly status: 'ok'; readonly save: NpcSave }
  | { readonly status: 'invalid'; readonly reason: string };

export type NpcSaveResult =
  | { readonly status: 'ok'; readonly written: number }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const probe = '__wayfarer_npc_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export class NpcStateStore {
  private readonly storage: StorageLike | undefined;

  constructor(storage: StorageLike | undefined = defaultStorage(), private readonly keyPrefix = 'wayfarer.npcs') {
    this.storage = storage;
  }

  get available(): boolean { return this.storage !== undefined; }

  private key(seed: string): string {
    return `${this.keyPrefix}.v${NPC_SAVE_VERSION}.${encodeURIComponent(seed)}`;
  }

  load(seed: string): NpcLoadResult {
    if (!this.storage) return { status: 'empty' };
    let raw: string | null;
    try { raw = this.storage.getItem(this.key(seed)); } catch { return { status: 'empty' }; }
    if (raw === null) return { status: 'empty' };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { status: 'invalid', reason: 'Saved NPC data is not valid JSON.' }; }
    return validateNpcSave(parsed);
  }

  save(seed: string, npcs: PersistedNpcs, now = Date.now()): NpcSaveResult {
    if (!this.storage) return { status: 'failed', reason: 'Storage is unavailable in this browser context.' };
    const existing = this.load(seed);
    if (existing.status === 'ok' && existing.save.version > NPC_SAVE_VERSION) {
      return { status: 'refused', reason: `Existing NPC save uses newer format v${existing.save.version}.` };
    }
    if (existing.status === 'invalid' && !existing.reason.startsWith('Saved NPC data is not valid JSON')) {
      return { status: 'refused', reason: existing.reason };
    }
    const payload: NpcSave = {
      format: NPC_SAVE_FORMAT,
      version: NPC_SAVE_VERSION,
      seed,
      savedAt: now,
      npcs,
    };
    try {
      this.storage.setItem(this.key(seed), JSON.stringify(payload));
      return { status: 'ok', written: Object.keys(npcs).length };
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : 'Storage write failed.' };
    }
  }

  clear(seed: string): void {
    try { this.storage?.removeItem(this.key(seed)); } catch { /* Removal is best-effort. */ }
  }
}

/** Strict, dependency-free validation so a bad NPC save can never break a world. */
export function validateNpcSave(value: unknown): NpcLoadResult {
  if (!isRecord(value)) return { status: 'invalid', reason: 'Saved NPC data is not an object.' };
  if (value.format !== NPC_SAVE_FORMAT) return { status: 'invalid', reason: 'Saved NPC data belongs to a different format.' };
  if (!finite(value.version)) return { status: 'invalid', reason: 'Saved NPC data has no version.' };
  if (value.version > NPC_SAVE_VERSION) return { status: 'invalid', reason: `Saved NPC data uses a newer format (v${value.version}).` };
  if (typeof value.seed !== 'string') return { status: 'invalid', reason: 'Saved NPC data has no seed.' };
  if (!isRecord(value.npcs)) return { status: 'invalid', reason: 'Saved NPC data has no NPC table.' };

  const npcs: PersistedNpcs = {};
  let count = 0;
  for (const [id, entry] of Object.entries(value.npcs)) {
    if (count >= NPC_SAVE_LIMIT) break;
    if (typeof id !== 'string' || id.length === 0 || id.length > 96) continue;
    if (!isRecord(entry)) continue;
    if (!isNpcRole(entry.role)) continue;
    if (!finite(entry.x) || !finite(entry.y) || !finite(entry.z)) continue;
    const behaviour = typeof entry.behaviour === 'string' && (NPC_BEHAVIOURS as readonly string[]).includes(entry.behaviour)
      ? entry.behaviour : 'idle';
    const activity = typeof entry.activity === 'string' && (NPC_ACTIVITIES as readonly string[]).includes(entry.activity)
      ? entry.activity : 'wander';
    npcs[id] = {
      role: entry.role,
      // Canonical coordinates are clamped to the same envelope the URL accepts.
      x: clamp(entry.x, -1e12, 1e12),
      y: clamp(entry.y, -2000, 9000),
      z: clamp(entry.z, -1e12, 1e12),
      yaw: finite(entry.yaw) ? entry.yaw : 0,
      behaviour,
      activity,
      talked: entry.talked === true,
    };
    count += 1;
  }
  return {
    status: 'ok',
    save: {
      format: NPC_SAVE_FORMAT,
      version: value.version,
      seed: value.seed,
      savedAt: finite(value.savedAt) ? value.savedAt : 0,
      npcs,
    },
  };
}
