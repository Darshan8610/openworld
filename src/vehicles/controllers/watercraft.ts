import { Vector3 } from 'three/webgpu';
import { clamp } from '../../utils/math';
import { BuoyancySolver } from '../buoyancy';
import type { VehicleBody } from '../vehicle-body';
import type {
  VehicleControlInput, VehicleEnvironment, VehicleGroundSample, VehicleSpec, VehicleTelemetry,
} from '../types';
import type { VehicleController, WheelView } from './controller';

const NO_WHEELS: readonly WheelView[] = [];

/**
 * Displacement/planing watercraft.
 *
 * Propulsion, steering and stability all depend on being in the water:
 *
 * - The propeller only produces thrust while it is submerged, so a boat
 *   launched off a wave loses drive until it lands.
 * - The rudder generates yaw from *flow over it*, so steering authority is
 *   proportional to speed — a stationary boat cannot turn on the spot.
 * - Hull drag is strongly anisotropic: a hull slides forward easily and
 *   resists sideways motion, which is what makes it track instead of drift.
 * - A righting moment proportional to heel keeps the hull upright, and is
 *   overcome by a hard enough turn.
 *
 * It also runs aground: the terrain query still applies, so a boat driven into
 * a shoreline stops on the bed instead of sailing through it.
 */
export class WatercraftController implements VehicleController {
  readonly kind: 'watercraft' | 'sailboat' | 'submarine' = 'watercraft';
  readonly wheels = NO_WHEELS;
  readonly surfaceDeflection = { pitch: 0, roll: 0, yaw: 0 };
  protected readonly buoyancy: BuoyancySolver;
  protected propRate = 0;

  protected readonly forward = new Vector3();
  protected readonly right = new Vector3();
  protected readonly up = new Vector3();
  protected readonly force = new Vector3();
  protected readonly point = new Vector3();
  protected readonly tmp = new Vector3();
  protected readonly ground: VehicleGroundSample = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' };

  constructor(protected readonly vehicleSpec: VehicleSpec) {
    if (!vehicleSpec.hull) throw new Error(`Vehicle "${vehicleSpec.key}" is watercraft but has no hull spec`);
    this.buoyancy = new BuoyancySolver(vehicleSpec.hull.points, vehicleSpec.hull.submersionDepth);
  }

  get rotorRate(): number { return this.propRate; }

  reset(): void { this.propRate = 0; }

  step(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, telemetry: VehicleTelemetry): void {
    const hull = this.vehicleSpec.hull!;
    body.forward(this.forward);
    body.right(this.right);
    body.up(this.up);

    body.addForce(0, env.gravity * body.mass, 0);

    const result = this.buoyancy.solve(body, env, {
      heaveDamping: body.mass * 0.42,
      extraForce: this.verticalBias(input, dt),
    });

    const velocity = body.velocity;
    const vForward = velocity.dot(this.forward);
    const vRight = velocity.dot(this.right);
    const vUp = velocity.dot(this.up);
    const speed = velocity.length();

    if (result.inWater) {
      const density = 1000 * result.submersion;
      // Anisotropic quadratic drag in the body frame.
      this.addAxisDrag(body, this.forward, vForward, hull.dragForward, density);
      this.addAxisDrag(body, this.right, vRight, hull.dragLateral, density);
      this.addAxisDrag(body, this.up, vUp, hull.dragVertical, density);

      // Angular drag: water resists rotation far more than air.
      const angular = hull.angularDrag * body.mass * result.submersion;
      body.addTorque(
        -body.angularVelocity.x * angular,
        -body.angularVelocity.y * angular,
        -body.angularVelocity.z * angular,
      );

      this.applyPropulsion(dt, body, input, env, result.submersion);
      this.applyRudder(body, input, vForward, result.submersion);
      this.applyRighting(body, result.submersion);

      // Planing: fast hulls lift out of the water and shed drag.
      if (hull.planing > 0 && vForward > 4) {
        const lift = hull.planing * body.mass * clamp((vForward - 4) / 12, 0, 1);
        this.force.copy(this.up).multiplyScalar(lift);
        body.localPoint({ x: 0, y: 0, z: -this.vehicleSpec.dimensions.length * 0.2 }, this.point);
        body.addForceAtPoint(this.force, this.point);
      }
    } else {
      // Airborne or beached: only gravity and a little air drag.
      if (speed > 0.1) {
        this.tmp.copy(velocity).multiplyScalar(-0.5 * 1.225 * 0.5 * hull.dragForward * speed);
        body.addForce(this.tmp.x, this.tmp.y, this.tmp.z);
      }
    }

    this.resolveSeabed(body, env);
    this.writeTelemetry(body, telemetry, speed, vForward, result.submersion, result.inWater, result.surfaceY);
  }

  /** Extra vertical force; the submarine overrides this for ballast. */
  protected verticalBias(_input: VehicleControlInput, _dt: number): number { return 0; }

  protected addAxisDrag(body: VehicleBody, axis: Vector3, speedAlong: number, area: number, density: number): void {
    if (Math.abs(speedAlong) < 1e-3) return;
    const magnitude = 0.5 * density * area * speedAlong * Math.abs(speedAlong);
    this.tmp.copy(axis).multiplyScalar(-magnitude);
    body.addForce(this.tmp.x, this.tmp.y, this.tmp.z);
  }

  /** Propeller thrust, applied at the propeller and only while it is wet. */
  protected applyPropulsion(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, submersion: number): void {
    const hull = this.vehicleSpec.hull!;
    const demand = input.reverse ? -clamp(input.throttle, 0, 1) * hull.reverseFactor : clamp(input.throttle, 0, 1);
    this.propRate += (Math.abs(demand) - this.propRate) * Math.min(1, 2.4 * dt);

    body.localPoint(hull.propeller, this.point);
    const water = env.water(this.point.x, this.point.z);
    if (!water || water.surfaceY <= this.point.y) return;

    const thrust = hull.maxThrust * demand * Math.min(1, submersion * 1.6);
    if (thrust === 0) return;
    this.force.copy(this.forward).multiplyScalar(thrust);
    body.addForceAtPoint(this.force, this.point);
  }

  /** Rudder torque scales with flow speed: no way on, no steerage. */
  protected applyRudder(body: VehicleBody, input: VehicleControlInput, vForward: number, submersion: number): void {
    const hull = this.vehicleSpec.hull!;
    const steer = clamp(input.steer, -1, 1);
    if (steer === 0) return;
    const flow = Math.abs(vForward);
    const torque = -steer * hull.rudderAuthority * flow * Math.sign(vForward || 1) * submersion;
    body.addTorque(this.up.x * torque, this.up.y * torque, this.up.z * torque);
  }

  /** Hydrostatic righting moment: the hull wants to float upright. */
  protected applyRighting(body: VehicleBody, submersion: number): void {
    const hull = this.vehicleSpec.hull!;
    const heel = body.roll;
    const pitch = body.pitch;
    const rollTorque = -heel * hull.righting * submersion;
    const pitchTorque = -pitch * hull.righting * 1.35 * submersion;
    body.addTorque(this.forward.x * rollTorque, this.forward.y * rollTorque, this.forward.z * rollTorque);
    body.addTorque(this.right.x * pitchTorque, this.right.y * pitchTorque, this.right.z * pitchTorque);
  }

  /** Grounding on the bed or the shore. */
  protected resolveSeabed(body: VehicleBody, env: VehicleEnvironment): void {
    env.ground(body.position.x, body.position.z, this.ground);
    const draft = this.vehicleSpec.dimensions.height * 0.35;
    const penetration = this.ground.height + draft - body.position.y;
    if (penetration <= 0) return;
    body.position.y += penetration;
    if (body.velocity.y < 0) body.velocity.y *= -0.1;
    // Running aground scrubs off way quickly.
    body.velocity.x *= 0.82;
    body.velocity.z *= 0.82;
    body.angularVelocity.multiplyScalar(0.8);
  }

  protected writeTelemetry(
    body: VehicleBody, telemetry: VehicleTelemetry, speed: number, vForward: number,
    submersion: number, inWater: boolean, surfaceY: number,
  ): void {
    telemetry.speed = speed;
    telemetry.forwardSpeed = vForward;
    telemetry.submersion = submersion;
    telemetry.inWater = inWater;
    telemetry.depth = inWater ? Math.max(0, surfaceY - body.position.y) : 0;
    telemetry.verticalSpeed = body.velocity.y;
    telemetry.altitude = body.position.y - this.ground.height;
    telemetry.load = this.propRate;
    telemetry.engineRpm = this.propRate * 3200;
    telemetry.rotorRpm = this.propRate;
    telemetry.surface = 'water';
    telemetry.grounded = 0;
    telemetry.gear = 0;
    telemetry.slip = 0;
    telemetry.stalled = false;
  }
}
