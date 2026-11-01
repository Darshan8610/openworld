import { Vector3 } from 'three/webgpu';
import { CONFIG } from '../config';
import {
  SIMULATION_BACKGROUND, SIMULATION_DORMANT, SIMULATION_FULL, SIMULATION_REDUCED,
} from './entity';
import type { EntityId, EntityKind, SimulationLevel, WorldEntity } from './entity';

export interface StreamingBudgets {
  fullDistance: number;
  reducedDistance: number;
  backgroundDistance: number;
  maxFull: number;
  maxReduced: number;
  maxBackground: number;
}

export const DEFAULT_STREAMING_BUDGETS: StreamingBudgets = {
  fullDistance: CONFIG.entities.fullDistance,
  reducedDistance: CONFIG.entities.reducedDistance,
  backgroundDistance: CONFIG.entities.backgroundDistance,
  maxFull: CONFIG.entities.maxFull,
  maxReduced: CONFIG.entities.maxReduced,
  maxBackground: CONFIG.entities.maxBackground,
};

export interface NearbyOptions {
  kinds?: readonly EntityKind[];
  limit?: number;
  /** Only include entities at this simulation level or better. */
  minLevel?: SimulationLevel;
}

export interface EntityStreamStats {
  full: number;
  reduced: number;
  background: number;
  dormant: number;
  total: number;
  changed: boolean;
}

export interface EntityRegistryStats extends EntityStreamStats {
  kinds: Record<string, number>;
  cells: number;
}

/** Reduced-fidelity entities think at ~15 Hz instead of every simulation frame. */
const REDUCED_TICK_CADENCE = 1 / 15;

/**
 * Ownership of every world entity plus the spatial index and simulation-level
 * streaming that keep the infinite world affordable. Positions are canonical
 * world coordinates: the registry is untouched by floating-origin shifts except
 * for translating attached (origin-relative) visuals.
 */
export class EntityRegistry {
  private readonly byId = new Map<EntityId, WorldEntity>();
  private readonly cells = new Map<string, Set<EntityId>>();
  private readonly tickAccumulator = new Map<EntityId, number>();
  private readonly lastLevel = new Map<EntityId, SimulationLevel>();
  private readonly cellSize: number;

  constructor(cellSize: number = CONFIG.entities.cellSize) {
    this.cellSize = cellSize;
  }

  get size(): number { return this.byId.size; }

  add(entity: WorldEntity): WorldEntity {
    if (this.byId.has(entity.id)) throw new Error(`Entity id already registered: ${entity.id}`);
    this.byId.set(entity.id, entity);
    this.index(entity);
    this.lastLevel.set(entity.id, entity.simulation);
    return entity;
  }

  remove(id: EntityId): boolean {
    const entity = this.byId.get(id);
    if (!entity) return false;
    const key = this.cellKey(entity.position.x, entity.position.z);
    const bucket = this.cells.get(key);
    if (bucket) {
      bucket.delete(id);
      if (bucket.size === 0) this.cells.delete(key);
    }
    this.byId.delete(id);
    this.tickAccumulator.delete(id);
    this.lastLevel.delete(id);
    return true;
  }

  get(id: EntityId): WorldEntity | undefined { return this.byId.get(id); }
  has(id: EntityId): boolean { return this.byId.has(id); }
  entities(): IterableIterator<WorldEntity> { return this.byId.values(); }

  /** Move an entity to new canonical XZ; re-indexes only when the cell changes. */
  move(id: EntityId, x: number, z: number, yaw?: number): void {
    const entity = this.byId.get(id);
    if (!entity) return;
    const previous = this.cellKey(entity.position.x, entity.position.z);
    const next = this.cellKey(x, z);
    entity.position.set(x, entity.position.y, z);
    if (yaw !== undefined) entity.yaw = yaw;
    if (previous !== next) {
      this.cells.get(previous)?.delete(id);
      this.addToCell(next, id);
    }
  }

  /**
   * Entities whose footprint is within `radius` of (x, z), nearest first.
   * Distance is measured to the bounding circle, so large structures register
   * as "nearby" as soon as they are reachable rather than when they overlap.
   */
  nearby(x: number, z: number, radius: number, options: NearbyOptions = {}): WorldEntity[] {
    const kinds = options.kinds;
    const minLevel = options.minLevel;
    const limit = options.limit ?? Infinity;
    const results: { entity: WorldEntity; distance: number }[] = [];
    const minCellX = Math.floor((x - radius) / this.cellSize);
    const maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellZ = Math.floor((z - radius) / this.cellSize);
    const maxCellZ = Math.floor((z + radius) / this.cellSize);
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cz = minCellZ; cz <= maxCellZ; cz++) {
        const bucket = this.cells.get(`${cx}:${cz}`);
        if (!bucket) continue;
        for (const id of bucket) {
          const entity = this.byId.get(id);
          if (!entity) continue;
          if (kinds && !kinds.includes(entity.kind)) continue;
          if (minLevel !== undefined && entity.simulation > minLevel) continue;
          const centre = Math.hypot(entity.position.x - x, entity.position.z - z);
          const distance = Math.max(0, centre - entity.bounds.radius);
          if (distance > radius) continue;
          results.push({ entity, distance });
        }
      }
    }
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, limit).map((entry) => entry.entity);
  }

  nearest(x: number, z: number, radius: number, kinds?: readonly EntityKind[]): WorldEntity | undefined {
    const options: NearbyOptions = { limit: 1 };
    if (kinds) options.kinds = kinds;
    return this.nearby(x, z, radius, options)[0];
  }

  /**
   * Assign simulation levels for one observer: distance thresholds first, then a
   * cascade so a full budget overflow degrades to reduced instead of popping.
   * The player is always full fidelity and never visually hidden.
   */
  stream(observer: Vector3, budgets: StreamingBudgets = DEFAULT_STREAMING_BUDGETS): EntityStreamStats {
    const counts = [0, 0, 0, 0];
    const ranked: { entity: WorldEntity; score: number; distance: number }[] = [];
    for (const entity of this.byId.values()) {
      if (entity.kind === 'player') continue;
      const distance = Math.hypot(entity.position.x - observer.x, entity.position.z - observer.z);
      // Priority (0..1) biases the budget by up to 60 m of effective distance.
      ranked.push({ entity, distance, score: distance - entity.priority * 60 });
    }
    ranked.sort((a, b) => a.score - b.score);
    let changed = false;
    for (const { entity, distance } of ranked) {
      let level: SimulationLevel = SIMULATION_DORMANT;
      if (distance <= budgets.fullDistance && counts[SIMULATION_FULL]! < budgets.maxFull) level = SIMULATION_FULL;
      else if (distance <= budgets.reducedDistance && counts[SIMULATION_REDUCED]! < budgets.maxReduced) level = SIMULATION_REDUCED;
      else if (distance <= budgets.backgroundDistance && counts[SIMULATION_BACKGROUND]! < budgets.maxBackground) level = SIMULATION_BACKGROUND;
      counts[level]! += 1;
      if (this.applyLevel(entity, level)) changed = true;
    }
    for (const entity of this.byId.values()) {
      if (entity.kind !== 'player') continue;
      counts[SIMULATION_FULL]! += 1;
      if (this.applyLevel(entity, SIMULATION_FULL)) changed = true;
    }
    return {
      full: counts[SIMULATION_FULL]!, reduced: counts[SIMULATION_REDUCED]!,
      background: counts[SIMULATION_BACKGROUND]!, dormant: counts[SIMULATION_DORMANT]!,
      total: this.byId.size, changed,
    };
  }

  /** Run per-entity simulation at its assigned fidelity. Returns the tick count. */
  tick(dt: number): number {
    let executed = 0;
    for (const entity of this.byId.values()) {
      if (!entity.tick || entity.simulation >= SIMULATION_BACKGROUND) continue;
      if (entity.simulation === SIMULATION_FULL) {
        entity.tick(dt, SIMULATION_FULL);
        executed += 1;
        continue;
      }
      const accumulated = (this.tickAccumulator.get(entity.id) ?? 0) + dt;
      if (accumulated >= REDUCED_TICK_CADENCE) {
        this.tickAccumulator.set(entity.id, 0);
        entity.tick(accumulated, SIMULATION_REDUCED);
        executed += 1;
      } else {
        this.tickAccumulator.set(entity.id, accumulated);
      }
    }
    return executed;
  }

  /** Translate every attached visual by -delta so it stays with canonical data. */
  rebase(delta: Vector3): void {
    for (const entity of this.byId.values()) {
      if (!entity.visual) continue;
      entity.visual.position.sub(delta);
    }
  }

  stats(): EntityRegistryStats {
    const counts = [0, 0, 0, 0];
    const kinds: Record<string, number> = {};
    for (const entity of this.byId.values()) {
      counts[entity.simulation]! += 1;
      kinds[entity.kind] = (kinds[entity.kind] ?? 0) + 1;
    }
    return {
      full: counts[SIMULATION_FULL]!, reduced: counts[SIMULATION_REDUCED]!,
      background: counts[SIMULATION_BACKGROUND]!, dormant: counts[SIMULATION_DORMANT]!,
      total: this.byId.size, changed: false, kinds, cells: this.cells.size,
    };
  }

  clear(): void {
    for (const entity of this.byId.values()) if (entity.visual?.parent) entity.visual.parent.remove(entity.visual);
    this.byId.clear();
    this.cells.clear();
    this.tickAccumulator.clear();
    this.lastLevel.clear();
  }

  private applyLevel(entity: WorldEntity, level: SimulationLevel): boolean {
    const previous = this.lastLevel.get(entity.id);
    let changed = false;
    if (previous !== level) {
      entity.simulation = level;
      this.lastLevel.set(entity.id, level);
      changed = true;
    }
    entity.lifecycle = level === SIMULATION_DORMANT ? 'dormant' : 'active';
    if (entity.visual) entity.visual.visible = level !== SIMULATION_DORMANT;
    return changed;
  }

  private index(entity: WorldEntity): void {
    this.addToCell(this.cellKey(entity.position.x, entity.position.z), entity.id);
  }

  private addToCell(key: string, id: EntityId): void {
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = new Set();
      this.cells.set(key, bucket);
    }
    bucket.add(id);
  }

  private cellKey(x: number, z: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`;
  }
}
