import { BoxGeometry, Group, Mesh, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import type { FloatingOrigin } from '../core/floating-origin';
import type { RoadNetwork } from '../world/road-network';
import { WorldQuery } from '../world/world-query';
import type { GroundCondition } from '../world/world-query';
import type { BuoyancySolver } from '../physics/buoyancy';
import type { WaterStats } from '../world/water-manager';
import type { GroundTile, PhysicsGroundStreamer, GroundStreamStats } from '../physics/ground-streamer';
import type { PhysicsDebugRenderer } from '../physics/debug-renderer';
import type { PhysicsStats, PhysicsWorld } from '../physics/physics-world';
import { createEntity } from './entity';
import type { WorldEntity } from './entity';
import { EntityRegistry } from './entity-registry';
import type { EntityRegistryStats } from './entity-registry';
import type { EventBus } from './events';

/**
 * The slice of a render/stream layer the manager drives. Terrain, vegetation and
 * roads all satisfy it, and tests can substitute fakes without a renderer.
 */
export interface WorldStreamLayer {
  update(position: Vector3, dt: number): void;
}

/** Terrain as consumed by the world manager, the ground streamer and queries. */
export interface TerrainStreamSource extends WorldStreamLayer {
  readonly activeTiles: Iterable<GroundTile>;
  readonly revision: number;
  heightAt(x: number, z: number): number | undefined;
  biomeAt(x: number, z: number): number;
}

export interface RoadStreamSource extends WorldStreamLayer {
  readonly network: RoadNetwork;
}

/**
 * Water streaming as the manager drives it. The real implementation is
 * `world/water-manager`; tests substitute a fake.
 */
export interface WaterStreamSource {
  readonly group: { visible: boolean; name: string };
  readonly stats: WaterStats;
  update(dt: number, position: Vector3, cameraPosition: Vector3, time: number): void;
  rebase(): void;
  setEnabled(enabled: boolean): void;
  get isEnabled(): boolean;
  /** Water query in `WorldQuery` shape, or undefined on dry land. */
  query(x: number, z: number): { bodyId: string; surfaceHeight: number; depth: number; flowX: number; flowZ: number } | undefined;
}

export interface WorldManagerOptions {
  origin: FloatingOrigin;
  terrain: TerrainStreamSource;
  vegetation: WorldStreamLayer;
  roads: RoadStreamSource;
  events: EventBus;
  /** Phase 9 water surface streaming; optional so headless tests stay light. */
  water?: WaterStreamSource;
  /** Phase 9 water forces for rapier bodies. */
  buoyancy?: BuoyancySolver;
  /** Weather-owned ground state (wetness / snow cover) for the query layer. */
  condition?: (x: number, z: number) => GroundCondition;
  registry?: EntityRegistry;
  /** Overrides for the developer physics sandbox. */
  maxSandboxProps?: number;
}

export interface WorldStats {
  entities: EntityRegistryStats;
  water?: WaterStats;
  conditions?: GroundCondition;
  physics?: PhysicsStats;
  ground?: GroundStreamStats;
  props: number;
  debugVisible: boolean;
  enabled: boolean;
}

const MAX_SANDBOX_PROPS = 24;

/**
 * Coordinates the streamed world in one deterministic order, so no subsystem
 * silently depends on another's update timing:
 *
 *   terrain → vegetation → roads → physics ground → physics → entity streaming
 *   → entity simulation → physics-driven visual sync
 *
 * Physics ground colliders are created *before* the physics step so a newly
 * streamed tile is solid in the same frame the player arrives on it.
 *
 * The manager owns no rendering state beyond the runtime prop group; terrain,
 * vegetation and roads keep their existing owners.
 */
export class WorldManager {
  readonly registry: EntityRegistry;
  readonly query: WorldQuery;
  readonly events: EventBus;
  /** Parent for runtime-spawned physics props (developer sandbox). */
  readonly props = new Group();
  private readonly origin: FloatingOrigin;
  private readonly terrain: TerrainStreamSource;
  private readonly vegetation: WorldStreamLayer;
  private readonly roads: RoadStreamSource;
  private readonly maxSandboxProps: number;
  private water?: WaterStreamSource;
  private buoyancy?: BuoyancySolver;
  private waterTime = 0;
  /** Last observed floating-origin shift, so layers rebase exactly once. */
  private lastShift = 0;
  private conditions: GroundCondition = { wetness: 0, snowCover: 0 };
  private readonly boxGeometry = new BoxGeometry(1, 1, 1);
  private readonly boxMaterial = new MeshStandardNodeMaterial({ color: 0xa8834c, roughness: 0.82, metalness: 0.05 });
  private readonly sandboxIds: string[] = [];
  private physics?: PhysicsWorld;
  private ground?: PhysicsGroundStreamer;
  private debug?: PhysicsDebugRenderer;
  private ready = false;
  private enabled = true;

  constructor(options: WorldManagerOptions) {
    this.origin = options.origin;
    this.terrain = options.terrain;
    this.vegetation = options.vegetation;
    this.roads = options.roads;
    this.events = options.events;
    this.registry = options.registry ?? new EntityRegistry();
    this.query = new WorldQuery(options.terrain, options.roads.network);
    this.water = options.water;
    this.buoyancy = options.buoyancy;
    // The water field is the single authority for "is there water here".
    if (options.water) this.query.registerWater((x, z) => options.water?.query(x, z));
    if (options.condition) this.query.registerCondition(options.condition);
    // Always answer with the live value; the default is dry and snow-free.
    if (!options.condition) this.query.registerCondition(() => this.conditions);
    this.maxSandboxProps = options.maxSandboxProps ?? MAX_SANDBOX_PROPS;
    this.props.name = 'Runtime physics props';
  }

  /** Attach physics once the WASM engine has finished loading. */
  setPhysics(physics: PhysicsWorld, ground: PhysicsGroundStreamer, debug: PhysicsDebugRenderer): void {
    this.physics = physics;
    this.ground = ground;
    this.debug = debug;
    // Water forces are applied inside Rapier's own fixed substep loop, so a
    // floating body never depends on the render rate or on our step order.
    this.armBuoyancy();
  }

  /**
   * Attach (or replace) the water layer. A seed/quality rebuild creates a new
   * water field, so the query provider and the physics force field are re-armed
   * here instead of capturing a dead instance.
   */
  setWater(water: WaterStreamSource | undefined): void {
    this.water = water;
    this.query.registerWater(water ? (x, z) => water.query(x, z) : undefined);
  }

  /** Attach (or replace) the buoyancy solver used by rapier bodies. */
  setBuoyancy(buoyancy: BuoyancySolver | undefined): void {
    this.buoyancy = buoyancy;
    const physics = this.physics;
    if (!physics) return;
    this.armBuoyancy();
    void physics;
  }

  private armBuoyancy(): void {
    const physics = this.physics;
    const solver = this.buoyancy;
    if (!physics) return;
    // Runs inside Rapier's own substep loop, on the physics clock, so buoyancy can
    // never be applied twice per frame or depend on the render rate.
    physics.preStep = solver ? (dt) => solver.applyToRapier(physics, dt, this.waterTime) : undefined;
  }

  /**
   * Weather-owned ground state, refreshed by the environment layer. Registered as
   * a live provider (not a snapshot) so every query sees the newest value without
   * the environment having to re-register on each change.
   */
  setCondition(condition: GroundCondition): void {
    this.conditions = condition;
    this.query.registerCondition(() => this.conditions);
  }

  get waterManager(): WaterStreamSource | undefined { return this.water; }

  get physicsWorld(): PhysicsWorld | undefined { return this.physics; }
  get physicsDebug(): PhysicsDebugRenderer | undefined { return this.debug; }
  get isEnabled(): boolean { return this.enabled; }
  get isReady(): boolean { return this.ready; }
  get debugVisible(): boolean { return this.debug?.visible ?? false; }

  /** The loading gate: physics only steps once the world is presentable. */
  setReady(ready: boolean): void { this.ready = ready; }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.physics) this.physics.paused = !enabled;
  }

  /**
   * One deterministic order for the whole streamed world:
   *
   *   terrain → vegetation → roads → water → physics ground → physics
   *   → entity streaming → entity simulation → physics-driven visual sync
   */
  update(dt: number, position: Vector3, cameraPosition: Vector3 = position): void {
    this.waterTime += dt;
    // Weather-owned ground state at the player: the same answer grip, particles
    // and the surface query use.
    this.conditions = this.query.conditionAt(position.x, position.z);
    this.terrain.update(position, dt);
    this.vegetation.update(position, dt);
    this.roads.update(position, dt);
    this.water?.update(dt, position, cameraPosition, this.waterTime);
    let fixedSteps = 0;
    if (this.physics && this.enabled && this.ready) {
      this.ground?.update(position, dt);
      fixedSteps = this.physics.step(dt);
      this.syncPhysicsVisuals();
    }
    // The floating origin may have moved during this update (character or camera).
    // Water geometry is canonical, so a rebase only offsets its meshes.
    if (this.origin.shifts !== this.lastShift) {
      this.lastShift = this.origin.shifts;
      this.water?.rebase();
    }
    this.registry.stream(position);
    this.registry.tick(dt);
    this.debug?.update();
    this.events.emit('world:tick', { fixedSteps, dt });
  }

  /** Seed/quality reset: drop sandbox props and any streamed physics ground. */
  reset(): void {
    this.waterTime = 0;
    this.clearSandboxProps();
    this.registry.clear();
    // Ground bodies are destroyed with everything else; bookkeeping goes first so
    // the streamer never re-queries a dead handle, then it rebuilds from scratch.
    this.ground?.forget();
    this.physics?.destroyAll();
  }

  /**
   * Developer sandbox: drop a physically simulated crate. This is a real rigid
   * body plus a registered entity, not a decorative mesh.
   */
  spawnCrate(position: Vector3, size = 0.45): WorldEntity | undefined {
    const physics = this.physics;
    if (!physics) return undefined;
    while (this.sandboxIds.length >= this.maxSandboxProps) {
      const oldest = this.sandboxIds.shift();
      if (oldest) this.removeEntity(oldest, true);
    }
    const body = physics.createSolid(
      { kind: 'dynamic', position, linearDamping: 0.02, angularDamping: 0.15, ccd: true },
      { type: 'box', halfExtents: { x: size, y: size, z: size } },
      { material: 'wood', layer: 'prop', restitution: 0.12 },
    );
    if (!body) return undefined;
    const mesh = new Mesh(this.boxGeometry, this.boxMaterial);
    mesh.scale.setScalar(size * 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.props.add(mesh);
    const entity = createEntity({
      kind: 'prop',
      position,
      radius: size * 1.8,
      height: size * 2,
      priority: 0.8,
      persistence: 'none',
      visual: mesh,
      physics: { bodyId: body.id, colliders: body.colliders.map((collider) => collider.handle) },
    });
    this.registry.add(entity);
    this.sandboxIds.push(entity.id);
    this.events.emit('entity:spawned', { id: entity.id, kind: entity.kind });
    return entity;
  }

  clearSandboxProps(): void {
    for (const id of [...this.sandboxIds]) this.removeEntity(id, true);
    this.sandboxIds.length = 0;
  }

  get sandboxPropCount(): number { return this.sandboxIds.length; }

  get stats(): WorldStats {
    const stats: WorldStats = {
      entities: this.registry.stats(),
      props: this.sandboxIds.length,
      debugVisible: this.debugVisible,
      enabled: this.enabled,
    };
    if (this.physics) stats.physics = this.physics.stats;
    if (this.ground) stats.ground = this.ground.stats;
    if (this.water) stats.water = this.water.stats;
    stats.conditions = this.conditions;
    return stats;
  }

  dispose(): void {
    if (this.physics) this.physics.preStep = undefined;
    this.clearSandboxProps();
    this.registry.clear();
    this.boxGeometry.dispose();
    this.boxMaterial.dispose();
    this.props.removeFromParent();
  }

  private removeEntity(id: string, destroyBody: boolean): void {
    const entity = this.registry.get(id);
    if (!entity) return;
    if (destroyBody && entity.physics && this.physics) {
      const record = this.physics.bodyById(entity.physics.bodyId);
      if (record) this.physics.destroy(record);
    }
    if (entity.visual) {
      entity.visual.removeFromParent();
    }
    this.registry.remove(id);
    this.events.emit('entity:removed', { id, kind: entity.kind });
  }

  /**
   * Bodies are simulated in the physics frame and visuals render in the same
   * frame, so a pose copy is all that is required — including across rebases.
   */
  private syncPhysicsVisuals(): void {
    const physics = this.physics;
    if (!physics) return;
    for (const entity of this.registry.entities()) {
      if (!entity.physics || !entity.visual) continue;
      const record = physics.bodyById(entity.physics.bodyId);
      if (!record) continue;
      const translation = record.body.translation();
      const rotation = record.body.rotation();
      entity.visual.position.set(translation.x, translation.y, translation.z);
      entity.visual.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      const worldX = translation.x + this.origin.absolute.x;
      const worldZ = translation.z + this.origin.absolute.z;
      if ((worldX - entity.position.x) ** 2 + (worldZ - entity.position.z) ** 2 > 0.25) {
        this.registry.move(entity.id, worldX, worldZ);
      }
      entity.position.y = translation.y + this.origin.absolute.y;
    }
  }
}
