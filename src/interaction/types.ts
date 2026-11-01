import type { WorldPoint } from '../core/coordinates';
import type { GameEventBus } from '../core/events';
import type { WorldQueries } from '../world/world-queries';
import type { PropPhysicsWorld } from '../physics/prop-physics';
import type { Inventory } from './inventory';
import type { ObjectState } from '../objects/archetypes';
import type { PersistencePolicy } from '../core/entities';

/**
 * Minimal data identity every interactable exposes.
 *
 * Phase 6 defined interaction against world objects; Phase 10 adds vehicles and
 * later phases add NPCs and buildings. They all need a stable key and a display
 * label and nothing more, so the interaction layer depends only on this.
 * `ObjectArchetype` satisfies it structurally — no object code changed.
 */
export interface InteractionArchetype {
  readonly key: string;
  readonly label: string;
}

/** The acting entity (survey rig today, the Phase 5 character later). */
export interface ActorView {
  readonly id: string;
  readonly position: WorldPoint;
  readonly forward: WorldPoint;
  readonly yaw: number;
}

/**
 * The minimum an interaction provider must say about itself for events, labels
 * and logging. World objects pass their full `ObjectArchetype`; NPCs, vehicles
 * and buildings pass their own descriptor, so the interaction layer never has to
 * grow a branch per provider kind.
 */
export interface InteractionArchetype {
  readonly key: string;
  readonly label: string;
}

export interface InteractionContext {
  readonly objectId: string;
  /** Provider descriptor (`ObjectArchetype` for world objects). */
  readonly archetype: InteractionArchetype;
  readonly state: ObjectState;
  readonly actor: ActorView;
  /** Simulation time in seconds since boot. */
  readonly now: number;
  readonly inventory: Inventory;
  readonly physics: PropPhysicsWorld;
  readonly queries: WorldQueries;
  readonly events: GameEventBus;
  readonly setState: (patch: Partial<ObjectState>) => void;
  readonly remove: () => void;
  readonly notify: (message: string) => void;
}

export interface InteractionOutcome {
  /** Toast/prompt text shown to the player. */
  readonly message?: string;
  /** Persist the resulting state (defaults to the archetype policy). */
  readonly persistent?: boolean;
}

export interface InteractionAction {
  readonly id: string;
  /** Can be dynamic ("Close door" vs "Open door"). */
  readonly label: string | ((state: ObjectState) => string);
  /** Display key, default `E`. */
  readonly key?: string;
  /** 0 for instant; > 0 requires holding the key. */
  readonly holdSeconds?: number;
  /** Conditions: hidden and unusable when false. */
  readonly available?: (state: ObjectState, inventory: Inventory) => boolean;
  readonly run: (context: InteractionContext) => InteractionOutcome | void;
}

/**
 * Something the interaction system can target. Implemented by world objects and
 * NPCs; vehicles and buildings will implement the same shape in later phases, so
 * interaction never needs to know what it is looking at.
 */
export interface InteractionProvider {
  readonly id: string;
  /** Data definition that drives the actions and labels. */
  readonly archetype: InteractionArchetype;
  /** Canonical centre used for aiming and distance checks. */
  readonly centre: WorldPoint;
  readonly radius: number;
  readonly range: number;
  readonly targetLabel: string;
  readonly persistence: PersistencePolicy;
  actions(): readonly InteractionAction[];
  state(): ObjectState;
  setState(patch: Partial<ObjectState>): void;
  remove(): void;
}

/** What the HUD shows for the current target. */
export interface InteractionPrompt {
  readonly objectId: string;
  readonly targetLabel: string;
  readonly actionLabel: string;
  readonly key: string;
  readonly holdSeconds: number;
  readonly progress: number;
}
