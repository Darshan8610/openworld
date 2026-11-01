import { Group } from 'three/webgpu';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import type { GameEventBus } from '../core/events';
import type { WorldPoint } from '../core/coordinates';
import { toRenderPoint } from '../core/coordinates';
import type { StreamingRadii } from '../core/entities';
import type { WorldQueries } from '../world/world-queries';
import type { PropPhysicsWorld } from '../physics/prop-physics';
import { boxShape } from '../physics/rigid-body';
import type { RigidBody } from '../physics/rigid-body';
import { damp } from '../utils/math';
import type { Inventory } from '../interaction/inventory';
import type { InteractionAction, InteractionProvider } from '../interaction/types';
import type { InteractionManager } from '../interaction/manager';
import { archetypeOrThrow, initialState } from './archetypes';
import type { AuthoredPlacement, ObjectArchetype, ObjectState } from './archetypes';
import type { PersistedObjects } from '../persistence/object-store';
import { actionsFor } from './actions';
import { createObjectVisual, disposeObjectVisual } from '../rendering/object-geometry';
import type { ObjectVisual } from '../rendering/object-geometry';
import { cellsAround, objectCellKey, planObjectCell } from './placement';
import type { PlacedObject } from './placement';

export interface ObjectSystemOptions {
  readonly seed: string;
  readonly queries: WorldQueries;
  readonly physics: PropPhysicsWorld;
  readonly events: GameEventBus;
  readonly inventory: Inventory;
  readonly interaction: InteractionManager;
  readonly notify: (message: string) => void;
  /** Budget for simultaneously streamed objects. */
  readonly budget: number;
  /** Streamed cell radius; defaults to config. */
  readonly loadRadius?: number;
  /** Restored per-object state from the persistence slice. */
  readonly savedState?: PersistedObjects;
  /** Authored placements (levels, landmarks) merged into the stream. */
  readonly authored?: readonly AuthoredPlacement[];
}

export interface ObjectStats {
  readonly active: number;
  readonly dynamic: number;
  readonly cells: number;
  readonly bodies: number;
  readonly physicsSkipped: number;
  readonly truncated: boolean;
  readonly collected: number;
  readonly authored: number;
}

interface Animation {
  door: number;
  lid: number;
  lever: number;
  wheel: number;
  toggle: number;
  lamp: number;
}

/**
 * One interactive world object: identity + state + visual + optional rigid body,
 * implementing `InteractionProvider` so any interaction source can drive it.
 */
class ObjectInstance implements InteractionProvider {
  readonly actionsList: readonly InteractionAction[];
  readonly anchor = new Group();
  readonly visual: ObjectVisual;
  readonly radii: StreamingRadii;
  readonly centre: WorldPoint = { x: 0, y: 0, z: 0 };
  removed = false;
  body: RigidBody | undefined;
  private readonly inner = new Group();
  private readonly animation: Animation = { door: 0, lid: 0, lever: 0, wheel: 0, toggle: 0, lamp: 0 };
  private readonly renderPoint: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly ignore: WorldPoint = { x: 0, y: 0, z: 0 };

  constructor(
    readonly placed: PlacedObject,
    readonly archetype: ObjectArchetype,
    private stateValue: ObjectState,
    private readonly system: ObjectSystem,
  ) {
    this.actionsList = actionsFor(archetype);
    this.radii = archetype.radii;
    this.visual = createObjectVisual(archetype.mesh, { label: archetype.label, accent: archetype.accent });
    this.anchor.name = `object/${placed.id}`;
    this.anchor.add(this.inner);
    this.inner.add(this.visual.root);
    this.centre.x = placed.x;
    this.centre.y = placed.y + archetype.height * 0.5;
    this.centre.z = placed.z;
    this.applyInitialVisual();
  }

  actions(): readonly InteractionAction[] { return this.actionsList; }

  get id(): string { return this.placed.id; }
  get range(): number { return this.archetype.range; }
  get radius(): number { return this.archetype.radius; }
  get targetLabel(): string { return this.archetype.label; }
  get persistence(): ObjectArchetype['persistence'] { return this.archetype.persistence; }
  get isDynamic(): boolean { return this.archetype.dynamic; }
  get stateValueRef(): ObjectState { return this.stateValue; }

  state(): ObjectState { return this.stateValue; }

  setState(patch: Partial<ObjectState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.system.onInstanceStateChanged(this);
  }

  remove(): void { this.system.removeObject(this.id); }

  /** Attach a rigid body at the object's centre; the visual then follows physics. */
  attachBody(body: RigidBody): void { this.body = body; }

  applyInitialVisual(): void {
    if (this.archetype.dynamic) {
      this.inner.position.y = -this.archetype.height * 0.5;
      this.anchor.position.set(this.placed.x, this.placed.y + this.archetype.height * 0.5, this.placed.z);
    } else {
      this.inner.position.y = 0;
      this.anchor.position.set(this.placed.x, this.placed.y, this.placed.z);
    }
    this.anchor.rotation.y = this.placed.yaw;
    this.applyAnimation(true);
  }

  /** Drive pivots/emissives toward the state, and follow the physics pose. */
  syncVisuals(dt: number, origin: WorldPoint, alpha: number): void {
    if (this.body) {
      this.body.renderPosition(alpha, this.renderPoint);
      toRenderPoint(this.renderPoint, origin, this.anchor.position);
      this.anchor.quaternion.set(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);
      this.centre.x = this.body.position.x;
      this.centre.y = this.body.position.y;
      this.centre.z = this.body.position.z;
    } else {
      toRenderPoint({ x: this.placed.x, y: this.placed.y, z: this.placed.z }, origin, this.ignore);
      this.anchor.position.set(this.ignore.x, this.ignore.y, this.ignore.z);
      if (this.archetype.dynamic) this.anchor.position.y += this.archetype.height * 0.5;
    }
    this.applyAnimation(false, dt);
  }

  private applyAnimation(immediate: boolean, dt = 0): void {
    const state = this.stateValue;
    const target = this.animation;
    const doorTarget = state.open ? -1.92 : 0;
    const lidTarget = state.opened ? -1.5 : 0;
    const leverTarget = state.used ? 0.75 : -0.75;
    const wheelTarget = (state.level ?? 0) * (Math.PI / 2);
    const toggleTarget = state.on ? -0.5 : 0.5;
    const lampTarget = state.on ? 1 : 0;
    if (immediate) {
      target.door = doorTarget; target.lid = lidTarget; target.lever = leverTarget;
      target.wheel = wheelTarget; target.toggle = toggleTarget; target.lamp = lampTarget;
    } else {
      target.door = damp(target.door, doorTarget, 7, dt);
      target.lid = damp(target.lid, lidTarget, 6, dt);
      target.lever = damp(target.lever, leverTarget, 9, dt);
      target.wheel = damp(target.wheel, wheelTarget, 5, dt);
      target.toggle = damp(target.toggle, toggleTarget, 14, dt);
      target.lamp = damp(target.lamp, lampTarget, 8, dt);
    }
    if (this.visual.door) this.visual.door.rotation.y = target.door;
    if (this.visual.lid) this.visual.lid.rotation.x = target.lid;
    if (this.visual.lever) this.visual.lever.rotation.x = target.lever;
    if (this.visual.wheel) this.visual.wheel.rotation.y = target.wheel;
    if (this.visual.toggle) this.visual.toggle.rotation.x = target.toggle;
    if (this.visual.lamp) {
      this.visual.lamp.emissive.setHex(0xffcf87);
      this.visual.lamp.emissiveIntensity = target.lamp * 1.9;
    }
  }

  dispose(): void {
    this.anchor.removeFromParent();
    disposeObjectVisual(this.visual);
  }
}

/**
 * Streaming owner for every interactive world object.
 *
 * Responsibilities: deterministic per-cell planning, budgeted streaming around
 * the player, visual + rigid-body lifecycle, state persistence, and handing
 * interaction providers to the interaction manager. It never modifies terrain,
 * vegetation or roads; it only reads the shared world queries.
 */
export class ObjectSystem {
  readonly group = new Group();
  private readonly active = new Map<string, ObjectInstance>();
  private readonly saved = new Map<string, { archetype: string; state: ObjectState }>();
  private readonly planned = new Map<string, PlacedObject[]>();
  private readonly authored = new Map<string, AuthoredPlacement>();
  private readonly pendingRemoval: string[] = [];
  private readonly lastPosition: WorldPoint = { x: Infinity, y: Infinity, z: Infinity };
  private readonly renderPoint: WorldPoint = { x: 0, y: 0, z: 0 };
  private elapsed: number = CONFIG.objects.updateInterval;
  private enabled = true;
  private disposed = false;
  private truncated = false;
  private physicsSkipped = 0;
  private loadRadius: number;
  private budget: number;
  revision = 0;
  cells = 0;

  constructor(private readonly options: ObjectSystemOptions) {
    this.group.name = 'Phase 6 / interactive world objects';
    this.loadRadius = options.loadRadius ?? CONFIG.objects.loadRadius;
    this.budget = options.budget;
    for (const [id, entry] of Object.entries(options.savedState ?? {})) this.saved.set(id, { archetype: entry.archetype, state: { ...entry.state } });
    for (const placement of options.authored ?? []) this.authored.set(placement.id, placement);
  }

  setQuality(quality: QualityName): void {
    this.budget = QUALITY[quality].objectBudget;
    this.revision++;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
    if (!enabled) {
      // Only object-owned providers are removed; other systems keep theirs.
      for (const id of [...this.active.keys()]) this.destroyInstance(id);
      this.planned.clear();
    } else {
      this.elapsed = CONFIG.objects.updateInterval;
      this.lastPosition.x = Infinity;
    }
  }

  get objectsEnabled(): boolean { return this.enabled; }
  get activeCount(): number { return this.active.size; }
  get stateRevision(): number { return this.revision; }

  /** Add authored placements at runtime (levels, story locations, landmarks). */
  addAuthored(placements: readonly AuthoredPlacement[]): void {
    for (const placement of placements) this.authored.set(placement.id, placement);
    this.elapsed = CONFIG.objects.updateInterval;
    this.lastPosition.x = Infinity;
  }

  update(dt: number, player: WorldPoint, origin: WorldPoint, alpha: number): void {
    if (this.disposed || !this.enabled) return;
    this.flushRemovals();
    this.elapsed += dt;
    const moved = Math.hypot(player.x - this.lastPosition.x, player.z - this.lastPosition.z) > CONFIG.objects.cellSize * 0.5;
    if (this.elapsed >= CONFIG.objects.updateInterval || moved) {
      this.elapsed = 0;
      this.lastPosition.x = player.x; this.lastPosition.y = player.y; this.lastPosition.z = player.z;
      this.stream(player);
    }
    for (const instance of this.active.values()) instance.syncVisuals(dt, origin, alpha);
  }

  /**
   * Reposition every render object after a floating-origin rebase. Physics,
   * state and interaction coordinates stay canonical, so nothing else changes.
   */
  rebase(origin: WorldPoint): void {
    for (const instance of this.active.values()) {
      if (instance.body) instance.body.renderPosition(1, this.renderPoint);
      else { this.renderPoint.x = instance.placed.x; this.renderPoint.y = instance.placed.y; this.renderPoint.z = instance.placed.z; }
      toRenderPoint(this.renderPoint, origin, instance.anchor.position);
      if (!instance.body && instance.archetype.dynamic) instance.anchor.position.y += instance.archetype.height * 0.5;
    }
  }

  private stream(player: WorldPoint): void {
    const cells = cellsAround(player.x, player.z, this.loadRadius);
    this.cells = cells.length;
    const wanted: PlacedObject[] = [];
    // Planning is noise-heavy: build the cache a few cells per tick, nearest
    // first, so a fast-moving camera never stalls a frame on world generation.
    let planningBudget = 6;
    for (const cell of cells) {
      const key = objectCellKey(cell.cellX, cell.cellZ);
      let planned = this.planned.get(key);
      if (!planned) {
        if (planningBudget <= 0) continue;
        planningBudget--;
        planned = planObjectCell(cell.cellX, cell.cellZ, this.options);
        if (this.planned.size >= 96) {
          const oldest = this.planned.keys().next();
          if (!oldest.done) this.planned.delete(oldest.value);
        }
        this.planned.set(key, planned);
      }
      for (const object of planned) wanted.push(object);
    }
    for (const placement of this.authored.values()) {
      wanted.push({
        id: placement.id, archetype: placement.archetype,
        x: placement.x, z: placement.z,
        y: placement.y ?? this.options.queries.height(placement.x, placement.z),
        yaw: placement.yaw ?? 0, source: 'wild', state: placement.state,
      });
    }

    wanted.sort((a, b) => {
      const da = (a.x - player.x) ** 2 + (a.z - player.z) ** 2;
      const db = (b.x - player.x) ** 2 + (b.z - player.z) ** 2;
      return da - db;
    });

    this.truncated = wanted.length > this.budget;
    const keep = new Set<string>();
    for (const object of wanted) {
      if (keep.size >= this.budget) break;
      if (this.saved.get(object.id)?.state.collected) continue;
      keep.add(object.id);
      if (!this.active.has(object.id)) this.instantiate(object);
    }
    for (const id of [...this.active.keys()]) if (!keep.has(id)) this.destroyInstance(id);
  }

  private instantiate(placed: PlacedObject): void {
    let archetype: ObjectArchetype;
    try {
      archetype = archetypeOrThrow(placed.archetype);
    } catch (error) {
      console.error('[objects] invalid placement', placed.id, error);
      return;
    }
    const state: ObjectState = { ...initialState(archetype), ...placed.state, ...(this.saved.get(placed.id)?.state ?? {}) };
    const instance = new ObjectInstance(placed, archetype, state, this);
    this.active.set(placed.id, instance);
    this.group.add(instance.anchor);

    if (archetype.dynamic) {
      const body = this.options.physics.add({
        id: placed.id,
        position: { x: placed.x, y: placed.y + archetype.height * 0.5 + 0.02, z: placed.z },
        shape: boxShape(archetype.radius * 0.74, archetype.height * 0.5, archetype.radius * 0.74),
        material: archetype.material,
        mass: archetype.mass,
        yaw: placed.yaw,
        tag: placed.id,
      });
      if (body) instance.attachBody(body);
      else this.physicsSkipped++;
    }

    this.options.interaction.register(instance);
    this.options.events.emit('object:spawned', { id: placed.id, archetype: archetype.key, kind: archetype.kind });
  }

  private destroyInstance(id: string): void {
    const instance = this.active.get(id);
    if (!instance) return;
    this.active.delete(id);
    this.options.interaction.unregister(id);
    this.options.physics.remove(id);
    instance.dispose();
    this.options.events.emit('object:despawned', { id });
  }

  /** Called by instances; unregisters immediately and defers visual disposal. */
  removeObject(id: string): void {
    const instance = this.active.get(id);
    if (!instance || instance.removed) return;
    instance.removed = true;
    this.options.interaction.unregister(id);
    this.pendingRemoval.push(id);
  }

  private flushRemovals(): void {
    while (this.pendingRemoval.length > 0) this.destroyInstance(this.pendingRemoval.pop()!);
  }

  /** Instance state changed: persist, emit, and keep the visual in sync. */
  onInstanceStateChanged(instance: ObjectInstance): void {
    this.revision++;
    const state = instance.state();
    if (instance.persistence !== 'transient') {
      this.saved.set(instance.id, { archetype: instance.archetype.key, state: { ...state } });
    }
    this.options.events.emit('object:stateChanged', {
      id: instance.id, archetype: instance.archetype.key, state: { ...state },
    });
  }

  stateFor(id: string): ObjectState | undefined {
    return this.active.get(id)?.state() ?? this.saved.get(id)?.state;
  }

  /** Only non-default, persistence-eligible states are written to disk. */
  serializeState(): PersistedObjects {
    const out: PersistedObjects = {};
    for (const [id, entry] of this.saved) {
      let archetype: ObjectArchetype;
      try { archetype = archetypeOrThrow(entry.archetype); } catch { continue; }
      if (archetype.persistence === 'transient') continue;
      if (isDefaultState(archetype, entry.state)) continue;
      out[id] = { archetype: entry.archetype, state: { ...entry.state } };
    }
    return out;
  }

  restoreState(states: PersistedObjects): void {
    this.saved.clear();
    for (const [id, entry] of Object.entries(states)) this.saved.set(id, { archetype: entry.archetype, state: { ...entry.state } });
    for (const instance of this.active.values()) {
      const restored = this.saved.get(instance.id);
      if (restored) instance.setState({ ...restored.state });
    }
    this.elapsed = CONFIG.objects.updateInterval;
    this.lastPosition.x = Infinity;
  }

  /** Nearest active object for HUD/debug readouts. */
  nearest(player: WorldPoint): { id: string; label: string; distance: number } | undefined {
    let best: { id: string; label: string; distance: number } | undefined;
    for (const instance of this.active.values()) {
      const distance = Math.hypot(instance.centre.x - player.x, instance.centre.y - player.y, instance.centre.z - player.z);
      if (!best || distance < best.distance) best = { id: instance.id, label: instance.targetLabel, distance };
    }
    return best;
  }

  /** Interaction target changed — used to keep bodies awake while being handled. */
  focusTarget(id: string | null): void {
    if (!id) return;
    const instance = this.active.get(id);
    instance?.body?.wake();
  }

  get stats(): ObjectStats {
    let dynamic = 0, bodies = 0, collected = 0;
    for (const instance of this.active.values()) {
      if (instance.isDynamic) dynamic++;
      if (instance.body) bodies++;
      if (instance.state().collected) collected++;
    }
    return {
      active: this.active.size,
      dynamic,
      cells: this.cells,
      bodies,
      physicsSkipped: this.physicsSkipped,
      truncated: this.truncated,
      collected,
      authored: this.authored.size,
    };
  }

  /** Inspect active objects (debug overlay / tests). */
  list(): { id: string; archetype: string; x: number; y: number; z: number; state: ObjectState }[] {
    return [...this.active.values()].map((instance) => ({
      id: instance.id, archetype: instance.archetype.key,
      x: instance.centre.x, y: instance.centre.y, z: instance.centre.z, state: { ...instance.state() },
    }));
  }

  reset(seed: string, savedState: PersistedObjects = {}): void {
    for (const id of [...this.active.keys()]) this.destroyInstance(id);
    this.planned.clear();
    this.saved.clear();
    for (const [id, entry] of Object.entries(savedState)) this.saved.set(id, { archetype: entry.archetype, state: { ...entry.state } });
    this.elapsed = CONFIG.objects.updateInterval;
    this.lastPosition.x = Infinity;
    this.physicsSkipped = 0;
    this.revision++;
    this.options.events.emit('world:objectsReset', { seed });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.active.keys()]) this.destroyInstance(id);
    this.planned.clear();
    this.active.clear();
    this.group.removeFromParent();
  }
}

function isDefaultState(archetype: ObjectArchetype, state: ObjectState): boolean {
  const initial = archetype.initial ?? {};
  const keys = new Set([...Object.keys(initial), ...Object.keys(state)]);
  for (const key of keys) {
    const a = (initial as Record<string, unknown>)[key];
    const b = (state as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}
