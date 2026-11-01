import { Quaternion, Vector3 } from 'three/webgpu';
import { clamp } from '../utils/math';
import type { WorldPoint } from '../core/coordinates';
import type { PersistencePolicy } from '../core/entities';
import type { InteractionAction, InteractionArchetype, InteractionProvider } from '../interaction/types';
import type { ObjectState } from '../objects/archetypes';
import { createController } from './controller-factory';
import type { VehicleController } from './controllers/controller';
import { boxInertia, VehicleBody } from './vehicle-body';
import { blankTelemetry, neutralControls } from './types';
import type {
  SeatSpec, VehicleControlInput, VehicleEnvironment, VehicleSpec, VehicleTelemetry,
} from './types';

/** Any control the player is actively holding; used to wake a sleeping body. */
function hasControlDemand(input: VehicleControlInput): boolean {
  return input.throttle > 0.01 || input.brake > 0.01 || input.handbrake > 0.01
    || Math.abs(input.steer) > 0.01 || Math.abs(input.pitch) > 0.01
    || Math.abs(input.roll) > 0.01 || Math.abs(input.yaw) > 0.01
    || input.collective > 0.01 || Math.abs(input.ballast) > 0.01;
}

/** Who is in a seat. `null` means empty. */
export interface SeatOccupancy {
  readonly seat: SeatSpec;
  occupantId: string | null;
}

/** Serialisable vehicle state: exactly what persistence stores. */
export interface VehicleSaveState {
  /** Canonical world position. */
  x: number;
  y: number;
  z: number;
  /** Orientation quaternion. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  health: number;
  fuel: number;
  /** Metres travelled. */
  odometer: number;
  /** Player-moved vehicles are restored at their stored pose. */
  moved: boolean;
}

export type VehicleDamageReason = 'impact' | 'overdepth' | 'rollover';

export interface VehicleEvents {
  onDamage?: (vehicle: Vehicle, amount: number, reason: VehicleDamageReason) => void;
  onEnter?: (vehicle: Vehicle, seatId: string, occupantId: string) => void;
  onExit?: (vehicle: Vehicle, seatId: string, occupantId: string, exitPoint: Vector3) => void;
  onStateChanged?: (vehicle: Vehicle) => void;
}

/**
 * One vehicle: identity, rigid body, specialised controller, seats, condition
 * and persistence — plus the `InteractionProvider` implementation that makes it
 * usable by the Phase 6 interaction system with no special cases.
 *
 * It owns no rendering. The vehicle system builds and positions the visual.
 */
export class Vehicle implements InteractionProvider {
  readonly body: VehicleBody;
  readonly controller: VehicleController;
  readonly telemetry: VehicleTelemetry = blankTelemetry();
  readonly controls: VehicleControlInput = neutralControls();
  readonly seats: SeatOccupancy[];
  readonly centre: WorldPoint = { x: 0, y: 0, z: 0 };

  health: number;
  fuel: number;
  odometer = 0;
  /** True once the player has driven it; persistence then stores its pose. */
  moved = false;
  /** Driven by the streaming level: a frozen vehicle is not simulated. */
  active = true;

  private readonly spawnPosition = new Vector3();
  private spawnYaw = 0;
  private readonly scratch = new Vector3();
  private readonly scratchQuaternion = new Quaternion();
  private readonly previousVelocity = new Vector3();
  private readonly interactionActions: readonly InteractionAction[];
  private events: VehicleEvents = {};
  private removed = false;

  constructor(
    readonly id: string,
    readonly spec: VehicleSpec,
    position: WorldPoint,
    yaw = 0,
  ) {
    const { width, height, length } = spec.dimensions;
    this.body = new VehicleBody(spec.mass, boxInertia(spec.mass, width, height, length, spec.inertiaScale));
    this.body.place(position.x, position.y, position.z, yaw);
    this.spawnPosition.set(position.x, position.y, position.z);
    this.spawnYaw = yaw;
    this.controller = createController(spec);
    this.seats = spec.seats.map((seat) => ({ seat, occupantId: null }));
    this.health = spec.maxHealth;
    this.fuel = spec.fuelCapacity;
    this.interactionActions = this.buildActions();
    this.syncCentre();
  }

  bindEvents(events: VehicleEvents): void { this.events = events; }

  // ---- Interaction provider -------------------------------------------------

  get archetype(): InteractionArchetype { return { key: this.spec.key, label: this.spec.label }; }
  get radius(): number { return Math.max(this.spec.dimensions.length, this.spec.dimensions.width) * 0.5; }
  get range(): number { return 3.6; }
  get targetLabel(): string { return this.spec.label; }
  get persistence(): PersistencePolicy { return 'world'; }

  actions(): readonly InteractionAction[] { return this.interactionActions; }

  state(): ObjectState {
    // Reuses the shared object-state shape so one persistence path covers both.
    return { seated: this.occupiedSeats > 0, used: this.moved, level: Math.round(this.healthFraction * 4) };
  }

  setState(patch: Partial<ObjectState>): void {
    if (typeof patch.used === 'boolean') this.moved = patch.used;
    this.events.onStateChanged?.(this);
  }

  remove(): void { this.removed = true; }
  get isRemoved(): boolean { return this.removed; }

  private buildActions(): readonly InteractionAction[] {
    const driverSeat = this.spec.seats.find((seat) => seat.role === 'driver');
    if (!driverSeat) return [];
    return [{
      id: 'enter',
      label: `Enter ${this.spec.label.toLowerCase()}`,
      key: 'F',
      available: () => this.seatOccupant(driverSeat.id) === null && this.health > 0,
      run: () => ({ message: `Entered the ${this.spec.label.toLowerCase()}` }),
    }];
  }

  // ---- Seats ----------------------------------------------------------------

  get driverSeatId(): string | undefined { return this.spec.seats.find((seat) => seat.role === 'driver')?.id; }
  get occupiedSeats(): number { return this.seats.reduce((count, slot) => count + (slot.occupantId ? 1 : 0), 0); }
  get hasDriver(): boolean {
    const driver = this.driverSeatId;
    return driver !== undefined && this.seatOccupant(driver) !== null;
  }

  seatOccupant(seatId: string): string | null {
    return this.seats.find((slot) => slot.seat.id === seatId)?.occupantId ?? null;
  }

  /** Claim a seat. Returns false when it is taken or does not exist. */
  enter(occupantId: string, seatId?: string): string | undefined {
    const target = seatId
      ? this.seats.find((slot) => slot.seat.id === seatId)
      : this.seats.find((slot) => slot.seat.role === 'driver' && slot.occupantId === null)
        ?? this.seats.find((slot) => slot.occupantId === null);
    if (!target || target.occupantId !== null) return undefined;
    target.occupantId = occupantId;
    this.body.wake();
    this.events.onEnter?.(this, target.seat.id, occupantId);
    this.events.onStateChanged?.(this);
    return target.seat.id;
  }

  /**
   * Release a seat and compute a safe exit point. The nominal exit is tested
   * against the terrain; if it is buried in a slope the opposite side is used,
   * and failing that the occupant is placed on top of the vehicle. An exit must
   * never drop the player inside geometry or under the ground.
   */
  exit(occupantId: string, env: VehicleEnvironment, out: Vector3): boolean {
    const slot = this.seats.find((entry) => entry.occupantId === occupantId);
    if (!slot) return false;
    slot.occupantId = null;
    this.resolveExitPoint(slot.seat, env, out);
    this.events.onExit?.(this, slot.seat.id, occupantId, out);
    this.events.onStateChanged?.(this);
    return true;
  }

  /** Public so the entry flow can preview where the player would be put. */
  resolveExitPoint(seat: SeatSpec, env: VehicleEnvironment, out: Vector3): Vector3 {
    const candidates: WorldPoint[] = [
      seat.exit,
      { x: -seat.exit.x, y: seat.exit.y, z: seat.exit.z },
      { x: seat.exit.x * 1.6, y: seat.exit.y, z: seat.exit.z },
      { x: 0, y: this.spec.dimensions.height * 0.6, z: seat.exit.z },
    ];
    const ground = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' as const };
    for (const candidate of candidates) {
      this.body.localPoint(candidate, out);
      const sample = env.ground(out.x, out.z, ground);
      // Reject anywhere the ground is above the exit (buried in a bank).
      if (out.y >= sample.height - 0.2) {
        out.y = Math.max(out.y, sample.height + 0.05);
        return out;
      }
    }
    // Last resort: directly above the vehicle, which is always clear.
    this.body.localPoint({ x: 0, y: this.spec.dimensions.height, z: 0 }, out);
    const sample = env.ground(out.x, out.z, ground);
    out.y = Math.max(out.y, sample.height + 0.05);
    return out;
  }

  // ---- Simulation -----------------------------------------------------------

  get healthFraction(): number { return clamp(this.health / Math.max(1, this.spec.maxHealth), 0, 1); }
  get fuelFraction(): number {
    return this.spec.fuelCapacity > 0 ? clamp(this.fuel / this.spec.fuelCapacity, 0, 1) : 1;
  }
  get wrecked(): boolean { return this.health <= 0; }

  /** One fixed simulation step. */
  fixedUpdate(dt: number, env: VehicleEnvironment): void {
    if (!this.active || this.removed) return;
    this.previousVelocity.copy(this.body.velocity);

    // A wrecked or dry vehicle still rolls, steers and falls; its engine is
    // simply dead. Cutting ignition rather than the throttle keeps engine
    // braking and the rolling driveline honest.
    const starved = this.spec.fuelCapacity > 0 && this.fuel <= 0;
    const effective = this.controls;
    const ignition = effective.ignition;
    if (starved || this.wrecked) effective.ignition = false;
    const throttle = effective.ignition ? effective.throttle : 0;

    // Parked, undisturbed vehicles sleep to stay off the simulation budget —
    // but any occupant or any live control input must wake them immediately,
    // otherwise a parked car would ignore the throttle.
    if (this.body.sleeping && (this.occupiedSeats > 0 || hasControlDemand(effective))) this.body.wake();
    if (!this.body.sleeping) {
      this.controller.step(dt, this.body, effective, env, this.telemetry);
      this.body.integrate(dt);
    } else {
      this.body.integrate(dt);
    }
    effective.ignition = ignition;

    if (!starved && !this.wrecked && this.spec.fuelCapacity > 0) {
      this.fuel = Math.max(0, this.fuel - this.spec.fuelBurn * throttle * dt * 60);
    }
    const travelled = this.body.position.distanceTo(this.body.previousPosition);
    this.odometer += travelled;
    if (travelled > 0.02 && this.hasDriver) this.moved = true;

    this.detectImpact(dt);
    this.syncCentre();
  }

  /**
   * Turn a sudden velocity change into damage. Using the velocity *delta* means
   * a hard landing and a wall strike are both detected, while normal driving
   * forces never register.
   */
  private detectImpact(dt: number): void {
    if (dt <= 0) return;
    this.scratch.subVectors(this.body.velocity, this.previousVelocity);
    const deceleration = this.scratch.length() / dt;
    // ~8 g: well above cornering and braking, clearly a collision.
    if (deceleration < 78) return;
    const severity = (deceleration - 78) / 120;
    const damage = severity * severity * 42;
    if (damage < 0.4) return;
    this.applyDamage(damage, 'impact');
  }

  applyDamage(amount: number, reason: VehicleDamageReason): void {
    if (amount <= 0 || this.removed) return;
    const before = this.health;
    this.health = Math.max(0, this.health - amount);
    if (this.health !== before) {
      this.events.onDamage?.(this, amount, reason);
      this.events.onStateChanged?.(this);
    }
  }

  repair(): void {
    this.health = this.spec.maxHealth;
    this.fuel = this.spec.fuelCapacity;
    this.events.onStateChanged?.(this);
  }

  /** Put the vehicle back on its wheels at its current XZ. */
  recover(env: VehicleEnvironment): void {
    const ground = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' as const };
    env.ground(this.body.position.x, this.body.position.z, ground);
    const yaw = this.body.yaw;
    this.body.place(
      this.body.position.x,
      ground.height + this.spec.dimensions.height * 0.6,
      this.body.position.z,
      yaw,
    );
    this.controller.reset();
    this.events.onStateChanged?.(this);
  }

  /** Return to the deterministic spawn pose. */
  resetToSpawn(): void {
    this.body.place(this.spawnPosition.x, this.spawnPosition.y, this.spawnPosition.z, this.spawnYaw);
    this.controller.reset();
    this.health = this.spec.maxHealth;
    this.fuel = this.spec.fuelCapacity;
    this.moved = false;
    this.events.onStateChanged?.(this);
  }

  /** Canonical seat position in world space, for the camera and the occupant. */
  seatWorldPosition(seatId: string, out: Vector3): Vector3 | undefined {
    const slot = this.seats.find((entry) => entry.seat.id === seatId);
    if (!slot) return undefined;
    return this.body.localPoint(slot.seat.local, out);
  }

  /** Interpolated render pose; rendering converts to origin-local itself. */
  renderPose(alpha: number, position: Vector3, orientation: Quaternion): void {
    this.body.renderPosition(alpha, position);
    this.body.renderOrientation(alpha, orientation);
  }

  private syncCentre(): void {
    this.centre.x = this.body.position.x;
    this.centre.y = this.body.position.y + this.spec.dimensions.height * 0.25;
    this.centre.z = this.body.position.z;
  }

  // ---- Persistence ----------------------------------------------------------

  serialize(): VehicleSaveState {
    const q = this.body.orientation;
    return {
      x: this.body.position.x, y: this.body.position.y, z: this.body.position.z,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      health: this.health, fuel: this.fuel, odometer: this.odometer, moved: this.moved,
    };
  }

  restore(state: VehicleSaveState): void {
    if (state.moved) {
      this.body.position.set(state.x, state.y, state.z);
      this.body.previousPosition.copy(this.body.position);
      this.scratchQuaternion.set(state.qx, state.qy, state.qz, state.qw);
      if (this.scratchQuaternion.lengthSq() > 1e-6) {
        this.body.orientation.copy(this.scratchQuaternion).normalize();
        this.body.previousOrientation.copy(this.body.orientation);
      }
      this.body.velocity.set(0, 0, 0);
      this.body.angularVelocity.set(0, 0, 0);
    }
    this.health = clamp(state.health, 0, this.spec.maxHealth);
    this.fuel = clamp(state.fuel, 0, this.spec.fuelCapacity);
    this.odometer = Math.max(0, state.odometer);
    this.moved = state.moved;
    this.syncCentre();
  }
}
