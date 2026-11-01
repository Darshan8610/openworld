import { BoxGeometry, Group, Mesh, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import type { FloatingOrigin } from '../core/floating-origin';
import type { RoadNetwork } from '../world/road-network';
import { WorldQuery } from '../world/world-query';
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

export interface WorldManagerOptions {
  origin: FloatingOrigin;
  terrain: TerrainStreamSource;
  vegetation: WorldStreamLayer;
  roads: RoadStreamSource;
  events: EventBus;
  registry?: EntityRegistry;
  /** Overrides for the developer physics sandbox. */
  maxSandboxProps?: number;
}

export interface WorldStats {
  entities: EntityRegistryStats;
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
    this.maxSandboxProps = options.maxSandboxProps ?? MAX_SANDBOX_PROPS;
    this.props.name = 'Runtime physics props';
  }

  /** Attach physics once the WASM engine has finished loading. */
  setPhysics(physics: PhysicsWorld, ground: PhysicsGroundStreamer, debug: PhysicsDebugRenderer): void {
    this.physics = physics;
    this.ground = ground;
    this.debug = debug;
  }

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

  update(dt: number, position: Vector3): void {
    this.terrain.update(position, dt);
    this.vegetation.update(position, dt);
    this.roads.update(position, dt);
    let fixedSteps = 0;
    if (this.physics && this.enabled && this.ready) {
      this.ground?.update(position, dt);
      fixedSteps = this.physics.step(dt);
      this.syncPhysicsVisuals();
    }
    this.registry.stream(position);
    this.registry.tick(dt);
    this.debug?.update();
    this.events.emit('world:tick', { fixedSteps, dt });
  }

  /** Seed/quality reset: drop sandbox props and any streamed physics ground. */
  reset(): void {
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
    return stats;
  }

  dispose(): void {
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
