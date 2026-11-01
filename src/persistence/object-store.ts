import type { ObjectState } from '../objects/archetypes';
import type { ItemStack } from '../objects/items';

/** One persisted object: the archetype plus only the fields that changed. */
export interface PersistedObject {
  readonly archetype: string;
  readonly state: ObjectState;
}
export type PersistedObjects = Record<string, PersistedObject>;

export const OBJECT_SAVE_FORMAT = 'wayfarer.objects';
export const OBJECT_SAVE_VERSION = 1;

export interface ObjectSave {
  readonly format: typeof OBJECT_SAVE_FORMAT;
  readonly version: number;
  readonly seed: string;
  readonly savedAt: number;
  readonly objects: PersistedObjects;
  readonly inventory: readonly ItemStack[];
}

export type LoadResult =
  | { readonly status: 'empty' }
  | { readonly status: 'ok'; readonly save: ObjectSave }
  | { readonly status: 'invalid'; readonly reason: string };

export type SaveResult =
  | { readonly status: 'ok' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage is unavailable in some private/embedded contexts; never throw. */
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const probe = '__wayfarer_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Versioned persistence slice for interactive objects and the player inventory.
 *
 * This is intentionally *not* the full save system (Phase 11 owns slots, the
 * player, vehicles and world state). It stores only the diff from the
 * deterministic baseline: which doors are open, what has been collected, what
 * is left in a container, and the inventory. Unknown/newer formats are never
 * overwritten — a corrupt or future save surfaces as an error instead of being
 * silently replaced.
 */
export class ObjectStateStore {
  private readonly storage: StorageLike | undefined;

  constructor(storage: StorageLike | undefined = defaultStorage(), private readonly keyPrefix = 'wayfarer.objects') {
    this.storage = storage;
  }

  get available(): boolean { return this.storage !== undefined; }

  private key(seed: string): string { return `${this.keyPrefix}.v${OBJECT_SAVE_VERSION}.${encodeURIComponent(seed)}`; }

  load(seed: string): LoadResult {
    if (!this.storage) return { status: 'empty' };
    let raw: string | null;
    try { raw = this.storage.getItem(this.key(seed)); } catch { return { status: 'empty' }; }
    if (raw === null) return { status: 'empty' };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { status: 'invalid', reason: 'Saved data is not valid JSON.' }; }
    return validateObjectSave(parsed);
  }

  save(seed: string, objects: PersistedObjects, inventory: readonly ItemStack[], now = Date.now()): SaveResult {
    if (!this.storage) return { status: 'failed', reason: 'Storage is unavailable in this browser context.' };
    const existing = this.load(seed);
    if (existing.status === 'ok' && existing.save.version > OBJECT_SAVE_VERSION) {
      return { status: 'refused', reason: `Existing save uses newer format v${existing.save.version}.` };
    }
    if (existing.status === 'invalid' && !existing.reason.startsWith('Saved data is not valid JSON')) {
      return { status: 'refused', reason: existing.reason };
    }
    const payload: ObjectSave = {
      format: OBJECT_SAVE_FORMAT, version: OBJECT_SAVE_VERSION,
      seed, savedAt: now, objects, inventory: inventory.map((stack) => ({ itemId: stack.itemId, count: stack.count })),
    };
    try {
      this.storage.setItem(this.key(seed), JSON.stringify(payload));
      return { status: 'ok' };
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : 'Storage write failed.' };
    }
  }

  clear(seed: string): void {
    try { this.storage?.removeItem(this.key(seed)); } catch { /* Removal is best-effort. */ }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strict, dependency-free validation so a bad save can never corrupt the world. */
export function validateObjectSave(value: unknown): LoadResult {
  if (!isRecord(value)) return { status: 'invalid', reason: 'Saved data is not an object.' };
  if (value.format !== OBJECT_SAVE_FORMAT) return { status: 'invalid', reason: 'Saved data belongs to a different format.' };
  if (typeof value.version !== 'number' || !Number.isFinite(value.version)) return { status: 'invalid', reason: 'Saved data has no version.' };
  if (value.version > OBJECT_SAVE_VERSION) return { status: 'invalid', reason: `Saved data uses a newer format (v${value.version}).` };
  if (typeof value.seed !== 'string') return { status: 'invalid', reason: 'Saved data has no seed.' };
  if (!isRecord(value.objects)) return { status: 'invalid', reason: 'Saved data has no object table.' };

  const objects: PersistedObjects = {};
  for (const [id, entry] of Object.entries(value.objects)) {
    if (!isRecord(entry) || typeof entry.archetype !== 'string' || !isRecord(entry.state)) continue;
    objects[id] = { archetype: entry.archetype, state: sanitiseState(entry.state) };
  }
  const inventory: ItemStack[] = [];
  if (Array.isArray(value.inventory)) {
    for (const stack of value.inventory) {
      if (!isRecord(stack) || typeof stack.itemId !== 'string') continue;
      if (typeof stack.count !== 'number' || !Number.isFinite(stack.count) || stack.count <= 0) continue;
      inventory.push({ itemId: stack.itemId as ItemStack['itemId'], count: Math.floor(stack.count) });
    }
  }
  return {
    status: 'ok',
    save: {
      format: OBJECT_SAVE_FORMAT,
      version: value.version,
      seed: value.seed,
      savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
      objects,
      inventory,
    },
  };
}

/** Keep only known, correctly typed state fields from disk. */
function sanitiseState(state: Record<string, unknown>): ObjectState {
  const out: ObjectState = {};
  if (typeof state.open === 'boolean') out.open = state.open;
  if (typeof state.on === 'boolean') out.on = state.on;
  if (typeof state.used === 'boolean') out.used = state.used;
  if (typeof state.opened === 'boolean') out.opened = state.opened;
  if (typeof state.collected === 'boolean') out.collected = state.collected;
  if (typeof state.seated === 'boolean') out.seated = state.seated;
  if (typeof state.visited === 'boolean') out.visited = state.visited;
  if (typeof state.level === 'number' && Number.isFinite(state.level)) out.level = Math.max(0, Math.min(4, Math.round(state.level)));
  if (Array.isArray(state.contents)) {
    out.contents = state.contents
      .filter((stack): stack is { itemId: ItemStack['itemId']; count: number } => isRecord(stack) && typeof stack.itemId === 'string' && typeof stack.count === 'number' && stack.count > 0)
      .map((stack) => ({ itemId: stack.itemId, count: Math.floor(stack.count) }));
  }
  return out;
}
