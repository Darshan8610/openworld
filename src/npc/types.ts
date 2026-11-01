import type { WorldPoint } from '../core/coordinates';
import type { StreamingRadii } from '../core/entities';
import type { SimulationLevel } from '../game/entity';
import type { AnimState } from '../character/animation-controller';

/**
 * Phase 8 data vocabulary: identities, placement records, schedule activities
 * and the state an NPC persists. Everything here is plain structural data so it
 * can be stored, diffed and validated without importing the simulation.
 */

/** Generic population roles. No lore, no factions, no named characters. */
export const NPC_ROLES = ['wanderer', 'worker', 'watcher', 'traveller', 'survivor'] as const;
export type NpcRole = typeof NPC_ROLES[number];

export const isNpcRole = (value: unknown): value is NpcRole =>
  typeof value === 'string' && (NPC_ROLES as readonly string[]).includes(value);

/** Anchors are the places a schedule sends an NPC: where it lives, works, rests. */
export const NPC_ANCHOR_KINDS = ['home', 'work', 'leisure'] as const;
export type NpcAnchorKind = typeof NPC_ANCHOR_KINDS[number];

/**
 * Behaviour identities reported by the brain and consumed by animation, HUD and
 * events. Each one is a real simulated state, not a label for a static mesh.
 */
export const NPC_BEHAVIOURS = [
  'idle', 'walk', 'wander', 'run', 'look', 'travel', 'work', 'sit', 'eat', 'rest',
  'sleep', 'follow', 'wait', 'investigate', 'react', 'avoid', 'talk', 'return', 'flee',
] as const;
export type NpcBehaviourId = typeof NPC_BEHAVIOURS[number];

/** Data-driven daily activities; the brain maps each to a behaviour tree. */
export const NPC_ACTIVITIES = ['sleep', 'work', 'leisure', 'wander'] as const;
export type NpcActivity = typeof NPC_ACTIVITIES[number];

export const NPC_SCHEDULE_IDS = ['settler', 'warden', 'roamer'] as const;
export type NpcScheduleId = typeof NPC_SCHEDULE_IDS[number];

export interface NpcAnchors {
  readonly home: WorldPoint;
  readonly work: WorldPoint;
  readonly leisure: WorldPoint;
}

/** A deterministic placement: `(seed, cell, slot)` always yields this record. */
export interface PlacedNpc {
  /** Stable id derived from the seed and the placement slot, never a counter. */
  readonly id: string;
  readonly role: NpcRole;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly anchors: NpcAnchors;
}

export interface NpcDefinition {
  readonly role: NpcRole;
  /** Generic, role-derived display label ("Trail worker"), never a name. */
  readonly label: string;
  /** Coat colour used by the placeholder rig and the reduced proxy. */
  readonly accent: number;
  /** Body scale applied to the shared humanoid rig. */
  readonly heightScale: number;
  /** Multiplier on the baseline walk speed for this role. */
  readonly speedScale: number;
  readonly schedule: NpcScheduleId;
  readonly radii: StreamingRadii;
  /** Curious roles investigate a detected player instead of ignoring them. */
  readonly curious: boolean;
  /** Distance at which this role reacts to the player. */
  readonly alertDistance: number;
}

/** The slice of state written to the persistence slice per NPC. */
export interface NpcRecord {
  readonly role: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly behaviour: string;
  readonly activity: string;
  /** The player has spoken to this character at least once. */
  readonly talked: boolean;
}

export type PersistedNpcs = Record<string, NpcRecord>;

export interface NpcSnapshot {
  readonly id: string;
  readonly role: NpcRole;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly behaviour: NpcBehaviourId;
  readonly activity: NpcActivity;
  readonly level: SimulationLevel;
  readonly animation: AnimState;
  readonly speed: number;
  readonly distance: number;
  readonly talking: boolean;
  readonly talked: boolean;
  readonly rigged: boolean;
}

export interface NpcStats {
  readonly active: number;
  readonly full: number;
  readonly reduced: number;
  readonly background: number;
  readonly rigs: number;
  readonly rigCapacity: number;
  readonly cells: number;
  readonly truncated: boolean;
  readonly talked: number;
  readonly searches: number;
  readonly nearest: string | null;
}

/** Live conversation state surfaced to the UI. */
export interface ConversationView {
  readonly npcId: string;
  readonly npcLabel: string;
  readonly topics: readonly { readonly id: string; readonly label: string }[];
  readonly line: string | null;
}
