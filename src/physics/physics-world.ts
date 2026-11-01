import { Quaternion, Vector3 } from 'three/webgpu';
import type {
  Collider, ColliderDesc, EventQueue, RayColliderIntersection, RigidBody, World as RapierWorld,
} from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import type { FloatingOrigin } from '../core/floating-origin';
import type { EventBus } from '../game/events';
import type { PhysicsMaterialId } from './materials';
import { PHYSICS_MATERIALS } from './materials';

type RapierModule = typeof import('@dimforge/rapier3d-compat');

/** Collision membership layers. Rapier packs these into one 32-bit group word. */
export const PHYSICS_LAYER = {
  terrain: 0,
  player: 1,
  npc: 2,
  prop: 3,
  vehicle: 4,
  building: 5,
  water: 6,
  sensor: 7,
} as const;
export type PhysicsLayerName = keyof typeof PHYSICS_LAYER;
export const PHYSICS_LAYER_NAMES = Object.keys(PHYSICS_LAYER) as PhysicsLayerName[];

export function collisionGroups(
  membership: PhysicsLayerName | readonly PhysicsLayerName[],
  filter: readonly PhysicsLayerName[] | 'all' = 'all',
): number {
  const members: readonly PhysicsLayerName[] = Array.isArray(membership) ? membership : [membership as PhysicsLayerName];
  let memberBits = 0;
  for (const name of members) memberBits |= 1 << PHYSICS_LAYER[name];
  let filterBits = 0;
  if (filter === 'all') {
    for (const name of PHYSICS_LAYER_NAMES) filterBits |= 1 << PHYSICS_LAYER[name];
  } else {
    for (const name of filter) filterBits |= 1 << PHYSICS_LAYER[name];
  }
  return ((memberBits & 0xffff) << 16) | (filterBits & 0xffff);
}

export type BodyKind = 'dynamic' | 'fixed' | 'kinematicPosition' | 'kinematicVelocity';

export type ColliderShape =
  | { readonly type: 'box'; readonly halfExtents: { x: number; y: number; z: number } }
  | { readonly type: 'ball'; readonly radius: number }
  | { readonly type: 'capsule'; readonly halfHeight: number; readonly radius: number }
  | { readonly type: 'trimesh'; readonly vertices: Float32Array; readonly indices: Uint32Array }
  | {
    readonly type: 'heightfield';
    readonly nrows: number;
    readonly ncols: number;
    readonly heights: Float32Array;
    readonly scale: { x: number; y: number; z: number };
  };

export interface PhysicsBodyOptions {
  kind?: BodyKind;
  /** Canonical world position; converted into the physics-local frame. */
  position: Vector3 | { x: number; y: number; z: number };
  rotation?: Quaternion | { x: number; y: number; z: number; w: number };
  linearDamping?: number;
  angularDamping?: number;
  ccd?: boolean;
  gravityScale?: number;
  lockRotations?: boolean;
  /** Owning entity; lets gameplay recover its body after queries. */
  entityId?: string;
}

export interface ColliderOptions {
  material?: PhysicsMaterialId;
  friction?: number;
  restitution?: number;
  density?: number;
  sensor?: boolean;
  /** Emit collision events for this collider (needed for triggers). */
  events?: boolean;
  layer?: PhysicsLayerName;
  filter?: readonly PhysicsLayerName[] | 'all';
  /** Collider offset from the body, in metres (physics-local axes). */
  offset?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number; w: number };
}

export interface PhysicsBody {
  readonly id: number;
  readonly kind: BodyKind;
  readonly body: RigidBody;
  readonly colliders: Collider[];
  readonly entityId?: string;
}

export interface PhysicsRayHit {
  collider: Collider;
  body: PhysicsBody | undefined;
  /** Canonical world-space hit point and surface normal. */
  point: Vector3;
  normal: Vector3;
  distance: number;
  sensor: boolean;
}

export interface RaycastOptions {
  includeSensors?: boolean;
  excludeBody?: PhysicsBody;
  /** Only colliders in these layers are considered. */
  layers?: readonly PhysicsLayerName[];
}

export interface PhysicsOptions {
  origin: FloatingOrigin;
  events?: EventBus;
  gravity?: number;
  fixedStep?: number;
  maxSubSteps?: number;
  maxBodies?: number;
  maxColliders?: number;
  collisionSkin?: number;
}

export interface PhysicsStats {
  engine: 'rapier';
  version: string;
  bodies: number;
  dynamic: number;
  fixed: number;
  kinematic: number;
  sleeping: number;
  colliders: number;
  sensors: number;
  awake: number;
  rebases: number;
  substeps: number;
  /** Exponential moving average of the wall time spent inside `step()`. */
  stepMs: number;
  budgetMs: number;
  overBudget: boolean;
  paused: boolean;
}

const STATS_CACHE_MS = 150;

/**
 * Central physics simulation. All gameplay bodies live here — no feature owns a
 * private physics world.
 *
 * Coordinate model: canonical world positions are doubles; Rapier stores f32 and
 * therefore only ever sees **physics-local** coordinates (world - origin). The
 * class converts at its public boundary, and translates every body by -delta
 * whenever the floating origin rebases, so momentum, orientation and sleeping
 * state survive origin shifts.
 *
 * Query timing: Rapier rebuilds its broad-phase during `step()`. Body/collider
 * poses are propagated immediately on teleports and rebases, but ray/shape
 * queries observe the state of the last step. `WorldManager` always runs the
 * ground streamer and the physics step in the same frame after a rebase, so
 * gameplay code never samples a stale query.
 */
export class PhysicsWorld {
  readonly origin: FloatingOrigin;
  readonly api: RapierModule;
  readonly world: RapierWorld;
  readonly events?: EventBus;
  private readonly queue: EventQueue;
  private readonly fixedStep: number;
  private readonly maxSubSteps: number;
  private readonly maxBodies: number;
  private readonly maxColliders: number;
  private readonly collisionSkin: number;
  private readonly bodies = new Map<number, PhysicsBody>();
  private readonly byHandle = new Map<number, PhysicsBody>();
  private readonly unsubscribeOrigin: () => void;
  private nextBodyId = 1;
  private colliderCount = 0;
  private sensorCount = 0;
  private accumulator = 0;
  private rebases = 0;
  private substeps = 0;
  private stepMs = 0;
  private statsAt = 0;
  private cachedStats?: PhysicsStats;
  private failed = false;
  paused = false;

  private constructor(api: RapierModule, options: PhysicsOptions) {
    this.api = api;
    this.origin = options.origin;
    this.events = options.events;
    this.fixedStep = options.fixedStep ?? CONFIG.physics.fixedStep;
    this.maxSubSteps = options.maxSubSteps ?? CONFIG.physics.maxSubSteps;
    this.maxBodies = options.maxBodies ?? CONFIG.physics.maxBodies;
    this.maxColliders = options.maxColliders ?? CONFIG.physics.maxColliders;
    this.collisionSkin = options.collisionSkin ?? CONFIG.physics.collisionSkin;
    const gravity = options.gravity ?? CONFIG.physics.gravity;
    this.world = new api.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = this.fixedStep;
    this.queue = new api.EventQueue(true);
    this.unsubscribeOrigin = this.origin.onChange((delta) => this.rebase(delta));
  }

  /**
   * Loads Rapier lazily so the renderer can start before the WASM arrives and so
   * a physics failure never prevents the world from rendering.
   */
  static async create(options: PhysicsOptions): Promise<PhysicsWorld> {
    const module = await import('@dimforge/rapier3d-compat');
    const api = (module as unknown as { default?: RapierModule }).default ?? (module as unknown as RapierModule);
    await api.init();
    const physics = new PhysicsWorld(api, options);
    options.events?.emit('physics:ready', { engine: 'rapier', version: api.version() });
    return physics;
  }

  get engineVersion(): string { return this.api.version(); }
  bodyById(id: number): PhysicsBody | undefined { return this.bodies.get(id); }
  get bodyCount(): number { return this.bodies.size; }
  get colliderCountValue(): number { return this.colliderCount; }
  get bodyBudget(): number { return this.maxBodies; }

  /** Create a rigid body in canonical world space. Returns undefined at budget. */
  createBody(options: PhysicsBodyOptions): PhysicsBody | undefined {
    if (this.failed) return undefined;
    if (this.bodies.size >= this.maxBodies) {
      this.events?.emit('physics:budget-exceeded', { limit: 'bodies', count: this.bodies.size, cap: this.maxBodies });
      return undefined;
    }
    const position = toVector3(options.position);
    assertFinite(position, 'body position');
    const local = this.origin.toLocal(position);
    const kind = options.kind ?? 'dynamic';
    const descriptors = this.api.RigidBodyDesc;
    const desc = kind === 'fixed' ? descriptors.fixed()
      : kind === 'kinematicPosition' ? descriptors.kinematicPositionBased()
        : kind === 'kinematicVelocity' ? descriptors.kinematicVelocityBased()
          : descriptors.dynamic();
    desc.setTranslation(local.x, local.y, local.z);
    if (options.rotation) {
      const rotation = options.rotation;
      desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    }
    if (options.linearDamping !== undefined) desc.setLinearDamping(options.linearDamping);
    if (options.angularDamping !== undefined) desc.setAngularDamping(options.angularDamping);
    if (options.gravityScale !== undefined) desc.setGravityScale(options.gravityScale);
    if (options.lockRotations) desc.lockRotations();
    if (options.ccd) desc.setCcdEnabled(true);

    const body = this.world.createRigidBody(desc);
    const record: PhysicsBody = {
      id: this.nextBodyId++, kind, body, colliders: [],
      ...(options.entityId ? { entityId: options.entityId } : {}),
    };
    this.bodies.set(record.id, record);
    this.byHandle.set(body.handle, record);
    this.cachedStats = undefined;
    return record;
  }

  /** Attach a collider/shape to an existing body. Returns undefined at budget. */
  addCollider(record: PhysicsBody, shape: ColliderShape, options: ColliderOptions = {}): Collider | undefined {
    if (this.failed) return undefined;
    if (this.colliderCount >= this.maxColliders) {
      this.events?.emit('physics:budget-exceeded', { limit: 'colliders', count: this.colliderCount, cap: this.maxColliders });
      return undefined;
    }
    const descriptor = this.describeShape(shape);
    const material = options.material ? PHYSICS_MATERIALS[options.material] : undefined;
    descriptor.setFriction(options.friction ?? material?.friction ?? 0.8);
    descriptor.setRestitution(options.restitution ?? material?.restitution ?? 0.05);
    descriptor.setDensity(options.density ?? material?.density ?? 1000);
    descriptor.setContactSkin(this.collisionSkin);
    if (options.sensor) descriptor.setSensor(true);
    if (options.events) descriptor.setActiveEvents(this.api.ActiveEvents.COLLISION_EVENTS);
    if (options.layer) descriptor.setCollisionGroups(collisionGroups(options.layer, options.filter ?? 'all'));
    if (options.offset) descriptor.setTranslation(options.offset.x, options.offset.y, options.offset.z);
    if (options.rotation) descriptor.setRotation(options.rotation);
    const collider = this.world.createCollider(descriptor, record.body);
    record.colliders.push(collider);
    this.colliderCount += 1;
    if (options.sensor) this.sensorCount += 1;
    this.cachedStats = undefined;
    return collider;
  }

  /** Convenience: body + single collider in one call. */
  createSolid(
    options: PhysicsBodyOptions,
    shape: ColliderShape,
    collider: ColliderOptions = {},
  ): PhysicsBody | undefined {
    const record = this.createBody(options);
    if (!record) return undefined;
    const created = this.addCollider(record, shape, collider);
    if (!created) {
      this.destroy(record);
      return undefined;
    }
    return record;
  }

  destroy(record: PhysicsBody): void {
    if (!this.bodies.has(record.id)) return;
    for (const collider of record.colliders) {
      if (collider.isSensor()) this.sensorCount -= 1;
      this.colliderCount -= 1;
    }
    this.world.removeRigidBody(record.body);
    this.bodies.delete(record.id);
    this.byHandle.delete(record.body.handle);
    this.cachedStats = undefined;
  }

  destroyAll(): void {
    for (const record of [...this.bodies.values()]) this.destroy(record);
    this.accumulator = 0;
  }

  /** Canonical world position of a body (f32 internal pose, returned as doubles). */
  positionOf(record: PhysicsBody, target = new Vector3()): Vector3 {
    const translation = record.body.translation();
    return this.worldFromLocal({ x: translation.x, y: translation.y, z: translation.z }, target);
  }

  velocityOf(record: PhysicsBody, target = new Vector3()): Vector3 {
    const velocity = record.body.linvel();
    return target.set(velocity.x, velocity.y, velocity.z);
  }

  /** Teleport a body using canonical coordinates (keeps its velocity). */
  setPosition(record: PhysicsBody, position: Vector3 | { x: number; y: number; z: number }): void {
    const canonical = toVector3(position);
    assertFinite(canonical, 'body position');
    const local = this.origin.toLocal(canonical);
    record.body.setTranslation({ x: local.x, y: local.y, z: local.z }, true);
    if (record.kind === 'kinematicPosition' || record.kind === 'kinematicVelocity') {
      record.body.setNextKinematicTranslation({ x: local.x, y: local.y, z: local.z });
    }
    // Queries read collider poses, so a teleport must be propagated immediately.
    this.propagatePoses();
  }

  /**
   * Fixed-step advance with bounded catch-up. Never steps from a render delta, and
   * never lets a long frame produce unbounded work.
   */
  step(dt: number): number {
    if (this.failed || this.paused) return 0;
    const started = now();
    this.accumulator += Math.min(dt, this.fixedStep * this.maxSubSteps);
    let steps = 0;
    try {
      while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
        this.world.step(this.queue);
        this.drainCollisionEvents();
        this.accumulator -= this.fixedStep;
        steps += 1;
      }
    } catch (error) {
      this.failed = true;
      this.events?.emit('physics:unavailable', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (steps === this.maxSubSteps) this.accumulator = 0;
    this.substeps += steps;
    const elapsed = now() - started;
    this.stepMs = this.stepMs === 0 ? elapsed : this.stepMs * 0.9 + elapsed * 0.1;
    return steps;
  }

  /**
   * Ray cast in canonical world space. The ray is converted into the physics
   * frame, so callers never think about origins.
   */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number, options: RaycastOptions = {}): PhysicsRayHit | undefined {
    const localOrigin = this.origin.toLocal(origin, new Vector3());
    const hit = this.raycastLocal(localOrigin, direction, maxDistance, options);
    if (!hit) return undefined;
    this.worldFromLocal(hit.point, hit.point);
    return hit;
  }

  raycastLocal(origin: Vector3, direction: Vector3, maxDistance: number, options: RaycastOptions = {}): PhysicsRayHit | undefined {
    if (this.failed) return undefined;
    const condition = options.includeSensors ? undefined : this.api.QueryFilterFlags.EXCLUDE_SENSORS;
    const group = options.layers ? collisionGroups('prop', options.layers) : undefined;
    const ray = new this.api.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: direction.x, y: direction.y, z: direction.z });
    const hit: RayColliderIntersection | null = this.world.castRayAndGetNormal(
      ray, maxDistance, true, condition, group, undefined, options.excludeBody?.body,
    );
    if (!hit) return undefined;
    const point = origin.clone().addScaledVector(direction, hit.timeOfImpact);
    const body = hit.collider.parent();
    return {
      collider: hit.collider,
      body: body ? this.byHandle.get(body.handle) : undefined,
      point,
      normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: hit.timeOfImpact,
      sensor: hit.collider.isSensor(),
    };
  }

  /** Downward ground probe in canonical space; the workhorse for landing checks. */
  groundAt(position: Vector3, probeHeight = 40, layers: readonly PhysicsLayerName[] = ['terrain', 'prop', 'building', 'vehicle']): PhysicsRayHit | undefined {
    const origin = position.clone();
    origin.y += probeHeight;
    return this.raycast(origin, DOWN, probeHeight * 2, { layers });
  }

  /** Collider wireframes for the debug overlay (physics-local, already rebased). */
  debugLines(): { vertices: Float32Array; colors: Float32Array } {
    const buffers = this.world.debugRender();
    return { vertices: buffers.vertices, colors: buffers.colors };
  }

  localFromWorld(worldPosition: Vector3, target = new Vector3()): Vector3 {
    return this.origin.toLocal(worldPosition, target);
  }

  worldFromLocal(localPosition: Vector3 | { x: number; y: number; z: number }, target = new Vector3()): Vector3 {
    return target.set(
      localPosition.x + this.origin.absolute.x,
      localPosition.y + this.origin.absolute.y,
      localPosition.z + this.origin.absolute.z,
    );
  }

  get stats(): PhysicsStats {
    const stamp = now();
    if (this.cachedStats && stamp - this.statsAt < STATS_CACHE_MS) return this.cachedStats;
    let dynamic = 0, fixed = 0, kinematic = 0, sleeping = 0, awake = 0;
    this.world.forEachRigidBody((body) => {
      if (body.isFixed()) fixed += 1;
      else if (body.isKinematic()) kinematic += 1;
      else {
        dynamic += 1;
        if (body.isSleeping()) sleeping += 1;
        else awake += 1;
      }
    });
    this.cachedStats = {
      engine: 'rapier',
      version: this.api.version(),
      bodies: this.bodies.size,
      dynamic, fixed, kinematic, sleeping, awake,
      colliders: this.colliderCount,
      sensors: this.sensorCount,
      rebases: this.rebases,
      substeps: this.substeps,
      stepMs: this.stepMs,
      budgetMs: CONFIG.physics.stepBudgetMs,
      overBudget: this.stepMs > CONFIG.physics.stepBudgetMs,
      paused: this.paused,
    };
    this.statsAt = stamp;
    return this.cachedStats;
  }

  /** True once a step has thrown; the game keeps rendering with physics disabled. */
  get isFailed(): boolean { return this.failed; }

  dispose(): void {
    this.unsubscribeOrigin();
    this.destroyAll();
    this.queue.free();
    this.world.free();
  }

  private propagatePoses(): void {
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  private describeShape(shape: ColliderShape): ColliderDesc {
    const api = this.api;
    switch (shape.type) {
      case 'box':
        return api.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
      case 'ball':
        return api.ColliderDesc.ball(shape.radius);
      case 'capsule':
        return api.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      case 'trimesh':
        return api.ColliderDesc.trimesh(shape.vertices, shape.indices);
      case 'heightfield':
        return api.ColliderDesc.heightfield(shape.nrows, shape.ncols, shape.heights, {
          x: shape.scale.x, y: shape.scale.y, z: shape.scale.z,
        });
      default: {
        const exhaustive: never = shape;
        throw new Error(`Unsupported collider shape: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private drainCollisionEvents(): void {
    if (!this.events) {
      this.queue.drainCollisionEvents(() => undefined);
      return;
    }
    const bus = this.events;
    this.queue.drainCollisionEvents((a, b, started) => {
      bus.emit('physics:collision', { a, b, started });
    });
  }

  /**
   * Translate every body by -delta and publish the shift. Velocities, angular
   * velocities, joints, sleeping state and canonical positions are preserved;
   * only the f32 render/physics frame changes.
   */
  private rebase(delta: Vector3): void {
    this.world.forEachRigidBody((body) => {
      const translation = body.translation();
      const next = { x: translation.x - delta.x, y: translation.y - delta.y, z: translation.z - delta.z };
      body.setTranslation(next, false);
      if (body.isKinematic()) body.setNextKinematicTranslation(next);
    });
    // Ray/shape queries use collider poses; propagate without waiting for a step.
    this.propagatePoses();
    this.accumulator = 0;
    this.rebases += 1;
    this.cachedStats = undefined;
    this.events?.emit('world:origin-shifted', {
      x: this.origin.absolute.x, y: this.origin.absolute.y, z: this.origin.absolute.z, shifts: this.origin.shifts,
    });
  }
}

const DOWN = new Vector3(0, -1, 0);

function toVector3(value: Vector3 | { x: number; y: number; z: number }): Vector3 {
  return value instanceof Vector3 ? value : new Vector3(value.x, value.y, value.z);
}

function assertFinite(position: Vector3, label: string): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    throw new TypeError(`Invalid ${label}: ${position.toArray().join(', ')}`);
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
