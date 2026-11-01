import { clamp } from '../utils/math';
import { copyPoint } from '../core/coordinates';
import type { WorldPoint } from '../core/coordinates';
import { combineFriction, combineRestitution, physicalMaterial } from './surfaces';
import type { SurfaceKind } from './surfaces';

/**
 * Rigid body for world props (crates, barrels, pickups, debris).
 *
 * Scope: single-body dynamics against the terrain heightfield plus body-body
 * contacts against other props. This is a deliberately small, allocation-free
 * solver in real units — not a replacement for the Phase 4 engine. It exposes
 * the same concepts (mass, impulse, restitution, friction, sleeping, CCD-safe
 * speed clamp) so a Rapier-backed implementation can take over behind
 * `PropPhysicsWorld`'s interface without touching gameplay.
 *
 * Canonical positions are absolute world metres in doubles, so rebasing the
 * floating origin never touches momentum or velocity.
 */
export interface GroundContact {
  height: number;
  /** Upward ground normal (normalized). */
  nx: number;
  ny: number;
  nz: number;
  surface: SurfaceKind;
}

export interface BodyShape {
  readonly kind: 'sphere' | 'box';
  /** Half extents; for a sphere all three equal the radius. */
  readonly halfX: number;
  readonly halfY: number;
  readonly halfZ: number;
  /** Bounding radius for broadphase and ray tests. */
  readonly boundingRadius: number;
}

export const sphereShape = (radius: number): BodyShape => ({ kind: 'sphere', halfX: radius, halfY: radius, halfZ: radius, boundingRadius: radius });
export const boxShape = (halfX: number, halfY: number, halfZ: number): BodyShape => ({
  kind: 'box', halfX, halfY, halfZ, boundingRadius: Math.hypot(halfX, halfY, halfZ),
});

export interface BodyInit {
  readonly id: string;
  readonly position: WorldPoint;
  readonly shape: BodyShape;
  readonly material: SurfaceKind;
  /** Explicit mass in kg; otherwise derived from volume × density. */
  readonly mass?: number;
  readonly velocity?: WorldPoint;
  readonly spin?: WorldPoint;
  /** Free-form owner tag, e.g. the object id that drives this body. */
  readonly tag?: string;
  /** Rotational yaw at spawn. */
  readonly yaw?: number;
}

export interface Quaternion { x: number; y: number; z: number; w: number }

const AIR_DAMPING = 0.06;
const BOUNCE_THRESHOLD = 1.1;
const SLEEP_LINEAR = 0.16;
const SLEEP_ANGULAR = 0.5;
const SLEEP_SECONDS = 0.55;
const MAX_SPEED = 70;

export class RigidBody {
  readonly id: string;
  readonly shape: BodyShape;
  readonly material: SurfaceKind;
  readonly tag: string;
  readonly position: WorldPoint;
  readonly previous: WorldPoint;
  readonly velocity: WorldPoint;
  readonly spin: WorldPoint;
  readonly quaternion: Quaternion;
  readonly previousQuaternion: Quaternion;
  readonly mass: number;
  readonly inverseMass: number;
  /** Approximate inertia (uniform solid) in kg·m². */
  readonly inertia: number;
  readonly inverseInertia: number;

  grounded = false;
  sleeping = false;
  sleepTimer = 0;
  private groundContact: GroundContact | undefined;

  constructor(init: BodyInit) {
    this.id = init.id;
    this.shape = init.shape;
    this.material = init.material;
    this.tag = init.tag ?? init.id;
    this.position = copyPoint(init.position, { x: 0, y: 0, z: 0 });
    this.previous = copyPoint(init.position, { x: 0, y: 0, z: 0 });
    this.velocity = { x: 0, y: 0, z: 0 };
    if (init.velocity) copyPoint(init.velocity, this.velocity);
    this.spin = { x: 0, y: 0, z: 0 };
    if (init.spin) copyPoint(init.spin, this.spin);
    this.quaternion = yawQuaternion(init.yaw ?? 0);
    this.previousQuaternion = { ...this.quaternion };

    const material = physicalMaterial(init.material);
    const volume = this.shape.kind === 'sphere'
      ? (4 / 3) * Math.PI * this.shape.halfX ** 3
      : 8 * this.shape.halfX * this.shape.halfY * this.shape.halfZ;
    const mass = init.mass ?? Math.max(0.4, volume * material.density);
    this.mass = clamp(mass, 0.05, 5000);
    this.inverseMass = 1 / this.mass;
    const radius = this.shape.boundingRadius;
    this.inertia = Math.max(1e-4, 0.4 * this.mass * radius * radius);
    this.inverseInertia = 1 / this.inertia;
  }

  get speed(): number { return Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z); }
  get spinRate(): number { return Math.hypot(this.spin.x, this.spin.y, this.spin.z); }
  get surface(): SurfaceKind { return this.groundContact?.surface ?? 'grass'; }

  /** Support height along world Y for the current orientation (exact for boxes). */
  supportHeight(): number {
    if (this.shape.kind === 'sphere') return this.shape.halfX;
    const { x, y, z, w } = this.quaternion;
    // World-Y row of the rotation matrix.
    const m10 = 2 * (x * y + w * z);
    const m11 = 1 - 2 * (x * x + z * z);
    const m12 = 2 * (y * z - w * x);
    return Math.abs(m10) * this.shape.halfX + Math.abs(m11) * this.shape.halfY + Math.abs(m12) * this.shape.halfZ;
  }

  wake(): void { this.sleeping = false; this.sleepTimer = 0; }

  applyImpulse(impulse: WorldPoint, contactOffset?: WorldPoint): void {
    this.wake();
    this.velocity.x += impulse.x * this.inverseMass;
    this.velocity.y += impulse.y * this.inverseMass;
    this.velocity.z += impulse.z * this.inverseMass;
    if (contactOffset) {
      // ω += r × J · I⁻¹
      const rx = contactOffset.x, ry = contactOffset.y, rz = contactOffset.z;
      this.spin.x += (ry * impulse.z - rz * impulse.y) * this.inverseInertia;
      this.spin.y += (rz * impulse.x - rx * impulse.z) * this.inverseInertia;
      this.spin.z += (rx * impulse.y - ry * impulse.x) * this.inverseInertia;
    }
  }

  /** One fixed physics substep against the heightfield. */
  step(dt: number, gravity: number, ground: (x: number, z: number, out: GroundContact) => GroundContact): void {
    if (this.sleeping) return;
    copyPoint(this.position, this.previous);
    this.previousQuaternion.x = this.quaternion.x;
    this.previousQuaternion.y = this.quaternion.y;
    this.previousQuaternion.z = this.quaternion.z;
    this.previousQuaternion.w = this.quaternion.w;

    this.velocity.y -= gravity * dt;
    const damping = Math.exp(-(physicalMaterial(this.material).linearDamping + AIR_DAMPING) * dt);
    this.velocity.x *= damping;
    this.velocity.z *= damping;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;
    this.integrateSpin(dt);

    const contact = ground(this.position.x, this.position.z, { height: 0, nx: 0, ny: 1, nz: 0, surface: this.material });
    this.groundContact = contact;
    const support = this.supportHeight();
    const floor = contact.height + support;
    this.grounded = false;

    if (this.position.y <= floor) {
      this.position.y = floor;
      const vn = this.velocity.x * contact.nx + this.velocity.y * contact.ny + this.velocity.z * contact.nz;
      const groundMaterial = physicalMaterial(contact.surface);
      const bodyMaterial = physicalMaterial(this.material);
      const restitution = combineRestitution(bodyMaterial, groundMaterial);
      const friction = combineFriction(bodyMaterial, groundMaterial);

      if (vn < -BOUNCE_THRESHOLD) {
        const j = -(1 + restitution) * vn;
        this.velocity.x += contact.nx * j;
        this.velocity.y += contact.ny * j;
        this.velocity.z += contact.nz * j;
        // Impact scrubs horizontal speed too.
        this.velocity.x *= 1 - Math.min(0.6, friction * 0.5);
        this.velocity.z *= 1 - Math.min(0.6, friction * 0.5);
      } else {
        // Resting contact: remove the normal component, keep the tangential part.
        if (vn < 0) {
          this.velocity.x -= contact.nx * vn;
          this.velocity.y -= contact.ny * vn;
          this.velocity.z -= contact.nz * vn;
        }
        this.grounded = true;
      }

      if (this.grounded) {
        // Coulomb friction acts on the tangential velocity.
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        const deceleration = friction * gravity * dt;
        if (speed > 1e-4) {
          const scale = Math.max(0, speed - deceleration) / speed;
          this.velocity.x *= scale;
          this.velocity.z *= scale;
        }
        // Ground contact damps rotation; loose surfaces do it faster.
        const spinDamping = Math.exp(-(1.5 + friction * 6) * dt);
        this.spin.x *= spinDamping; this.spin.y *= spinDamping; this.spin.z *= spinDamping;
        this.applyRolling(contact, friction);
      }
    }

    const speed = this.speed;
    if (speed > MAX_SPEED) {
      const scale = MAX_SPEED / speed;
      this.velocity.x *= scale; this.velocity.y *= scale; this.velocity.z *= scale;
    }

    if (this.grounded && this.speed < SLEEP_LINEAR && this.spinRate < SLEEP_ANGULAR) {
      this.sleepTimer += dt;
      if (this.sleepTimer >= SLEEP_SECONDS) this.sleep();
    } else {
      this.sleepTimer = 0;
    }
  }

  private sleep(): void {
    this.sleeping = true;
    this.velocity.x = 0; this.velocity.y = 0; this.velocity.z = 0;
    this.spin.x = 0; this.spin.y = 0; this.spin.z = 0;
    if (this.shape.kind === 'box') {
      // Settle flat if nearly upright, keeping the yaw so props keep their face.
      const upY = 1 - 2 * (this.quaternion.x * this.quaternion.x + this.quaternion.z * this.quaternion.z);
      if (upY > 0.94) {
        const yaw = Math.atan2(2 * (this.quaternion.w * this.quaternion.y + this.quaternion.x * this.quaternion.z), 1 - 2 * (this.quaternion.y ** 2 + this.quaternion.x ** 2));
        Object.assign(this.quaternion, yawQuaternion(yaw));
      }
    }
    if (this.groundContact) this.position.y = this.groundContact.height + this.supportHeight();
  }

  /** Barrels and crates tumble only when they slip; spheres roll with the contact. */
  private applyRolling(contact: GroundContact, friction: number): void {
    if (this.shape.kind !== 'sphere' || friction < 0.35) return;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 0.05) return;
    const radius = this.shape.halfX;
    // ω = (n × v) / r
    // n × v with n ≈ up: (v.z, 0, -v.x) / r
    this.spin.x = (contact.ny * this.velocity.z) / radius;
    this.spin.y = 0;
    this.spin.z = (-contact.ny * this.velocity.x) / radius;
  }

  private integrateSpin(dt: number): void {
    if (this.spinRate < 1e-5) return;
    const { x, y, z, w } = this.quaternion;
    const hx = this.spin.x * dt * 0.5, hy = this.spin.y * dt * 0.5, hz = this.spin.z * dt * 0.5;
    let nx = x + (hx * w + hy * z - hz * y);
    let ny = y + (hy * w + hz * x - hx * z);
    let nz = z + (hz * w + hx * y - hy * x);
    let nw = w - (hx * x + hy * y + hz * z);
    const length = Math.hypot(nx, ny, nz, nw) || 1;
    nx /= length; ny /= length; nz /= length; nw /= length;
    this.quaternion.x = nx; this.quaternion.y = ny; this.quaternion.z = nz; this.quaternion.w = nw;
  }

  /** Interpolated render position (render runs at display rate, physics at 120 Hz). */
  renderPosition(alpha: number, out: WorldPoint): WorldPoint {
    out.x = this.previous.x + (this.position.x - this.previous.x) * alpha;
    out.y = this.previous.y + (this.position.y - this.previous.y) * alpha;
    out.z = this.previous.z + (this.position.z - this.previous.z) * alpha;
    return out;
  }

  /** Spawn-safe rest pose for a fresh object on uneven ground. */
  restOn(contact: GroundContact): void {
    this.position.y = contact.height + this.supportHeight();
    this.grounded = true;
    this.groundContact = contact;
    copyPoint(this.position, this.previous);
  }
}

function yawQuaternion(yaw: number): Quaternion {
  const half = yaw * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}
