import { RigidBody } from './rigid-body';
import type { BodyInit, GroundContact } from './rigid-body';
import { physicalMaterial } from './surfaces';
import type { WorldPoint } from '../core/coordinates';

export interface PhysicsStats {
  readonly bodies: number;
  readonly awake: number;
  readonly sleeping: number;
  readonly capacity: number;
  readonly truncated: number;
  readonly substeps: number;
  readonly contacts: number;
}

export interface PropRayHit {
  readonly id: string;
  readonly distance: number;
  readonly point: WorldPoint;
}

/**
 * Central prop physics world.
 *
 * Fixed-step, budgeted, and origin-agnostic: bodies live in canonical world
 * coordinates, so a floating-origin rebase changes only rendering. The public
 * surface (`add`, `remove`, `get`, `step`, `applyImpulse`, `raycast`, `stats`)
 * is the seam where a WASM engine (Rapier) can be swapped in for the Phase 4
 * world physics without gameplay code changing.
 */
export class PropPhysicsWorld {
  readonly backend = 'wayfarer-prop-solver';
  readonly fixedStep: number;
  private capacity: number;
  private readonly bodies = new Map<string, RigidBody>();
  private readonly gravity: number;
  private accumulator = 0;
  private lastSubsteps = 0;
  private lastContacts = 0;
  private truncated = 0;

  constructor(options: { maxBodies: number; gravity?: number; fixedStep?: number }) {
    this.capacity = Math.max(0, Math.floor(options.maxBodies));
    this.gravity = options.gravity ?? 9.81;
    this.fixedStep = options.fixedStep ?? 1 / 120;
  }

  add(init: BodyInit): RigidBody | undefined {
    if (this.bodies.has(init.id)) return this.bodies.get(init.id);
    if (this.bodies.size >= this.capacity) { this.truncated++; return undefined; }
    const body = new RigidBody(init);
    this.bodies.set(body.id, body);
    return body;
  }

  /** Preset changes adjust the ceiling; existing bodies are never silently dropped. */
  setCapacity(maxBodies: number): void { this.capacity = Math.max(0, Math.floor(maxBodies)); }
  get maxBodies(): number { return this.capacity; }

  remove(id: string): boolean { return this.bodies.delete(id); }
  get(id: string): RigidBody | undefined { return this.bodies.get(id); }
  has(id: string): boolean { return this.bodies.has(id); }
  get size(): number { return this.bodies.size; }
  values(): IterableIterator<RigidBody> { return this.bodies.values(); }
  clear(): void { this.bodies.clear(); this.accumulator = 0; this.truncated = 0; this.lastContacts = 0; }

  /**
   * Consume a variable frame delta but always simulate in fixed substeps.
   * `ground` must return a normalized upward contact for canonical XZ.
   */
  step(dt: number, ground: (x: number, z: number, out: GroundContact) => GroundContact): void {
    if (this.bodies.size === 0) return;
    this.accumulator = Math.min(this.accumulator + dt, this.fixedStep * 8);
    this.lastSubsteps = 0;
    while (this.accumulator >= this.fixedStep) {
      this.substep(ground);
      this.accumulator -= this.fixedStep;
      this.lastSubsteps++;
      if (this.lastSubsteps >= 8) { this.accumulator = 0; break; }
    }
  }

  private substep(ground: (x: number, z: number, out: GroundContact) => GroundContact): void {
    for (const body of this.bodies.values()) body.step(this.fixedStep, this.gravity, ground);
    this.lastContacts = this.resolveBodyContacts();
  }

  /**
   * Body-body contacts. Only awake bodies initiate pairs, so a settled scene is
   * free. Contact count is bounded by the body budget.
   */
  private resolveBodyContacts(): number {
    let contacts = 0;
    for (const body of this.bodies.values()) {
      if (body.sleeping) continue;
      for (const other of this.bodies.values()) {
        if (other === body) continue;
        const dx = other.position.x - body.position.x;
        const dy = other.position.y - body.position.y;
        const dz = other.position.z - body.position.z;
        const minDistance = body.shape.boundingRadius + other.shape.boundingRadius;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq >= minDistance * minDistance || distanceSq < 1e-6) continue;
        contacts++;
        this.resolvePair(body, other, dx, dy, dz, Math.sqrt(distanceSq), minDistance);
      }
    }
    return Math.ceil(contacts / 2);
  }

  private resolvePair(a: RigidBody, b: RigidBody, dx: number, dy: number, dz: number, distance: number, minDistance: number): void {
    const nx = dx / distance, ny = dy / distance, nz = dz / distance;
    const penetration = minDistance - distance;
    const totalInverseMass = a.inverseMass + b.inverseMass;
    if (totalInverseMass <= 0) return;
    const correction = penetration / totalInverseMass;
    a.position.x -= nx * correction * a.inverseMass;
    a.position.y -= ny * correction * a.inverseMass;
    a.position.z -= nz * correction * a.inverseMass;
    b.position.x += nx * correction * b.inverseMass;
    b.position.y += ny * correction * b.inverseMass;
    b.position.z += nz * correction * b.inverseMass;

    const rvx = b.velocity.x - a.velocity.x;
    const rvy = b.velocity.y - a.velocity.y;
    const rvz = b.velocity.z - a.velocity.z;
    const normalVelocity = rvx * nx + rvy * ny + rvz * nz;
    if (normalVelocity > 0) return;

    const restitution = Math.max(physicalMaterial(a.material).restitution, physicalMaterial(b.material).restitution) * 0.5;
    const impulse = -(1 + restitution) * normalVelocity / totalInverseMass;
    a.velocity.x -= nx * impulse * a.inverseMass;
    a.velocity.y -= ny * impulse * a.inverseMass;
    a.velocity.z -= nz * impulse * a.inverseMass;
    b.velocity.x += nx * impulse * b.inverseMass;
    b.velocity.y += ny * impulse * b.inverseMass;
    b.velocity.z += nz * impulse * b.inverseMass;

    // Tangential friction between the two props.
    const tx = rvx - nx * normalVelocity, ty = rvy - ny * normalVelocity, tz = rvz - nz * normalVelocity;
    const tangentLength = Math.hypot(tx, ty, tz);
    if (tangentLength > 1e-4) {
      const friction = Math.sqrt(physicalMaterial(a.material).friction * physicalMaterial(b.material).friction);
      const tangentialImpulse = Math.min(friction * impulse, tangentLength / totalInverseMass) / totalInverseMass;
      a.velocity.x += (tx / tangentLength) * tangentialImpulse * a.inverseMass;
      a.velocity.y += (ty / tangentLength) * tangentialImpulse * a.inverseMass;
      a.velocity.z += (tz / tangentLength) * tangentialImpulse * a.inverseMass;
      b.velocity.x -= (tx / tangentLength) * tangentialImpulse * b.inverseMass;
      b.velocity.y -= (ty / tangentLength) * tangentialImpulse * b.inverseMass;
      b.velocity.z -= (tz / tangentLength) * tangentialImpulse * b.inverseMass;
    }
    a.wake(); b.wake();
  }

  applyImpulse(id: string, impulse: WorldPoint): boolean {
    const body = this.bodies.get(id);
    if (!body) return false;
    body.applyImpulse(impulse);
    return true;
  }

  /** Radial push used by the character controller (Phase 5) and vehicle impacts. */
  push(center: WorldPoint, radius: number, impulse: WorldPoint): number {
    let moved = 0;
    for (const body of this.bodies.values()) {
      const dx = body.position.x - center.x, dy = body.position.y - center.y, dz = body.position.z - center.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      body.applyImpulse({ x: impulse.x * falloff, y: impulse.y * falloff, z: impulse.z * falloff });
      moved++;
    }
    return moved;
  }

  /** Ray vs bounding sphere; nearest hit first. Used for surface probes and debug. */
  raycast(origin: WorldPoint, direction: WorldPoint, maxDistance: number): PropRayHit | undefined {
    let best: PropRayHit | undefined;
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const dx = direction.x / length, dy = direction.y / length, dz = direction.z / length;
    for (const body of this.bodies.values()) {
      const ox = body.position.x - origin.x, oy = body.position.y - origin.y, oz = body.position.z - origin.z;
      const projection = ox * dx + oy * dy + oz * dz;
      if (projection < 0) continue;
      const closestSq = ox * ox + oy * oy + oz * oz - projection * projection;
      const radiusSq = body.shape.boundingRadius ** 2;
      if (closestSq > radiusSq) continue;
      const distance = projection - Math.sqrt(radiusSq - closestSq);
      if (distance < 0 || distance > maxDistance) continue;
      if (!best || distance < best.distance) {
        best = {
          id: body.id,
          distance,
          point: { x: origin.x + dx * distance, y: origin.y + dy * distance, z: origin.z + dz * distance },
        };
      }
    }
    return best;
  }

  /** Report the settled pose of a body, interpolated between physics steps. */
  pose(id: string, alpha: number, position: WorldPoint): { position: WorldPoint; quaternion: { x: number; y: number; z: number; w: number } } | undefined {
    const body = this.bodies.get(id);
    if (!body) return undefined;
    body.renderPosition(alpha, position);
    return { position, quaternion: body.quaternion };
  }

  /** Wake every body inside a radius, e.g. after terrain changes under it. */
  wakeNear(x: number, z: number, radius: number): number {
    let count = 0;
    for (const body of this.bodies.values()) {
      if (Math.hypot(body.position.x - x, body.position.z - z) <= radius) { body.wake(); count++; }
    }
    return count;
  }

  get stats(): PhysicsStats {
    let awake = 0, sleeping = 0;
    for (const body of this.bodies.values()) {
      if (body.sleeping) sleeping++;
      else awake++;
    }
    return {
      bodies: this.bodies.size,
      awake, sleeping,
      capacity: this.capacity,
      truncated: this.truncated,
      substeps: this.lastSubsteps,
      contacts: this.lastContacts,
    };
  }
}
