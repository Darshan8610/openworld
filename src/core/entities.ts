import { SpatialGrid } from './spatial';
import { copyPoint, distanceSqXZ } from './coordinates';
import type { WorldPoint } from './coordinates';

/** Entity taxonomy shared by world objects, NPCs, vehicles and buildings. */
export const ENTITY_KINDS = ['object', 'npc', 'vehicle', 'building', 'water', 'landmark'] as const;
export type EntityKind = typeof ENTITY_KINDS[number];

/**
 * `transient`  — rebuilt from the seed every time, never stored.
 * `session`    — survives streaming in this play session only.
 * `world`      — written to the versioned persistence slice.
 */
export type PersistencePolicy = 'transient' | 'session' | 'world';

/** Streaming distance bands; entity behaviour depends on which band it is in. */
export type SimulationLevel = 'full' | 'reduced' | 'background' | 'culled';

export interface StreamingRadii {
  /** Inside this distance the entity runs at full fidelity. */
  readonly full: number;
  /** Inside this distance it runs at reduced frequency. */
  readonly reduced: number;
  /** Inside this distance only lightweight state is kept. */
  readonly background: number;
}

export function simulationLevelFor(distance: number, radii: StreamingRadii): SimulationLevel {
  if (distance <= radii.full) return 'full';
  if (distance <= radii.reduced) return 'reduced';
  if (distance <= radii.background) return 'background';
  return 'culled';
}

export interface EntitySpec<D> {
  /** Stable world identifier: derived from the seed and placement, never a counter. */
  readonly id: string;
  readonly kind: EntityKind;
  /** Data archetype key, e.g. `supply-cache`. */
  readonly archetype: string;
  readonly position: WorldPoint;
  /** Bounding radius for coarse queries and culling. */
  readonly radius: number;
  readonly radii: StreamingRadii;
  readonly persistence: PersistencePolicy;
  /** Higher priority entities win when a budget runs out. */
  readonly priority?: number;
  /** Simulation-owned data. Rendering and physics state are kept elsewhere. */
  readonly data: D;
}

export type EntityState = 'active' | 'dormant' | 'disposed';

export interface Entity<D> extends EntitySpec<D> {
  readonly position: WorldPoint;
  state: EntityState;
  level: SimulationLevel;
  readonly registeredAt: number;
}

export interface RegistryStats {
  readonly total: number;
  readonly active: number;
  readonly dormant: number;
  readonly byLevel: Record<SimulationLevel, number>;
}

/**
 * Entity data registry: identity, canonical position, streaming level and
 * lifecycle. It deliberately holds no meshes and no colliders — visual and
 * physics representations are owned by the systems that need them, which keeps
 * geometry out of the simulation layer.
 */
export class EntityRegistry<D = unknown> {
  private readonly entities = new Map<string, Entity<D>>();
  private readonly grid: SpatialGrid<Entity<D>>;

  constructor(cellSize = 128) {
    this.grid = new SpatialGrid<Entity<D>>(cellSize);
  }

  register(spec: EntitySpec<D>, now = 0): Entity<D> {
    if (this.entities.has(spec.id)) throw new Error(`Entity "${spec.id}" is already registered`);
    const entity: Entity<D> = { ...spec, position: copyPoint(spec.position, { x: 0, y: 0, z: 0 }), state: 'active', level: 'culled', registeredAt: now };
    this.entities.set(spec.id, entity);
    this.grid.set(spec.id, entity.position.x, entity.position.z, entity);
    return entity;
  }

  unregister(id: string): boolean {
    if (!this.entities.delete(id)) return false;
    this.grid.delete(id);
    return true;
  }

  get(id: string): Entity<D> | undefined { return this.entities.get(id); }
  has(id: string): boolean { return this.entities.has(id); }
  get size(): number { return this.entities.size; }

  setPosition(id: string, position: WorldPoint): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    copyPoint(position, entity.position);
    this.grid.set(id, entity.position.x, entity.position.z, entity);
  }

  setState(id: string, state: EntityState): void {
    const entity = this.entities.get(id);
    if (entity) entity.state = state;
  }

  /** Nearest registered entities, nearest first. */
  near(x: number, z: number, radius: number): Entity<D>[] { return this.grid.near(x, z, radius); }

  /** Recalculate streaming levels once per streaming tick; returns changed entities. */
  updateLevels(center: WorldPoint, onlyActive = true): Entity<D>[] {
    const changed: Entity<D>[] = [];
    for (const entity of this.entities.values()) {
      if (onlyActive && entity.state !== 'active') continue;
      const distance = Math.sqrt(distanceSqXZ(entity.position.x, entity.position.z, center.x, center.z));
      const level = simulationLevelFor(distance - entity.radius, entity.radii);
      if (level !== entity.level) { entity.level = level; changed.push(entity); }
    }
    return changed;
  }

  byLevel(level: SimulationLevel): Entity<D>[] {
    return [...this.entities.values()].filter((entity) => entity.level === level);
  }

  values(): IterableIterator<Entity<D>> { return this.entities.values(); }

  get stats(): RegistryStats {
    const byLevel: Record<SimulationLevel, number> = { full: 0, reduced: 0, background: 0, culled: 0 };
    let active = 0, dormant = 0;
    for (const entity of this.entities.values()) {
      byLevel[entity.level]++;
      if (entity.state === 'active') active++;
      else if (entity.state === 'dormant') dormant++;
    }
    return { total: this.entities.size, active, dormant, byLevel };
  }

  clear(): void { this.entities.clear(); this.grid.clear(); }
}
