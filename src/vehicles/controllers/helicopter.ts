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
 * Rotorcraft model.
 *
 * A helicopter is not an aeroplane with vertical thrust. Thrust acts along the
 * rotor disc axis, so the aircraft moves *because* it tilts — cyclic tilts the
 * disc, the thrust vector tilts with it, and the horizontal component becomes
 * translation. The model therefore reproduces the behaviours a pilot expects:
 *
 * - Collective controls climb rate, not pitch attitude.
 * - Pitching forward trades altitude for speed unless collective is added.
 * - Main-rotor torque yaws the fuselage the other way; the tail rotor cancels
 *   it, and pedal input is a *correction* to that balance.
 * - Translational lift gives extra thrust once the disc moves into clean air,
 *   and ground effect cushions the last few metres of a landing.
 *
 * The rotor spools with a time constant, so you cannot recover from a descent
 * by slamming the collective.
 */
export class HelicopterController implements VehicleController {
  readonly kind = 'helicopter' as const;
  readonly surfaceDeflection = { pitch: 0, roll: 0, yaw: 0 };
  private readonly gear: LandingGear;
  private rotor = 0;
  private readonly hub = new Vector3();
  private readonly discAxis = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly force = new Vector3();
  private readonly relative = new Vector3();
  private readonly ground: VehicleGroundSample = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' };

  constructor(private readonly vehicleSpec: VehicleSpec) {
    if (!vehicleSpec.rotor) throw new Error(`Vehicle "${vehicleSpec.key}" is a helicopter but has no rotor spec`);
    this.gear = new LandingGear(vehicleSpec.wheels ?? [], vehicleSpec.mass);
  }

  get wheels(): readonly WheelView[] { return this.gear.gears; }
  get rotorRate(): number { return this.rotor; }

  reset(): void {
    this.rotor = 0;
    this.gear.reset();
  }

  step(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, telemetry: VehicleTelemetry): void {
    const rotorSpec = this.vehicleSpec.rotor!;
    body.forward(this.forward);
    body.right(this.right);
    body.up(this.up);

    body.addForce(0, env.gravity * body.mass, 0);

    // Collective demand spools the rotor rather than applying instantly.
    const collective = clamp(Math.max(input.collective, input.throttle), 0, 1);
    this.rotor += (collective - this.rotor) * Math.min(1, dt / Math.max(0.05, rotorSpec.spoolTime));

    this.relative.copy(body.velocity).sub(env.wind as Vector3);
    const airspeed = this.relative.length();
    const density = airDensityAt(body.position.y);
    const densityRatio = density / 1.225;

    env.ground(body.position.x, body.position.z, this.ground);
    const height = body.position.y - this.ground.height;

    // Translational lift: the disc becomes more efficient in forward flight.
    const translational = 1 + rotorSpec.translationalLift * clamp(airspeed / 24, 0, 1);
    // Ground effect: a cushion of air under the disc near the surface.
    const effect = 1 + rotorSpec.groundEffect * clamp(1 - height / Math.max(0.5, rotorSpec.groundEffectHeight), 0, 1);

    // Cyclic tilts the disc relative to the airframe.
    const cyclicPitch = clamp(input.pitch, -1, 1) * rotorSpec.cyclicRange;
    const cyclicRoll = clamp(input.roll, -1, 1) * rotorSpec.cyclicRange;
    this.discAxis.copy(this.up);
    this.discAxis.addScaledVector(this.forward, -Math.sin(cyclicPitch));
    this.discAxis.addScaledVector(this.right, Math.sin(cyclicRoll));
    this.discAxis.normalize();

    const thrust = rotorSpec.maxThrust * this.rotor * densityRatio * translational * effect;
    this.force.copy(this.discAxis).multiplyScalar(thrust);
    // Applied at the hub above the centre of mass: that offset is what makes the
    // airframe hang below the disc and pendulum when it is disturbed.
    this.hub.copy(body.position).addScaledVector(this.up, rotorSpec.hubHeight);
    body.addForceAtPoint(this.force, this.hub);

    // Cyclic also produces a direct control moment through the rotor head.
    this.addTorque(body, this.right, clamp(input.pitch, -1, 1) * rotorSpec.cyclicAuthority * this.rotor);
    this.addTorque(body, this.forward, -clamp(input.roll, -1, 1) * rotorSpec.cyclicAuthority * this.rotor);

    // Main-rotor reaction torque, countered by the tail rotor and pedals.
    const reaction = rotorSpec.reactionTorque * this.rotor;
    const pedal = clamp(input.yaw, -1, 1) * rotorSpec.tailAuthority * (0.35 + 0.65 * this.rotor);
    this.addTorque(body, this.up, reaction - pedal);

    // Parasitic drag, split so vertical flow sees the much larger plan area.
    // Treating a helicopter as isotropically streamlined lets it climb like a
    // rocket; the vertical term is what sets a realistic rate of climb.
    if (airspeed > 0.05) {
      const q = 0.5 * density;
      const horizontal = Math.hypot(this.relative.x, this.relative.z);
      const vertical = this.relative.y;
      const dragH = q * rotorSpec.dragArea * horizontal * horizontal;
      const dragV = q * rotorSpec.verticalDragArea * vertical * Math.abs(vertical);
      if (horizontal > 1e-4) {
        body.addForce(
          (-dragH * this.relative.x) / horizontal,
          0,
          (-dragH * this.relative.z) / horizontal,
        );
      }
      body.addForce(0, -dragV, 0);
    }
    const damping = rotorSpec.angularDamping * body.mass;
    body.addTorque(
      -body.angularVelocity.x * damping,
      -body.angularVelocity.y * damping * 1.4,
      -body.angularVelocity.z * damping,
    );

    this.gear.step(dt, body, env, {
      steer: 0,
      brake: clamp(input.brake, 0, 1),
      extended: true,
      brakeTorque: 4000,
    });

    this.writeTelemetry(body, telemetry, airspeed, height);
  }

  private addTorque(body: VehicleBody, axis: Vector3, magnitude: number): void {
    if (magnitude === 0) return;
    body.addTorque(axis.x * magnitude, axis.y * magnitude, axis.z * magnitude);
  }

  private writeTelemetry(body: VehicleBody, telemetry: VehicleTelemetry, airspeed: number, height: number): void {
    telemetry.speed = body.velocity.length();
    telemetry.forwardSpeed = body.velocity.dot(this.forward);
    telemetry.airspeed = airspeed;
    telemetry.verticalSpeed = body.velocity.y;
    telemetry.altitude = height;
    telemetry.rotorRpm = this.rotor;
    telemetry.engineRpm = this.rotor * 2900;
    telemetry.load = this.rotor;
    telemetry.grounded = this.gear.contactFraction;
    telemetry.surface = this.gear.surface;
    telemetry.stalled = false;
    telemetry.angleOfAttack = 0;
    telemetry.gear = 0;
    telemetry.slip = 0;
  }
}
