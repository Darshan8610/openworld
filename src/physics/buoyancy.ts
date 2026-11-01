import { Vector3 } from 'three/webgpu';
import { CONFIG } from '../config';
import { physicalMaterial } from './materials';
import type { PhysicsBody, PhysicsWorld } from './physics-world';
import type { RigidBody } from './rigid-body';
import type { WaterField } from '../world/water-field';

/**
 * Buoyancy, drag and currents — one implementation, shared by both physics paths.
 *
 * Wayfarer has two rigid-body paths by design (Phase 4's Rapier world for terrain,
 * large bodies and later vehicles; Phase 6's fixed-step prop solver for
 * interactive objects). Water must not be implemented twice, so this solver owns
 * the water forces and both worlds feed it their bodies.
 *
 * The model is deliberately an approximation, documented rather than hidden:
 *  - the body is treated as a box/sphere of known volume, and the submerged
 *    fraction comes from the analytic water surface (waves included);
 *  - buoyant force = ρ_water · g · V · f, opposing gravity, so a body whose
 *    material is denser than water still sinks — just slowly;
 *  - drag is quadratic in velocity and scaled by the submerged fraction;
 *  - surface currents push the submerged volume;
 *  - a small righting offset on the centre of buoyancy gives roll stability,
 *    which is what makes a crate settle flat instead of balancing on a corner.
 *
 * Not modelled: displacement flow, wave-making resistance, hull planing and
 * multi-point sampling for arbitrarily shaped hulls. Phase 10 watercraft add
 * multi-point buoyancy at the hull level on top of this solver.
 */

export interface BuoyancyStats {
  /** Bodies currently intersecting a water body. */
  bodiesInWater: number;
  /** Bodies with a non-zero submerged fraction (warm bodies). */
  floating: number;
  lastMs: number;
  capped: boolean;
}

const GRAVITY = Math.abs(CONFIG.physics.gravity);
const WATER_DENSITY = CONFIG.water.buoyancy.density;
const DRAG = CONFIG.water.buoyancy.drag;
const ANGULAR_DRAG = CONFIG.water.buoyancy.angularDrag;

/** A body entering the water this step: enough for a splash and a sound cue. */
export interface WaterEntry {
  id: string;
  /** Canonical position of the entry point, just below the surface. */
  x: number;
  y: number;
  z: number;
  /** Impact speed, metres per second — scales the splash. */
  speed: number;
  bodyId: string;
}

export class BuoyancySolver {
  /**
   * Called for each body that crosses the waterline. The game turns this into a
   * splash; nothing in the solver touches rendering, so it stays testable.
   */
  onEntry?: (entry: WaterEntry) => void;
  /** Bodies currently wet, so entry is reported once per crossing. */
  private readonly wetIds = new Set<string>();
  private inWater = 0;
  private floating = 0;
  private lastMs = 0;
  private capped = false;
  private readonly canonical = new Vector3();

  constructor(private readonly water: WaterField) {}

  get stats(): BuoyancyStats {
    return { bodiesInWater: this.inWater, floating: this.floating, lastMs: this.lastMs, capped: this.capped };
  }

  /** Displaced-volume fraction of a vertically symmetric body. */
  private submergedFraction(centreY: number, halfHeight: number, surfaceY: number): number {
    if (halfHeight <= 0) return 0;
    const bottom = centreY - halfHeight;
    const submerged = surfaceY - bottom;
    if (submerged <= 0) return 0;
    return Math.min(1, submerged / (halfHeight * 2));
  }

  /**
   * Water forces for one prop body. `PropPhysicsWorld.forceField` calls this from
   * inside its fixed substep loop, so the impulses integrate on the same clock as
   * gravity and contacts.
   */
  applyToPropBody(body: RigidBody, dt: number, time: number): void {
    const sample = this.water.sampleAt(body.position.x, body.position.z);
    if (!sample) return;
    const surface = sample.surfaceY + this.water.waveOffset(
      body.position.x, body.position.z, time, sample.waveAmplitude, sample.depth,
    );
    const halfHeight = body.shape.kind === 'sphere' ? body.shape.halfX : body.supportHeight();
    const fraction = this.submergedFraction(body.position.y, halfHeight, surface);
    if (fraction <= 0) {
      this.wetIds.delete(body.id);
      return;
    }
    if (!this.wetIds.has(body.id)) {
      this.wetIds.add(body.id);
      this.onEntry?.({
        id: body.id, x: body.position.x, y: surface, z: body.position.z,
        speed: Math.abs(body.velocity.y), bodyId: sample.bodyId,
      });
    }
    this.inWater++;
    this.floating++;

    const volume = body.shape.kind === 'sphere'
      ? (4 / 3) * Math.PI * body.shape.halfX ** 3
      : 8 * body.shape.halfX * body.shape.halfY * body.shape.halfZ;
    const area = Math.max(0.02, body.shape.boundingRadius * body.shape.boundingRadius * Math.PI);

    // Buoyant force as an acceleration, which avoids mass unit conversions twice.
    const buoyancy = GRAVITY * (WATER_DENSITY / Math.max(1, body.mass / Math.max(1e-4, volume))) * fraction;
    body.velocity.y += buoyancy * dt;

    // Quadratic hydrodynamic drag, scaled by how much of the body is submerged.
    const speed = body.speed;
    if (speed > 0.001) {
      const k = 0.5 * WATER_DENSITY * DRAG / 1000 * area * fraction / Math.max(0.05, body.mass);
      const scale = 1 / (1 + k * speed * dt);
      body.velocity.x *= scale;
      body.velocity.y *= scale;
      body.velocity.z *= scale;
    }
    const spinScale = Math.exp(-ANGULAR_DRAG * fraction * dt);
    body.spin.x *= spinScale;
    body.spin.y *= spinScale;
    body.spin.z *= spinScale;

    // Surface current: rivers carry floating bodies downstream.
    if (sample.flowX !== 0 || sample.flowZ !== 0) {
      body.velocity.x += sample.flowX * fraction * dt * 1.6;
      body.velocity.z += sample.flowZ * fraction * dt * 1.6;
    }
    if (fraction < 1) body.wake();
  }

  /**
   * Apply water forces to dynamic Rapier bodies. Called before each `world.step()`
   * so Rapier integrates the force on its own fixed timestep.
   */
  applyToRapier(physics: PhysicsWorld, dt: number, time: number): void {
    const started = now();
    this.inWater = 0;
    this.floating = 0;
    this.capped = false;
    let processed = 0;
    const position = { x: 0, y: 0, z: 0 };
    for (const record of physics.entries()) {
      if (record.kind !== 'dynamic') continue;
      if (processed >= CONFIG.water.buoyancy.maxBodies) { this.capped = true; break; }
      processed++;
      const body = record.body;
      if (!body.isDynamic() || body.isSleeping()) continue;
      const local = body.translation();
      position.x = local.x; position.y = local.y; position.z = local.z;
      const canonical = physics.worldFromLocal(position, this.canonical);
      const sample = this.water.sampleAt(canonical.x, canonical.z);
      if (!sample) continue;
      const surface = sample.surfaceY + this.water.waveOffset(
        canonical.x, canonical.z, time, sample.waveAmplitude, sample.depth,
      );
      const volume = record.volume ?? 0;
      if (volume <= 0) continue;
      const halfHeight = Math.cbrt(volume) * 0.5;
      const fraction = this.submergedFraction(canonical.y, halfHeight, surface);
      if (fraction <= 0) continue;
      this.inWater++;
      this.floating++;

      const mass = Math.max(0.05, body.mass());
      const density = mass / volume;
      const buoyantForce = GRAVITY * (WATER_DENSITY / Math.max(1, density)) * fraction;
      const linear = body.linvel();
      const area = Math.cbrt(volume) ** 2;
      const dragCoefficient = 0.5 * WATER_DENSITY * DRAG / 1000 * area * fraction;
      // Rapier accumulates `addForce` across steps until it is reset, so water
      // forces are applied as a per-step *impulse* (force × dt) instead: exactly
      // equivalent for this solver, and impossible to leak into the next step.
      // The application point sits below the centre of mass, which gives the
      // righting moment that levels a floating box out.
      body.applyImpulseAtPoint(
        {
          x: (sample.flowX * fraction * mass * 0.4 - linear.x * dragCoefficient * Math.abs(linear.x)) * dt,
          y: (buoyantForce * mass - linear.y * dragCoefficient * Math.abs(linear.y)) * dt,
          z: (sample.flowZ * fraction * mass * 0.4 - linear.z * dragCoefficient * Math.abs(linear.z)) * dt,
        },
        { x: local.x, y: local.y - halfHeight * 0.35, z: local.z },
        true,
      );
    }
    this.lastMs = now() - started;
  }
}

/** Volume of a primitive collider shape, or 0 when it cannot be derived. */
export function shapeVolume(shape: { readonly type: string; readonly halfExtents?: { x: number; y: number; z: number }; readonly radius?: number; readonly halfHeight?: number }): number {
  switch (shape.type) {
    case 'box': {
      const e = shape.halfExtents;
      if (!e) return 0;
      return 8 * Math.abs(e.x * e.y * e.z);
    }
    case 'ball':
      return shape.radius ? (4 / 3) * Math.PI * shape.radius ** 3 : 0;
    case 'capsule': {
      const r = shape.radius ?? 0, h = shape.halfHeight ?? 0;
      return Math.PI * r * r * (2 * h) + (4 / 3) * Math.PI * r ** 3;
    }
    default:
      return 0;
  }
}

/** Approximate fluid density of a material id for gameplay comparisons. */
export function materialIsBuoyant(materialId: 'wood' | 'metal' | 'ice' | 'concrete'): boolean {
  return physicalMaterial(materialId).density < WATER_DENSITY;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export type { PhysicsBody };
