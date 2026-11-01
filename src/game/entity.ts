import { Vector3 } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';

export type EntityId = string;

/**
 * Every streamed/stored thing in the world shares one record type. Kinds that
 * arrive in later phases (npc, building, vehicle, water) already have a slot so
 * the registry, streaming and persistence contracts never need to change.
 */
export type EntityKind =
  | 'player'
  | 'npc'
  | 'vehicle'
  | 'building'
  | 'interior'
  | 'prop'
  | 'pickup'
  | 'landmark'
  | 'water'
  | 'region';

/**
 * 0 full fidelity, 1 reduced rate, 2 background state only, 3 data-only
 * (no visual, no physics simulation, still addressable by id).
 */
export const SIMULATION_FULL = 0;
export const SIMULATION_REDUCED = 1;
export const SIMULATION_BACKGROUND = 2;
export const SIMULATION_DORMANT = 3;
export type SimulationLevel = 0 | 1 | 2 | 3;
export const SIMULATION_LEVEL_NAMES: readonly string[] = ['full', 'reduced', 'background', 'dormant'];

export type EntityLifecycle = 'active' | 'dormant';

/**
 * `none` — reproducible from the seed alone (procedural prop).
 * `state` — stores a small mutable state object (opened door, damaged vehicle).
 * `full` — stores pose plus state (player, purchased vehicle, NPC).
 */
export type PersistencePolicy = 'none' | 'state' | 'full';

export interface EntityBounds {
  /** Horizontal radius used for streaming and broad queries. */
  radius: number;
  /** Vertical extent above `position`, used by collider/interact queries. */
  height: number;
}

/** Handle pair for the physics representation; bodies live in physics-local space. */
export interface EntityPhysicsAttachment {
  bodyId: number;
  colliders: readonly number[];
}

export interface WorldEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  /** Canonical world coordinates (double precision). Never origin-relative. */
  readonly position: Vector3;
  yaw: number;
  bounds: EntityBounds;
  /** 0..1 bias: higher priority entities win scarce simulation budgets. */
  priority: number;
  persistence: PersistencePolicy;
  lifecycle: EntityLifecycle;
  simulation: SimulationLevel;
  /** Origin-relative render object owned elsewhere; registry only rebases/hides it. */
  visual?: Object3D;
  physics?: EntityPhysicsAttachment;
  /** Small serialisable gameplay state; persisted according to `persistence`. */
  state: Record<string, unknown>;
  /** Optional simulation hook (AI, machines, doors). Runs only at level 0/1. */
  tick?: (dt: number, level: SimulationLevel) => void;
}

export interface EntityInit {
  id?: EntityId;
  kind: EntityKind;
  position: Vector3 | { x: number; y: number; z: number };
  yaw?: number;
  radius?: number;
  height?: number;
  priority?: number;
  persistence?: PersistencePolicy;
  visual?: Object3D;
  physics?: EntityPhysicsAttachment;
  state?: Record<string, unknown>;
  tick?: (dt: number, level: SimulationLevel) => void;
}

let entitySequence = 0;

/** Deterministic, human-readable ids; callers may supply their own stable id. */
export function nextEntityId(kind: EntityKind): EntityId {
  entitySequence += 1;
  return `${kind}-${entitySequence.toString(36)}`;
}

export function createEntity(init: EntityInit): WorldEntity {
  const source = init.position;
  const position = source instanceof Vector3 ? source.clone() : new Vector3(source.x, source.y, source.z);
  const entity: WorldEntity = {
    id: init.id ?? nextEntityId(init.kind),
    kind: init.kind,
    position,
    yaw: init.yaw ?? 0,
    bounds: { radius: init.radius ?? 1, height: init.height ?? 2 },
    priority: init.priority ?? 0.5,
    persistence: init.persistence ?? 'none',
    lifecycle: 'active',
    simulation: SIMULATION_FULL,
    state: init.state ? { ...init.state } : {},
  };
  if (init.visual) entity.visual = init.visual;
  if (init.physics) entity.physics = init.physics;
  if (init.tick) entity.tick = init.tick;
  return entity;
}

/** Reset the id sequence. Tests use this to keep ids stable between cases. */
export function resetEntityIds(): void {
  entitySequence = 0;
}
