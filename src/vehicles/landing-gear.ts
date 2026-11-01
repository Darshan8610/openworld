import { Vector3 } from 'three/webgpu';
import { clamp } from '../utils/math';
import { solveTyre, blankTyreForces } from './tyre';
import type { VehicleBody } from './vehicle-body';
import type { VehicleEnvironment, VehicleGroundSample, WheelSpec } from './types';
import type { WheelView } from './controllers/controller';

/**
 * Undercarriage for aircraft and rotorcraft.
 *
 * Deliberately simpler than the road-vehicle solver — no differential, no
 * anti-roll bar, no engine torque — but it shares the same tyre model, so a
 * nosewheel skidding on wet asphalt behaves like a car tyre on wet asphalt.
 * Helicopter skids are modelled as very stiff, undriven, unsteered gear.
 */
interface Gear extends WheelView {
  readonly spec: WheelSpec;
  compression: number;
  readonly inertia: number;
  readonly contact: Vector3;
  readonly normal: Vector3;
}

export class LandingGear {
  readonly gears: Gear[] = [];
  /** True while any leg carries load. */
  grounded = false;
  /** Fraction of legs in contact, 0..1. */
  contactFraction = 0;
  /** Peak compression rate seen this step — used for landing-impact events. */
  impactSpeed = 0;

  private readonly attach = new Vector3();
  private readonly down = new Vector3();
  private readonly centre = new Vector3();
  private readonly forward = new Vector3();
  private readonly up = new Vector3();
  private readonly velocity = new Vector3();
  private readonly force = new Vector3();
  private readonly tmp = new Vector3();
  private readonly ground: VehicleGroundSample = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' };

  constructor(specs: readonly WheelSpec[], mass: number) {
    for (const spec of specs) {
      const wheelMass = Math.max(4, mass * 0.012);
      this.gears.push({
        id: spec.id, spec, suspensionLength: spec.restLength, steer: 0, spin: 0, omega: 0,
        grounded: false, load: 0, slip: 0, compression: 0,
        inertia: 0.5 * wheelMass * spec.radius * spec.radius,
        contact: new Vector3(), normal: new Vector3(0, 1, 0),
      });
    }
  }

  reset(): void {
    this.grounded = false;
    this.contactFraction = 0;
    for (const gear of this.gears) {
      gear.omega = 0; gear.spin = 0; gear.compression = 0; gear.load = 0;
      gear.grounded = false; gear.slip = 0; gear.suspensionLength = gear.spec.restLength;
    }
  }

  /**
   * Solve every leg. `steer` is the nosewheel angle, `brake` 0..1, `extended`
   * false while the gear is retracted (legs are then ignored entirely).
   */
  step(dt: number, body: VehicleBody, env: VehicleEnvironment, options: { steer: number; brake: number; extended: boolean; brakeTorque: number }): void {
    this.impactSpeed = 0;
    if (!options.extended || this.gears.length === 0) {
      this.grounded = false;
      this.contactFraction = 0;
      for (const gear of this.gears) { gear.grounded = false; gear.load = 0; }
      return;
    }
    body.forward(this.forward);
    body.up(this.up);
    this.down.copy(this.up).multiplyScalar(-1);

    let contacts = 0;
    for (const gear of this.gears) {
      const s = gear.spec;
      gear.steer = s.steered ? options.steer : 0;
      body.localPoint(s.local, this.attach);
      const maxLength = s.restLength + s.maxTravel;
      const hit = this.cast(this.attach, env, maxLength + s.radius);
      gear.normal.set(this.ground.nx, this.ground.ny, this.ground.nz);

      const axisDot = Math.max(0.25, -this.down.dot(gear.normal));
      const centreDistance = hit - s.radius / axisDot;
      if (!Number.isFinite(centreDistance) || centreDistance > maxLength) {
        gear.grounded = false; gear.load = 0; gear.compression = 0; gear.slip = 0;
        gear.suspensionLength = maxLength;
        gear.omega *= Math.max(0, 1 - 0.4 * dt);
        continue;
      }
      contacts++;
      const length = clamp(centreDistance, 0, maxLength);
      gear.suspensionLength = length;
      gear.grounded = true;
      gear.compression = Math.max(0, s.restLength - length);

      this.centre.copy(this.attach).addScaledVector(this.down, length);
      gear.contact.copy(this.centre).addScaledVector(gear.normal, -s.radius);
      body.pointVelocity(this.centre, this.velocity);
      // Positive while the leg is compressing.
      const rate = this.velocity.dot(this.down);
      this.impactSpeed = Math.max(this.impactSpeed, rate);

      const load = Math.max(0, s.stiffness * gear.compression + s.damping * rate);
      gear.load = load;
      this.force.copy(gear.normal).multiplyScalar(load);
      body.addForceAtPoint(this.force, gear.contact);

      // Wheel plane on the contact plane.
      this.tmp.copy(this.forward).applyAxisAngle(this.up, gear.steer);
      this.tmp.addScaledVector(gear.normal, -this.tmp.dot(gear.normal));
      if (this.tmp.lengthSq() < 1e-6) continue;
      this.tmp.normalize();
      const wheelForward = this.tmp;
      const wheelRight = this.force.copy(gear.normal).cross(wheelForward).normalize();

      body.pointVelocity(gear.contact, this.velocity);
      const longitudinalSpeed = this.velocity.dot(wheelForward);
      const lateralSpeed = this.velocity.dot(wheelRight);

      // Free-rolling: the wheel spins up to match the ground unless braked.
      const brakeTorque = options.brakeTorque * clamp(options.brake, 0, 1) * s.brakeShare;
      const targetOmega = longitudinalSpeed / Math.max(0.05, s.radius);
      gear.omega += (targetOmega - gear.omega) * Math.min(1, 22 * dt);
      if (brakeTorque > 0) {
        const delta = (brakeTorque / gear.inertia) * dt;
        if (Math.abs(gear.omega) <= delta) gear.omega = 0;
        else gear.omega -= Math.sign(gear.omega) * delta;
      }
      gear.spin += gear.omega * dt;

      const forces = solveTyre({
        load, longitudinalSpeed, lateralSpeed,
        rimSpeed: gear.omega * s.radius,
        surface: this.ground.surface,
        gripLong: s.gripLong, gripLat: s.gripLat,
      }, blankTyreForces());
      gear.slip = forces.saturation;

      const rolling = -Math.sign(longitudinalSpeed) * s.rollingResistance * load;
      this.tmp.copy(wheelForward).multiplyScalar(forces.longitudinal + rolling).addScaledVector(wheelRight, forces.lateral);
      body.addForceAtPoint(this.tmp, gear.contact);
    }
    this.contactFraction = this.gears.length > 0 ? contacts / this.gears.length : 0;
    this.grounded = contacts > 0;
  }

  private cast(origin: Vector3, env: VehicleEnvironment, maxDistance: number): number {
    let t = maxDistance * 0.5;
    for (let i = 0; i < 3; i++) {
      env.ground(origin.x + this.down.x * t, origin.z + this.down.z * t, this.ground);
      if (Math.abs(this.down.y) < 1e-3) return Infinity;
      const next = (this.ground.height - origin.y) / this.down.y;
      if (!Number.isFinite(next)) return Infinity;
      t = clamp(next, 0, maxDistance);
    }
    env.ground(origin.x + this.down.x * t, origin.z + this.down.z * t, this.ground);
    return t <= maxDistance - 0.02 ? t : Infinity;
  }

  /** Last sampled surface under the gear, for audio and particle hooks. */
  get surface(): VehicleGroundSample['surface'] { return this.ground.surface; }
}
