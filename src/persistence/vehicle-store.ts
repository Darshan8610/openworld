import type { VehicleSaveState } from '../vehicles/vehicle';

/**
 * One persisted vehicle: the catalogue key plus its mutable state.
 *
 * Only vehicles the player has actually *changed* are stored — moved, damaged,
 * refuelled or upgraded. Everything else is reproduced exactly by the
 * deterministic planner from (seed, cell), so an infinite world costs nothing
 * on disk.
 */
export interface PersistedVehicle {
  readonly key: string;
  readonly state: VehicleSaveState;
  /** Optional upgrade slots; the framework stores them, gameplay defines them. */
  readonly upgrades?: readonly string[];
  /** True when the planner would no longer produce this vehicle at all. */
  readonly removed?: boolean;
}
export type PersistedVehicles = Record<string, PersistedVehicle>;

export const VEHICLE_SAVE_FORMAT = 'wayfarer.vehicles';
export const VEHICLE_SAVE_VERSION = 1;

export interface VehicleSave {
  readonly format: typeof VEHICLE_SAVE_FORMAT;
  readonly version: number;
  readonly seed: string;
  readonly savedAt: number;
  readonly vehicles: PersistedVehicles;
}

export type VehicleLoadResult =
  | { readonly status: 'empty' }
  | { readonly status: 'ok'; readonly save: VehicleSave }
  | { readonly status: 'invalid'; readonly reason: string };

export type VehicleSaveResult =
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
 * Versioned persistence slice for vehicles, mirroring `ObjectStateStore`.
 *
 * Unknown or newer formats are refused rather than overwritten, so a save from
 * a later build is never silently destroyed.
 */
export class VehicleStateStore {
  private readonly storage: StorageLike | undefined;

  constructor(storage: StorageLike | undefined = defaultStorage(), private readonly keyPrefix = 'wayfarer.vehicles') {
    this.storage = storage;
  }

  get available(): boolean { return this.storage !== undefined; }

  private key(seed: string): string { return `${this.keyPrefix}.v${VEHICLE_SAVE_VERSION}.${encodeURIComponent(seed)}`; }

  load(seed: string): VehicleLoadResult {
    if (!this.storage) return { status: 'empty' };
    let raw: string | null;
    try { raw = this.storage.getItem(this.key(seed)); } catch { return { status: 'empty' }; }
    if (raw === null) return { status: 'empty' };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { status: 'invalid', reason: 'Saved data is not valid JSON.' }; }
    return validateVehicleSave(parsed);
  }

  save(seed: string, vehicles: PersistedVehicles, now = Date.now()): VehicleSaveResult {
    if (!this.storage) return { status: 'failed', reason: 'Storage is unavailable in this browser context.' };
    const existing = this.load(seed);
    if (existing.status === 'ok' && existing.save.version > VEHICLE_SAVE_VERSION) {
      return { status: 'refused', reason: `Existing save uses newer format v${existing.save.version}.` };
    }
    if (existing.status === 'invalid' && !existing.reason.startsWith('Saved data is not valid JSON')) {
      return { status: 'refused', reason: existing.reason };
    }
    const payload: VehicleSave = {
      format: VEHICLE_SAVE_FORMAT, version: VEHICLE_SAVE_VERSION, seed, savedAt: now, vehicles,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Strict, dependency-free validation so a bad save can never corrupt the world. */
export function validateVehicleSave(value: unknown): VehicleLoadResult {
  if (!isRecord(value)) return { status: 'invalid', reason: 'Saved data is not an object.' };
  if (value.format !== VEHICLE_SAVE_FORMAT) return { status: 'invalid', reason: 'Saved data belongs to a different format.' };
  if (!finite(value.version)) return { status: 'invalid', reason: 'Saved data has no version.' };
  if (value.version > VEHICLE_SAVE_VERSION) return { status: 'invalid', reason: `Saved data uses a newer format (v${value.version}).` };
  if (typeof value.seed !== 'string') return { status: 'invalid', reason: 'Saved data has no seed.' };
  if (!isRecord(value.vehicles)) return { status: 'invalid', reason: 'Saved data has no vehicle table.' };

  const vehicles: PersistedVehicles = {};
  for (const [id, entry] of Object.entries(value.vehicles)) {
    if (!isRecord(entry) || typeof entry.key !== 'string') continue;
    const state = sanitiseVehicleState(entry.state);
    if (!state) continue;
    const upgrades = Array.isArray(entry.upgrades)
      ? entry.upgrades.filter((item): item is string => typeof item === 'string')
      : undefined;
    vehicles[id] = {
      key: entry.key,
      state,
      ...(upgrades && upgrades.length > 0 ? { upgrades } : {}),
      ...(entry.removed === true ? { removed: true } : {}),
    };
  }
  return {
    status: 'ok',
    save: {
      format: VEHICLE_SAVE_FORMAT,
      version: value.version,
      seed: value.seed,
      savedAt: finite(value.savedAt) ? value.savedAt : 0,
      vehicles,
    },
  };
}

/**
 * Reject any pose that is not fully finite. A NaN restored from disk would
 * propagate straight into the integrator and destroy the body, so a damaged
 * entry is dropped rather than loaded.
 */
function sanitiseVehicleState(value: unknown): VehicleSaveState | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, z, qx, qy, qz, qw } = value;
  if (!finite(x) || !finite(y) || !finite(z)) return undefined;
  if (!finite(qx) || !finite(qy) || !finite(qz) || !finite(qw)) return undefined;
  // A zero-length quaternion is not a rotation.
  if (Math.hypot(qx, qy, qz, qw) < 1e-6) return undefined;
  return {
    x, y, z, qx, qy, qz, qw,
    health: finite(value.health) ? Math.max(0, value.health) : 0,
    fuel: finite(value.fuel) ? Math.max(0, value.fuel) : 0,
    odometer: finite(value.odometer) ? Math.max(0, value.odometer) : 0,
    moved: value.moved === true,
  };
}
