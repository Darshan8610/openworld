import { Matrix3, Quaternion, Vector3 } from 'three/webgpu';
import type { WorldPoint } from '../core/coordinates';

/**
 * Six-degree-of-freedom rigid body for vehicles.
 *
 * Why a dedicated integrator rather than the Rapier world or `PropPhysicsWorld`:
 *
 * - **Range.** Rapier terrain colliders are streamed only within 430 m of the
 *   player and capped at 12 heightfield tiles. An aircraft at 90 m/s leaves that
 *   shell in five seconds. This body raycasts the analytic `WorldQueries` field,
 *   which is valid everywhere and costs no streaming budget.
 * - **Availability.** Rapier is lazily imported WASM and may fail to load; the
 *   established contract is that the world stays playable when it does. Vehicles
 *   are now a primary traversal mode and must not disappear on that path.
 * - **Model fit.** Raycast-suspension cars, aerodynamic aircraft and buoyant
 *   hulls are force models over a rigid body, not contact-solver problems. They
 *   need `applyForceAtPoint` and an inertia tensor, which is exactly this class.
 *
 * Positions are canonical world doubles, so a floating-origin rebase never
 * touches momentum, orientation or sleep state — only rendering converts.
 */
export interface BodyInertia {
  /** Principal moments about the body x/y/z axes, kg·m². */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Box inertia for extents (width x, height y, length z) about the centre. */
export function boxInertia(mass: number, width: number, height: number, length: number, scale = 1): BodyInertia {
  const k = (mass / 12) * scale;
  return {
    x: Math.max(1e-3, k * (height * height + length * length)),
    y: Math.max(1e-3, k * (width * width + length * length)),
    z: Math.max(1e-3, k * (width * width + height * height)),
  };
}

const SLEEP_LINEAR = 0.12;
const SLEEP_ANGULAR = 0.08;
const SLEEP_SECONDS = 1.2;

export class VehicleBody {
  /** Canonical world position of the centre of mass. */
  readonly position = new Vector3();
  /** Previous canonical position, for render interpolation. */
  readonly previousPosition = new Vector3();
  readonly orientation = new Quaternion();
  readonly previousOrientation = new Quaternion();
  /** World-frame linear velocity, m/s. */
  readonly velocity = new Vector3();
  /** World-frame angular velocity, rad/s. */
  readonly angularVelocity = new Vector3();

  mass: number;
  inverseMass: number;
  inertia: BodyInertia;

  /** Damping applied every step; separate from aerodynamic/hydrodynamic drag. */
  linearDamping = 0.0;
  angularDamping = 0.02;
  /** Hard clamps keep a bad force spike from launching the body out of the world. */
  maxSpeed = 400;
  maxAngularSpeed = 12;

  sleeping = false;
  sleepTimer = 0;
  /** Bodies far from the player are frozen by the streaming level, not asleep. */
  frozen = false;

  private readonly force = new Vector3();
  private readonly torque = new Vector3();
  private readonly inverseInertiaWorld = new Matrix3();
  private readonly inertiaWorld = new Matrix3();
  private readonly scratchA = new Vector3();
  private readonly scratchB = new Vector3();
  private readonly scratchQ = new Quaternion();
  private readonly basis = new Matrix3();

  constructor(mass: number, inertia: BodyInertia) {
    this.mass = Math.max(1, mass);
    this.inverseMass = 1 / this.mass;
    this.inertia = inertia;
    this.refreshInertia();
  }

  setMass(mass: number, inertia: BodyInertia): void {
    this.mass = Math.max(1, mass);
    this.inverseMass = 1 / this.mass;
    this.inertia = inertia;
    this.refreshInertia();
  }

  /** Teleport without inheriting velocity; used by spawn, reset and recovery. */
  place(x: number, y: number, z: number, yaw = 0): void {
    this.position.set(x, y, z);
    this.previousPosition.copy(this.position);
    this.orientation.setFromAxisAngle(UP, yaw);
    this.previousOrientation.copy(this.orientation);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    this.wake();
  }

  wake(): void { this.sleeping = false; this.sleepTimer = 0; }

  addForce(fx: number, fy: number, fz: number): void {
    this.force.x += fx; this.force.y += fy; this.force.z += fz;
  }

  addTorque(tx: number, ty: number, tz: number): void {
    this.torque.x += tx; this.torque.y += ty; this.torque.z += tz;
  }

  /** World-space force applied at a world-space point; produces torque r × F. */
  addForceAtPoint(force: Vector3, point: Vector3): void {
    this.force.add(force);
    this.scratchA.subVectors(point, this.position).cross(force);
    this.torque.add(this.scratchA);
  }

  /** Instantaneous velocity of a world-space point attached to the body. */
  pointVelocity(point: Vector3, out: Vector3): Vector3 {
    out.subVectors(point, this.position).cross(this.angularVelocity).multiplyScalar(-1);
    return out.add(this.velocity);
  }

  /** Impulse at a point: used for collisions and landing thumps. */
  applyImpulseAtPoint(impulse: Vector3, point: Vector3): void {
    this.velocity.addScaledVector(impulse, this.inverseMass);
    this.scratchA.subVectors(point, this.position).cross(impulse);
    this.scratchB.copy(this.scratchA).applyMatrix3(this.inverseInertiaWorld);
    this.angularVelocity.add(this.scratchB);
    this.wake();
  }

  localDirection(local: WorldPoint, out: Vector3): Vector3 {
    return out.set(local.x, local.y, local.z).applyQuaternion(this.orientation);
  }

  worldDirectionToLocal(world: Vector3, out: Vector3): Vector3 {
    return out.copy(world).applyQuaternion(this.scratchQ.copy(this.orientation).invert());
  }

  localPoint(local: WorldPoint, out: Vector3): Vector3 {
    out.set(local.x, local.y, local.z).applyQuaternion(this.orientation);
    return out.add(this.position);
  }

  forward(out: Vector3): Vector3 { return out.set(0, 0, 1).applyQuaternion(this.orientation); }
  right(out: Vector3): Vector3 { return out.set(1, 0, 0).applyQuaternion(this.orientation); }
  up(out: Vector3): Vector3 { return out.set(0, 1, 0).applyQuaternion(this.orientation); }

  /** Heading in world radians, matching the engine's yaw convention. */
  get yaw(): number {
    const f = this.forward(this.scratchB);
    return Math.atan2(f.x, f.z);
  }

  /** Signed roll about the body forward axis, radians. */
  get roll(): number {
    const right = this.right(this.scratchA);
    const up = this.up(this.scratchB);
    return Math.atan2(right.y, up.y);
  }

  /** Signed pitch of the nose above the horizon, radians. */
  get pitch(): number {
    const f = this.forward(this.scratchA);
    return Math.asin(Math.max(-1, Math.min(1, f.y)));
  }

  clearAccumulators(): void {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /**
   * Semi-implicit Euler with a body-frame inertia tensor. The gyroscopic term
   * −ω × (Iω) is included so long-bodied aircraft precess correctly instead of
   * rotating like a point mass.
   */
  integrate(dt: number): void {
    if (dt <= 0) return;
    this.previousPosition.copy(this.position);
    this.previousOrientation.copy(this.orientation);
    if (this.frozen || this.sleeping) { this.clearAccumulators(); return; }

    this.refreshInertia();

    // Linear.
    this.velocity.addScaledVector(this.force, this.inverseMass * dt);
    if (this.linearDamping > 0) this.velocity.multiplyScalar(Math.max(0, 1 - this.linearDamping * dt));

    // Angular, with the gyroscopic correction.
    this.scratchA.copy(this.angularVelocity).applyMatrix3(this.inertiaWorld);
    this.scratchB.copy(this.angularVelocity).cross(this.scratchA);
    this.scratchA.copy(this.torque).sub(this.scratchB).applyMatrix3(this.inverseInertiaWorld);
    this.angularVelocity.addScaledVector(this.scratchA, dt);
    if (this.angularDamping > 0) this.angularVelocity.multiplyScalar(Math.max(0, 1 - this.angularDamping * dt));

    this.clampMotion();

    // Integrate the orientation: dq = 0.5 · ω ⊗ q.
    this.scratchQ.set(this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z, 0);
    this.scratchQ.multiply(this.orientation);
    this.orientation.x += this.scratchQ.x * 0.5 * dt;
    this.orientation.y += this.scratchQ.y * 0.5 * dt;
    this.orientation.z += this.scratchQ.z * 0.5 * dt;
    this.orientation.w += this.scratchQ.w * 0.5 * dt;
    this.orientation.normalize();

    this.position.addScaledVector(this.velocity, dt);
    this.clearAccumulators();
    this.updateSleep(dt);
  }

  /** Non-finite state would poison every downstream query; recover instead. */
  private clampMotion(): void {
    if (!Number.isFinite(this.velocity.x) || !Number.isFinite(this.velocity.y) || !Number.isFinite(this.velocity.z)) {
      this.velocity.set(0, 0, 0);
    }
    if (!Number.isFinite(this.angularVelocity.x) || !Number.isFinite(this.angularVelocity.y) || !Number.isFinite(this.angularVelocity.z)) {
      this.angularVelocity.set(0, 0, 0);
    }
    const speed = this.velocity.length();
    if (speed > this.maxSpeed) this.velocity.multiplyScalar(this.maxSpeed / speed);
    const spin = this.angularVelocity.length();
    if (spin > this.maxAngularSpeed) this.angularVelocity.multiplyScalar(this.maxAngularSpeed / spin);
  }

  private updateSleep(dt: number): void {
    if (this.velocity.lengthSq() < SLEEP_LINEAR * SLEEP_LINEAR && this.angularVelocity.lengthSq() < SLEEP_ANGULAR * SLEEP_ANGULAR) {
      this.sleepTimer += dt;
      if (this.sleepTimer >= SLEEP_SECONDS) {
        this.sleeping = true;
        this.velocity.set(0, 0, 0);
        this.angularVelocity.set(0, 0, 0);
      }
    } else {
      this.sleepTimer = 0;
    }
  }

  /** I_world = R·I_body·Rᵀ, recomputed once per step. */
  private refreshInertia(): void {
    const q = this.orientation;
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    // Column-major rotation matrix, matching Three.Matrix3.set row order below.
    const m00 = 1 - (yy + zz), m01 = xy - wz, m02 = xz + wy;
    const m10 = xy + wz, m11 = 1 - (xx + zz), m12 = yz - wx;
    const m20 = xz - wy, m21 = yz + wx, m22 = 1 - (xx + yy);
    const ix = this.inertia.x, iy = this.inertia.y, iz = this.inertia.z;
    const jx = 1 / ix, jy = 1 / iy, jz = 1 / iz;
    // R·diag(I)·Rᵀ for a diagonal body tensor.
    this.inertiaWorld.set(
      m00 * ix * m00 + m01 * iy * m01 + m02 * iz * m02,
      m00 * ix * m10 + m01 * iy * m11 + m02 * iz * m12,
      m00 * ix * m20 + m01 * iy * m21 + m02 * iz * m22,
      m10 * ix * m00 + m11 * iy * m01 + m12 * iz * m02,
      m10 * ix * m10 + m11 * iy * m11 + m12 * iz * m12,
      m10 * ix * m20 + m11 * iy * m21 + m12 * iz * m22,
      m20 * ix * m00 + m21 * iy * m01 + m22 * iz * m02,
      m20 * ix * m10 + m21 * iy * m11 + m22 * iz * m12,
      m20 * ix * m20 + m21 * iy * m21 + m22 * iz * m22,
    );
    this.inverseInertiaWorld.set(
      m00 * jx * m00 + m01 * jy * m01 + m02 * jz * m02,
      m00 * jx * m10 + m01 * jy * m11 + m02 * jz * m12,
      m00 * jx * m20 + m01 * jy * m21 + m02 * jz * m22,
      m10 * jx * m00 + m11 * jy * m01 + m12 * jz * m02,
      m10 * jx * m10 + m11 * jy * m11 + m12 * jz * m12,
      m10 * jx * m20 + m11 * jy * m21 + m12 * jz * m22,
      m20 * jx * m00 + m21 * jy * m01 + m22 * jz * m02,
      m20 * jx * m10 + m21 * jy * m11 + m22 * jz * m12,
      m20 * jx * m20 + m21 * jy * m21 + m22 * jz * m22,
    );
    this.basis.identity();
  }

  /** Interpolated render pose between the last two fixed steps. */
  renderPosition(alpha: number, out: Vector3): Vector3 {
    return out.lerpVectors(this.previousPosition, this.position, alpha);
  }

  renderOrientation(alpha: number, out: Quaternion): Quaternion {
    return out.copy(this.previousOrientation).slerp(this.orientation, alpha);
  }
}

const UP = new Vector3(0, 1, 0);
