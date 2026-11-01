import { Group, Vector3 } from 'three/webgpu';
import { CONFIG } from '../config';
import { toRenderPoint } from '../core/coordinates';
import type { WorldPoint } from '../core/coordinates';
import type { GameEventBus } from '../core/events';
import type { InteractionManager } from '../interaction/manager';
import type { WorldQueries } from '../world/world-queries';
import type { PersistedVehicles } from '../persistence/vehicle-store';
import { Vehicle } from './vehicle';
import { vehicleSpec } from './catalog';
import { VehicleAudioHooks } from './vehicle-audio';
import { WorldVehicleEnvironment } from './vehicle-environment';
import { planVehicleCell, vehicleCellKey, vehicleCellsAround } from './placement';
import type { PlacedVehicle } from './placement';
import type { VehicleWaterProvider } from './types';

export interface VehicleSystemOptions {
  readonly seed: string;
  readonly queries: WorldQueries;
  readonly events: GameEventBus;
  readonly interaction: InteractionManager;
  readonly water?: VehicleWaterProvider;
  /** Restored per-vehicle state from the persistence slice. */
  readonly savedState?: PersistedVehicles;
  readonly budget?: number;
  readonly loadRadius?: number;
}

export interface VehicleStats {
  readonly active: number;
  readonly simulated: number;
  readonly cells: number;
  readonly truncated: boolean;
  readonly occupied: number;
  readonly driven: string | null;
}

/**
 * Streams vehicles around the player, steps their physics on the fixed step,
 * and owns entry/exit and persistence.
 *
 * Three deliberate choices:
 *
 * 1. **Canonical coordinates throughout.** Every vehicle body lives in world
 *    doubles. A floating-origin rebase only rewrites render transforms, so a
 *    vehicle parked 3 km away is in exactly the same place before and after —
 *    nothing is re-simulated and nothing drifts.
 * 2. **Simulation levels, not on/off.** Vehicles near the player step fully;
 *    distant ones are frozen but keep their state. The player's own vehicle is
 *    always fully simulated regardless of the budget.
 * 3. **Unload never destroys player work.** A vehicle that has been moved or
 *    damaged is written to the persistence diff before its instance is
 *    released, so driving one somewhere and walking away keeps it there.
 */
export class VehicleSystem {
  readonly root = new Group();
  readonly environment: WorldVehicleEnvironment;

  private readonly active = new Map<string, Vehicle>();
  private readonly anchors = new Map<string, Group>();
  private readonly audio = new Map<string, VehicleAudioHooks>();
  private readonly planned = new Map<string, PlacedVehicle[]>();
  private readonly persisted: PersistedVehicles;
  private readonly pendingRemoval: string[] = [];
  private readonly renderPoint: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly poseScratch = new Vector3();
  private readonly lastPosition: WorldPoint = { x: Infinity, y: 0, z: 0 };
  private readonly budget: number;
  private readonly loadRadius: number;

  private elapsed = 0;
  private cells = 0;
  private simulated = 0;
  private truncated = false;
  private disposed = false;
  private revision = 0;
  /** Id of the vehicle the player is driving, if any. */
  private drivenId: string | null = null;

  enabled = true;

  constructor(private readonly options: VehicleSystemOptions) {
    this.root.name = 'vehicles';
    this.budget = options.budget ?? CONFIG.vehicles.budget;
    this.loadRadius = options.loadRadius ?? CONFIG.vehicles.loadRadius;
    this.persisted = { ...(options.savedState ?? {}) };
    this.environment = new WorldVehicleEnvironment(options.queries, options.water);
  }

  get activeCount(): number { return this.active.size; }
  get stateRevision(): number { return this.revision; }
  get driven(): Vehicle | undefined { return this.drivenId ? this.active.get(this.drivenId) : undefined; }

  stats(): VehicleStats {
    let occupied = 0;
    for (const vehicle of this.active.values()) if (vehicle.occupiedSeats > 0) occupied++;
    return {
      active: this.active.size,
      simulated: this.simulated,
      cells: this.cells,
      truncated: this.truncated,
      occupied,
      driven: this.drivenId,
    };
  }

  audioFor(id: string): VehicleAudioHooks | undefined { return this.audio.get(id); }

  /** Canonical position of a live vehicle, for audio panning and captions. */
  positionOf(id: string): { x: number; y: number; z: number } | undefined {
    const vehicle = this.active.get(id);
    if (!vehicle) return undefined;
    const p = vehicle.body.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  /** Install the Phase 9 water system; boats rest on terrain until then. */
  setWaterProvider(provider: VehicleWaterProvider | undefined): void {
    this.environment.setWaterProvider(provider);
  }

  /**
   * Fixed-step physics for every simulated vehicle. Called from the game's
   * fixed loop — never from `render` — so behaviour is identical at 30 and
   * 240 fps.
   */
  fixedUpdate(dt: number, player: WorldPoint): void {
    if (this.disposed || !this.enabled) return;
    this.simulated = 0;
    const radius = CONFIG.vehicles.simulateRadius;
    const radiusSq = radius * radius;
    let budget = CONFIG.vehicles.activeBudget;

    for (const vehicle of this.active.values()) {
      const dx = vehicle.body.position.x - player.x;
      const dz = vehicle.body.position.z - player.z;
      const near = dx * dx + dz * dz <= radiusSq;
      // The driven vehicle is never budgeted out from under the player.
      const isDriven = vehicle.id === this.drivenId;
      if (!isDriven && (!near || budget <= 0)) {
        vehicle.body.frozen = true;
        continue;
      }
      if (!isDriven) budget--;
      vehicle.body.frozen = false;
      vehicle.fixedUpdate(dt, this.environment);
      this.simulated++;
    }
  }

  /** Per-frame streaming and visual sync. Carries no physics. */
  update(dt: number, player: WorldPoint, origin: WorldPoint, alpha: number): void {
    if (this.disposed || !this.enabled) return;
    this.flushRemovals();
    this.elapsed += dt;
    const moved = Math.hypot(player.x - this.lastPosition.x, player.z - this.lastPosition.z) > CONFIG.vehicles.cellSize * 0.4;
    if (this.elapsed >= CONFIG.vehicles.updateInterval || moved) {
      this.elapsed = 0;
      this.lastPosition.x = player.x; this.lastPosition.y = player.y; this.lastPosition.z = player.z;
      this.stream(player);
    }
    for (const [id, vehicle] of this.active) {
      const anchor = this.anchors.get(id);
      if (anchor) {
        // Interpolate in canonical space, then rebase to render space — never
        // the other way round, or precision is lost far from the origin.
        vehicle.renderPose(alpha, this.poseScratch, anchor.quaternion);
        this.renderPoint.x = this.poseScratch.x;
        this.renderPoint.y = this.poseScratch.y;
        this.renderPoint.z = this.poseScratch.z;
        toRenderPoint(this.renderPoint, origin, anchor.position);
      }
      this.audio.get(id)?.update(vehicle);
    }
  }

  /**
   * Reposition render transforms after a floating-origin rebase. Bodies, state
   * and interaction coordinates are canonical, so nothing else moves — this is
   * what makes vehicle world state survive rebasing.
   */
  rebase(origin: WorldPoint): void {
    for (const [id, vehicle] of this.active) {
      const anchor = this.anchors.get(id);
      if (!anchor) continue;
      this.renderPoint.x = vehicle.body.position.x;
      this.renderPoint.y = vehicle.body.position.y;
      this.renderPoint.z = vehicle.body.position.z;
      toRenderPoint(this.renderPoint, origin, anchor.position);
    }
  }

  // ---- Entry and exit ---------------------------------------------------------

  /** Nearest enterable vehicle within reach of a point, or undefined. */
  nearestEnterable(point: WorldPoint, range: number = CONFIG.vehicles.enterRange): Vehicle | undefined {
    let best: Vehicle | undefined;
    let bestDistance = Infinity;
    for (const vehicle of this.active.values()) {
      if (vehicle.freeSeat() === undefined) continue;
      const reach = range + Math.max(vehicle.spec.dimensions.length, vehicle.spec.dimensions.width) * 0.5;
      const distance = Math.hypot(
        vehicle.body.position.x - point.x,
        vehicle.body.position.y - point.y,
        vehicle.body.position.z - point.z,
      );
      if (distance <= reach && distance < bestDistance) {
        best = vehicle;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Seat an actor. Returns the seat id on success. The caller is responsible
   * for hiding the character and handing input over; this owns only vehicle
   * state, so there is no hidden coupling to the character controller.
   */
  enter(vehicleId: string, actorId: string, seatId?: string): string | undefined {
    const vehicle = this.active.get(vehicleId);
    if (!vehicle) return undefined;
    const seat = vehicle.enter(actorId, seatId);
    if (!seat) return undefined;
    vehicle.body.wake();
    if (vehicle.isDriverSeat(seat)) this.drivenId = vehicleId;
    this.markChanged(vehicle);
    this.options.events.emit('vehicle:entered', { id: vehicleId, key: vehicle.spec.key, seat, actor: actorId });
    return seat;
  }

  /**
   * Remove an actor and report where they should be placed. The exit point is
   * terrain-tested by the vehicle, so stepping out on a cliff edge or in deep
   * water puts the player somewhere survivable rather than inside the world.
   */
  exit(vehicleId: string, actorId: string): WorldPoint | undefined {
    const vehicle = this.active.get(vehicleId);
    if (!vehicle) return undefined;
    const seat = vehicle.seatOf(actorId);
    if (!vehicle.exit(actorId, this.environment, this.poseScratch)) return undefined;
    if (this.drivenId === vehicleId && !vehicle.hasDriver) this.drivenId = null;
    this.markChanged(vehicle);
    const point: WorldPoint = { x: this.poseScratch.x, y: this.poseScratch.y, z: this.poseScratch.z };
    this.options.events.emit('vehicle:exited', {
      id: vehicleId, key: vehicle.spec.key, seat: seat ?? '', actor: actorId,
      x: point.x, y: point.y, z: point.z,
    });
    return point;
  }

  /** Flip a stranded or overturned vehicle back onto its wheels in place. */
  recover(vehicleId: string): boolean {
    const vehicle = this.active.get(vehicleId);
    if (!vehicle) return false;
    vehicle.recover(this.environment);
    this.markChanged(vehicle);
    this.options.events.emit('vehicle:recovered', { id: vehicleId, key: vehicle.spec.key });
    return true;
  }

  // ---- Persistence ------------------------------------------------------------

  /**
   * The diff against the deterministic baseline: only vehicles the player has
   * moved, damaged or used. Everything else is regenerated from the seed.
   */
  persistedState(): PersistedVehicles {
    const out: PersistedVehicles = { ...this.persisted };
    for (const vehicle of this.active.values()) {
      if (!this.isChanged(vehicle)) continue;
      out[vehicle.id] = { key: vehicle.spec.key, state: vehicle.serialize() };
    }
    return out;
  }

  private isChanged(vehicle: Vehicle): boolean {
    return vehicle.moved
      || vehicle.health < vehicle.spec.maxHealth
      || vehicle.fuel < vehicle.spec.fuelCapacity
      || vehicle.occupiedSeats > 0;
  }

  private markChanged(vehicle: Vehicle): void {
    this.revision++;
    this.persisted[vehicle.id] = { key: vehicle.spec.key, state: vehicle.serialize() };
  }

  // ---- Streaming --------------------------------------------------------------

  private stream(player: WorldPoint): void {
    const cells = vehicleCellsAround(player.x, player.z, this.loadRadius);
    this.cells = cells.length;
    const wanted: PlacedVehicle[] = [];

    // Planning touches the road field and terrain; build a few cells per tick,
    // nearest first, so a fast vehicle never stalls a frame on world generation.
    let planningBudget = 2;
    for (const cell of cells) {
      const key = vehicleCellKey(cell.cellX, cell.cellZ);
      let planned = this.planned.get(key);
      if (!planned) {
        if (planningBudget <= 0) continue;
        planningBudget--;
        planned = planVehicleCell(cell.cellX, cell.cellZ, this.options);
        // Bounded cache: an infinite world must not grow an infinite plan map.
        if (this.planned.size >= 48) {
          const oldest = this.planned.keys().next();
          if (!oldest.done) this.planned.delete(oldest.value);
        }
        this.planned.set(key, planned);
      }
      for (const entry of planned) wanted.push(entry);
    }

    // Nearest first, so the budget keeps what the player can actually see.
    wanted.sort((a, b) =>
      Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z));
    this.truncated = wanted.length > this.budget;
    const keep = new Set<string>();
    for (const entry of wanted) {
      if (keep.size >= this.budget) break;
      // A vehicle the planner no longer produces but the player has driven
      // here must not be duplicated by its original placement.
      if (this.persisted[entry.id]?.removed) continue;
      keep.add(entry.id);
      if (!this.active.has(entry.id)) this.spawn(entry);
    }
    // Occupied and driven vehicles are never streamed out from under the player.
    for (const [id, vehicle] of this.active) {
      if (keep.has(id) || vehicle.occupiedSeats > 0 || id === this.drivenId) continue;
      this.pendingRemoval.push(id);
    }
  }

  private spawn(entry: PlacedVehicle): void {
    const spec = vehicleSpec(entry.key);
    // A save written by a build with a larger catalogue must not throw.
    if (!spec) return;

    const saved = this.persisted[entry.id];
    const vehicle = new Vehicle(entry.id, spec, { x: entry.x, y: entry.y, z: entry.z }, entry.yaw);
    vehicle.bindEvents({
      onDamage: (target, severity) => {
        this.audio.get(target.id)?.reportImpact(severity / Math.max(1, target.spec.maxHealth) * 4);
        this.options.events.emit('vehicle:damaged', {
          id: target.id, key: target.spec.key, severity,
          health: target.health, wrecked: target.wrecked,
        });
      },
      onStateChanged: () => { this.revision++; },
    });
    if (saved) vehicle.restore(saved.state);

    const anchor = new Group();
    anchor.name = `vehicle/${entry.id}`;
    this.root.add(anchor);

    this.active.set(entry.id, vehicle);
    this.anchors.set(entry.id, anchor);
    this.audio.set(entry.id, new VehicleAudioHooks());
    this.options.interaction.register(vehicle);
    this.options.events.emit('vehicle:spawned', {
      id: entry.id, key: spec.key, vehicleClass: spec.vehicleClass,
    });
  }

  private flushRemovals(): void {
    if (this.pendingRemoval.length === 0) return;
    for (const id of this.pendingRemoval) this.despawn(id);
    this.pendingRemoval.length = 0;
  }

  private despawn(id: string): void {
    const vehicle = this.active.get(id);
    if (!vehicle) return;
    // Capture player-made changes before the instance goes away.
    if (this.isChanged(vehicle)) {
      this.persisted[id] = { key: vehicle.spec.key, state: vehicle.serialize() };
    }
    this.options.interaction.unregister(id);
    const anchor = this.anchors.get(id);
    if (anchor) {
      this.root.remove(anchor);
      this.anchors.delete(id);
    }
    this.active.delete(id);
    this.audio.delete(id);
    if (this.drivenId === id) this.drivenId = null;
    this.options.events.emit('vehicle:despawned', { id });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.active.keys()]) this.despawn(id);
    this.planned.clear();
    this.root.clear();
  }
}
