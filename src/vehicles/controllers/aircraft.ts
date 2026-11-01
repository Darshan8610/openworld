import { Vector3 } from 'three/webgpu';
import { clamp } from '../../utils/math';
import { LandingGear } from '../landing-gear';
import type { VehicleBody } from '../vehicle-body';
import type {
  VehicleControlInput, VehicleEnvironment, VehicleGroundSample, VehicleSpec, VehicleTelemetry,
} from '../types';
import type { VehicleController, WheelView } from './controller';
import { airDensityAt } from './controller';

/**
 * Fixed-wing aerodynamics.
 *
 * Forces come from the relative wind in the body frame, not from the control
 * stick: lift and drag are functions of angle of attack and dynamic pressure,
 * and the control surfaces produce moments scaled by that same dynamic
 * pressure. Two consequences fall out for free and are the reason to model it
 * this way rather than steering a mesh:
 *
 * - Controls go soft as the aircraft slows, and dead when it stops.
 * - Past the stall angle the lift curve collapses and drag rises, so the nose
 *   drops, speed builds, and the wing starts flying again.
 *
 * Lift uses CL = CL0 + CLα·α, blended into a post-stall flat-plate response
 * rather than cut to zero, which keeps a stalled aircraft recoverable.
 */
const AIR_MIN_SPEED = 0.4;

export class AircraftController implements VehicleController {
  readonly kind = 'aircraft' as const;
  readonly surfaceDeflection = { pitch: 0, roll: 0, yaw: 0 };
  private readonly gear: LandingGear;
  private propRate = 0;
  private flapPosition = 0;
  private gearPosition = 1;

  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly relative = new Vector3();
  private readonly force = new Vector3();
  private readonly point = new Vector3();
  private readonly tmp = new Vector3();
  private readonly ground: VehicleGroundSample = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' };

  constructor(private readonly vehicleSpec: VehicleSpec) {
    if (!vehicleSpec.aero) throw new Error(`Vehicle "${vehicleSpec.key}" is an aircraft but has no aero spec`);
    this.gear = new LandingGear(vehicleSpec.wheels ?? [], vehicleSpec.mass);
  }

  get wheels(): readonly WheelView[] { return this.gear.gears; }
  get rotorRate(): number { return this.propRate; }
  /** 0 = retracted, 1 = extended. Rendering reads this. */
  get gearExtension(): number { return this.gearPosition; }
  get flapExtension(): number { return this.flapPosition; }

  reset(): void {
    this.gear.reset();
    this.propRate = 0;
    this.flapPosition = 0;
    this.gearPosition = 1;
    this.surfaceDeflection.pitch = 0;
    this.surfaceDeflection.roll = 0;
    this.surfaceDeflection.yaw = 0;
  }

  step(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, telemetry: VehicleTelemetry): void {
    const aero = this.vehicleSpec.aero!;
    body.forward(this.forward);
    body.right(this.right);
    body.up(this.up);

    body.addForce(0, env.gravity * body.mass, 0);

    // Relative wind = velocity through the air mass.
    this.relative.copy(body.velocity).sub(env.wind as Vector3);
    const airspeed = this.relative.length();
    const density = airDensityAt(body.position.y);

    // Decompose the relative wind into the body frame.
    const vForward = this.relative.dot(this.forward);
    const vUp = this.relative.dot(this.up);
    const vRight = this.relative.dot(this.right);

    const throttle = clamp(input.throttle, 0, 1);
    this.propRate += (throttle - this.propRate) * Math.min(1, 2.2 * dt);
    this.flapPosition += (clamp(input.flaps, 0, 1) - this.flapPosition) * Math.min(1, 1.4 * dt);
    this.gearPosition += ((input.gearDown ? 1 : 0) - this.gearPosition) * Math.min(1, 0.8 * dt);

    // Thrust along the body forward axis. Propeller thrust decays with airspeed
    // (the blade's advance ratio rises); jet thrust is near-constant.
    let thrust = aero.maxThrust * throttle;
    if (aero.propeller) thrust *= clamp(1 - Math.max(0, vForward) / aero.thrustFalloffSpeed, 0.08, 1);
    this.force.copy(this.forward).multiplyScalar(thrust);
    body.addForce(this.force.x, this.force.y, this.force.z);

    let angleOfAttack = 0;
    let stalled = false;

    if (airspeed > AIR_MIN_SPEED) {
      // q = ½ρV², the scaling factor on every aerodynamic force and moment.
      const q = 0.5 * density * airspeed * airspeed;

      angleOfAttack = Math.atan2(-vUp, Math.max(0.1, vForward));
      const sideslip = Math.atan2(vRight, Math.max(0.1, vForward));

      const flapLift = aero.flapLift * this.flapPosition;
      const flapDrag = aero.flapDrag * this.flapPosition;

      // Lift curve with a smooth post-stall transition to a flat-plate response.
      const linearCl = aero.liftZero + flapLift + aero.liftSlope * angleOfAttack;
      const stallDepth = Math.abs(angleOfAttack) - aero.stallAngle;
      let cl = linearCl;
      if (stallDepth > 0) {
        stalled = true;
        const blend = clamp(stallDepth / 0.22, 0, 1);
        const flatPlate = Math.sin(2 * angleOfAttack) * 1.05;
        cl = linearCl * (1 - blend) + flatPlate * blend;
      }
      const cd = aero.dragZero + flapDrag + aero.inducedDrag * cl * cl + (stalled ? 0.9 * Math.min(1, stallDepth / 0.3) : 0);

      const lift = q * aero.wingArea * cl;
      const drag = q * aero.wingArea * cd;
      const side = q * aero.wingArea * aero.sideSlope * -sideslip;

      // Lift is perpendicular to the relative wind, in the aircraft's vertical plane.
      this.tmp.copy(this.relative).multiplyScalar(1 / airspeed);
      // liftAxis = (wind × right) gives "up" relative to the airflow.
      this.force.copy(this.tmp).cross(this.right).normalize().multiplyScalar(lift);
      this.force.addScaledVector(this.tmp, -drag);
      // Lift and drag act through the centre of gravity and the resulting
      // pitching moment is modelled explicitly below as Cm(α). Applying them
      // at an offset point *as well* would count the static margin twice and
      // drag the trim point back to zero lift.
      body.addForce(this.force.x, this.force.y, this.force.z);

      // The fin's sideforce genuinely acts aft of the centre of gravity, so it
      // is applied there: that offset is the weathervane couple.
      this.force.copy(this.right).multiplyScalar(side);
      body.localPoint(aero.centre, this.point);
      body.addForceAtPoint(this.force, this.point);

      // Control surfaces: authority scales with dynamic pressure.
      const authority = q * aero.wingArea;
      const elevator = clamp(input.pitch, -1, 1);
      const aileron = clamp(input.roll, -1, 1);
      const rudder = clamp(input.yaw, -1, 1);
      this.surfaceDeflection.pitch = elevator * 0.35;
      this.surfaceDeflection.roll = aileron * 0.35;
      this.surfaceDeflection.yaw = rudder * 0.35;

      // Sign convention: +X is right, +Y up, +Z forward, so a positive torque
      // about `right` pitches the nose *down* and a positive torque about `up`
      // yaws the nose *right*. Pulling back on the stick (+pitch) must raise
      // the nose, hence the negation.
      this.addBodyTorque(body, this.right, -elevator * authority * aero.pitchAuthority);
      this.addBodyTorque(body, this.forward, -aileron * authority * aero.rollAuthority);
      this.addBodyTorque(body, this.up, rudder * authority * aero.yawAuthority);

      // Static stability: the tail weathervanes the aircraft toward its trimmed
      // angle of attack. Deviating nose-up must produce a nose-down (positive)
      // moment, and positive sideslip a nose-right (positive) one — get these
      // backwards and the aircraft is divergently unstable.
      this.addBodyTorque(body, this.right, (angleOfAttack - aero.trimAngle) * authority * aero.pitchStability);
      this.addBodyTorque(body, this.up, sideslip * authority * aero.yawStability);

      // Aerodynamic damping opposes rotation and scales with airspeed.
      const damp = q * aero.wingArea;
      this.addBodyTorque(body, this.right, -body.angularVelocity.dot(this.right) * damp * aero.pitchDamping);
      this.addBodyTorque(body, this.forward, -body.angularVelocity.dot(this.forward) * damp * aero.rollDamping);
      this.addBodyTorque(body, this.up, -body.angularVelocity.dot(this.up) * damp * aero.yawDamping);
    }

    const brakeTorque = this.vehicleSpec.drivetrain?.brakeTorque ?? 2600;
    this.gear.step(dt, body, env, {
      steer: clamp(input.yaw, -1, 1) * 0.45,
      brake: clamp(input.brake, 0, 1),
      extended: this.gearPosition > 0.35,
      brakeTorque,
    });

    env.ground(body.position.x, body.position.z, this.ground);
    this.writeTelemetry(body, telemetry, airspeed, angleOfAttack, stalled);
  }

  private addBodyTorque(body: VehicleBody, axis: Vector3, magnitude: number): void {
    if (magnitude === 0) return;
    body.addTorque(axis.x * magnitude, axis.y * magnitude, axis.z * magnitude);
  }

  private writeTelemetry(body: VehicleBody, telemetry: VehicleTelemetry, airspeed: number, angleOfAttack: number, stalled: boolean): void {
    telemetry.speed = body.velocity.length();
    telemetry.forwardSpeed = body.velocity.dot(this.forward);
    telemetry.airspeed = airspeed;
    telemetry.angleOfAttack = angleOfAttack;
    telemetry.stalled = stalled;
    telemetry.verticalSpeed = body.velocity.y;
    telemetry.altitude = body.position.y - this.ground.height;
    telemetry.grounded = this.gear.contactFraction;
    telemetry.surface = this.gear.surface;
    telemetry.engineRpm = this.propRate * 2700;
    telemetry.load = this.propRate;
    telemetry.rotorRpm = this.propRate;
    telemetry.gear = 0;
    telemetry.slip = 0;
  }
}
