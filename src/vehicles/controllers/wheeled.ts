import { Vector3 } from 'three/webgpu';
import { clamp } from '../../utils/math';
import type { SurfaceKind } from '../../physics/surfaces';
import { Drivetrain } from '../drivetrain';
import { solveTyre, blankTyreForces } from '../tyre';
import type { TyreForces } from '../tyre';
import type { VehicleBody } from '../vehicle-body';
import type {
  VehicleClass, VehicleControlInput, VehicleEnvironment, VehicleGroundSample, VehicleSpec, VehicleTelemetry, WheelSpec,
} from '../types';
import type { VehicleController, WheelView } from './controller';
import { airDensityAt } from './controller';

/**
 * Raycast-suspension road vehicle.
 *
 * Each wheel casts along the body's down axis against the analytic terrain,
 * runs a spring/damper, then solves a tyre contact patch. Because every force
 * is applied at its own world point on a real rigid body, weight transfer,
 * body roll under cornering, dive under braking and squat under power all fall
 * out of the simulation instead of being animated.
 */
interface Wheel extends WheelView {
  readonly spec: WheelSpec;
  compression: number;
  /** Wheel rotational inertia, kg·m². */
  readonly inertia: number;
  /**
   * Wheel inertia plus the engine/gearbox inertia reflected through the
   * current ratio (I·n²). Refreshed each step because it changes with gear.
   */
  effectiveInertia: number;
  readonly contact: Vector3;
  readonly normal: Vector3;
  surface: SurfaceKind;
  forces: TyreForces;
}

const GROUND_EPSILON = 0.02;
/** Maximum steering angle at a standstill, radians (≈ 36°). */
const MAX_STEER = 0.63;
/** Steering is reduced with speed so the car stays stable at motorway pace. */
const STEER_SPEED_FALLOFF = 42;
const STEER_RATE = 4.2;

export class WheeledController implements VehicleController {
  readonly kind: VehicleClass = 'wheeled';
  readonly wheels: Wheel[] = [];
  readonly rotorRate = 0;
  readonly surfaceDeflection = { pitch: 0, roll: 0, yaw: 0 };
  readonly drivetrain: Drivetrain;

  protected steerAngle = 0;
  private readonly attach = new Vector3();
  private readonly down = new Vector3();
  private readonly wheelCentre = new Vector3();
  protected readonly forward = new Vector3();
  protected readonly right = new Vector3();
  protected readonly up = new Vector3();
  private readonly pointVelocity = new Vector3();
  private readonly force = new Vector3();
  private readonly tmp = new Vector3();
  protected readonly ground: VehicleGroundSample = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' };

  constructor(protected readonly vehicleSpec: VehicleSpec) {
    const drivetrainSpec = vehicleSpec.drivetrain;
    if (!drivetrainSpec) throw new Error(`Vehicle "${vehicleSpec.key}" is wheeled but has no drivetrain`);
    this.drivetrain = new Drivetrain(drivetrainSpec);
    for (const wheelSpec of vehicleSpec.wheels ?? []) {
      // A road wheel is roughly 2 % of the vehicle mass; I = ½mr² for a disc.
      const wheelMass = Math.max(6, vehicleSpec.mass * 0.02);
      this.wheels.push({
        id: wheelSpec.id, spec: wheelSpec,
        suspensionLength: wheelSpec.restLength, steer: 0, spin: 0, omega: 0,
        grounded: false, load: 0, slip: 0, compression: 0,
        inertia: 0.5 * wheelMass * wheelSpec.radius * wheelSpec.radius,
        effectiveInertia: 0.5 * wheelMass * wheelSpec.radius * wheelSpec.radius,
        contact: new Vector3(), normal: new Vector3(0, 1, 0),
        surface: 'asphalt', forces: blankTyreForces(),
      });
    }
    if (this.wheels.length === 0) throw new Error(`Vehicle "${vehicleSpec.key}" is wheeled but has no wheels`);
  }

  reset(): void {
    this.steerAngle = 0;
    this.drivetrain.reset();
    for (const wheel of this.wheels) {
      wheel.omega = 0; wheel.spin = 0; wheel.compression = 0; wheel.load = 0;
      wheel.slip = 0; wheel.grounded = false;
      wheel.suspensionLength = wheel.spec.restLength;
    }
  }

  step(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, telemetry: VehicleTelemetry): void {
    body.forward(this.forward);
    body.right(this.right);
    body.up(this.up);
    this.down.copy(this.up).multiplyScalar(-1);

    const forwardSpeed = body.velocity.dot(this.forward);
    const speed = body.velocity.length();

    // Rate-limited steering so the input cannot snap the wheels.
    const target = this.steerTarget(input, forwardSpeed, body);
    const maxDelta = STEER_RATE * dt;
    this.steerAngle += clamp(target - this.steerAngle, -maxDelta, maxDelta);

    // Gravity acts on the centre of mass.
    body.addForce(0, env.gravity * body.mass, 0);

    this.solveSuspension(dt, body, env);
    this.applyAntiRoll(body);

    const driven = this.wheels.filter((wheel) => wheel.spec.driven);
    const meanOmega = driven.length > 0 ? driven.reduce((sum, wheel) => sum + wheel.omega, 0) / driven.length : 0;
    const axleTorque = this.drivetrain.update(dt, clamp(input.throttle, 0, 1), meanOmega, input);
    this.applyWheelTorques(dt, input, axleTorque, driven);
    this.solveTyres(dt, body);
    this.applyBodyDrag(body, speed);
    this.extraForces(dt, body, input, env, forwardSpeed);
    this.resolveChassisContact(body, env);

    this.writeTelemetry(body, telemetry, forwardSpeed, speed, env);
  }

  /** Steering demand in radians. Two-wheelers override this to steer by lean. */
  protected steerTarget(input: VehicleControlInput, forwardSpeed: number, _body: VehicleBody): number {
    return clamp(input.steer, -1, 1) * MAX_STEER / (1 + Math.abs(forwardSpeed) / STEER_SPEED_FALLOFF);
  }

  /** Hook for subclasses to add forces after the tyres are solved. */
  protected extraForces(
    _dt: number, _body: VehicleBody, _input: VehicleControlInput, _env: VehicleEnvironment, _forwardSpeed: number,
  ): void { /* The four-wheeled model needs nothing extra. */ }

  /** Vertical clearance used by the hull contact test; bikes sit lower. */
  protected get chassisClearance(): number { return this.vehicleSpec.dimensions.height * 0.5; }

  /** Spring/damper per wheel; the normal force is what the tyres then use. */
  private solveSuspension(dt: number, body: VehicleBody, env: VehicleEnvironment): void {
    for (const wheel of this.wheels) {
      const s = wheel.spec;
      body.localPoint(s.local, this.attach);
      const hit = this.castSuspension(this.attach, env, s.restLength + s.maxTravel + s.radius);
      wheel.normal.set(this.ground.nx, this.ground.ny, this.ground.nz);
      wheel.surface = this.ground.surface;

      // Distance along the suspension axis to put the wheel centre one radius
      // off the contact plane. Clamped so a rolled-over body cannot divide by ~0.
      const axisDot = Math.max(0.25, -this.down.dot(wheel.normal));
      const centreDistance = hit - s.radius / axisDot;
      const maxLength = s.restLength + s.maxTravel;

      if (!Number.isFinite(centreDistance) || centreDistance > maxLength) {
        wheel.grounded = false;
        wheel.load = 0;
        wheel.compression = 0;
        // The unloaded wheel droops to full extension.
        wheel.suspensionLength += (maxLength - wheel.suspensionLength) * Math.min(1, 10 * dt);
        wheel.forces.longitudinal = 0; wheel.forces.lateral = 0; wheel.forces.saturation = 0;
        wheel.slip = 0;
        continue;
      }

      const length = clamp(centreDistance, 0, maxLength);
      wheel.suspensionLength = length;
      wheel.grounded = true;
      wheel.compression = Math.max(0, s.restLength - length);

      this.wheelCentre.copy(this.attach).addScaledVector(this.down, length);
      wheel.contact.copy(this.wheelCentre).addScaledVector(wheel.normal, -s.radius);

      body.pointVelocity(this.wheelCentre, this.pointVelocity);
      // Positive while the spring is being compressed: the attach point is
      // travelling *along* the suspension axis toward the contact patch.
      const compressionRate = this.pointVelocity.dot(this.down);

      const spring = s.stiffness * wheel.compression;
      const damper = s.damping * compressionRate;
      // Bump stop: the last centimetres of travel are much stiffer.
      const bump = length <= 0.02 ? s.stiffness * 6 * (0.02 - length) : 0;
      const load = Math.max(0, spring + damper + bump);
      wheel.load = load;

      this.force.copy(wheel.normal).multiplyScalar(load);
      body.addForceAtPoint(this.force, wheel.contact);
    }
  }

  /**
   * Iteratively solve where the near-vertical suspension ray meets the terrain.
   * Two refinements are enough because the ray is close to vertical and the
   * field is smooth; it avoids marching the ray in fixed increments.
   */
  private castSuspension(origin: Vector3, env: VehicleEnvironment, maxDistance: number): number {
    let t = maxDistance * 0.5;
    for (let i = 0; i < 3; i++) {
      const x = origin.x + this.down.x * t;
      const z = origin.z + this.down.z * t;
      env.ground(x, z, this.ground);
      if (Math.abs(this.down.y) < 1e-3) return Infinity;
      const next = (this.ground.height - origin.y) / this.down.y;
      if (!Number.isFinite(next)) return Infinity;
      t = clamp(next, 0, maxDistance);
    }
    // Re-sample at the converged point so the normal matches the contact.
    env.ground(origin.x + this.down.x * t, origin.z + this.down.z * t, this.ground);
    return t <= maxDistance - GROUND_EPSILON ? t : Infinity;
  }

  /** Anti-roll bars couple the two wheels of an axle to resist body roll. */
  private applyAntiRoll(body: VehicleBody): void {
    for (let i = 0; i + 1 < this.wheels.length; i += 2) {
      const left = this.wheels[i]!;
      const rightWheel = this.wheels[i + 1]!;
      if (!left.grounded && !rightWheel.grounded) continue;
      const stiffness = (left.spec.stiffness + rightWheel.spec.stiffness) * 0.5;
      const transfer = (left.compression - rightWheel.compression) * stiffness * 0.35;
      if (Math.abs(transfer) < 1e-3) continue;
      if (left.grounded) {
        this.force.copy(left.normal).multiplyScalar(-transfer);
        body.addForceAtPoint(this.force, left.contact);
      }
      if (rightWheel.grounded) {
        this.force.copy(rightWheel.normal).multiplyScalar(transfer);
        body.addForceAtPoint(this.force, rightWheel.contact);
      }
    }
  }

  /**
   * Engine torque to the driven wheels, brake torque to all of them.
   *
   * Driven wheels are spun against their *effective* inertia: the wheel itself
   * plus the engine and gearbox reflected through the square of the current
   * ratio. That term is real — it is why a car in first gear resists being
   * slowed by a bump far more than one in top — and omitting it also makes the
   * wheel-speed integration oscillate badly at a 120 Hz step.
   */
  private applyWheelTorques(dt: number, input: VehicleControlInput, axleTorque: number, driven: Wheel[]): void {
    const ratio = this.drivetrain.ratio();
    const reflected = this.vehicleSpec.drivetrain!.inertia * ratio * ratio;
    for (const wheel of this.wheels) {
      wheel.effectiveInertia = wheel.spec.driven && driven.length > 0
        ? wheel.inertia + reflected / driven.length
        : wheel.inertia;
    }
    if (driven.length > 0) {
      if (driven.length === 2) {
        const [a, b] = driven as [Wheel, Wheel];
        const [ta, tb] = this.drivetrain.split(axleTorque, Math.max(0.05, a.load), Math.max(0.05, b.load));
        a.omega += (ta / a.effectiveInertia) * dt;
        b.omega += (tb / b.effectiveInertia) * dt;
      } else {
        const share = axleTorque / driven.length;
        for (const wheel of driven) wheel.omega += (share / wheel.effectiveInertia) * dt;
      }
    }

    const spec = this.vehicleSpec.drivetrain!;
    const brake = clamp(input.brake, 0, 1);
    const handbrake = clamp(input.handbrake, 0, 1);
    for (const wheel of this.wheels) {
      let brakeTorque = spec.brakeTorque * brake * wheel.spec.brakeShare;
      if (wheel.spec.handbrake) brakeTorque += spec.handbrakeTorque * handbrake;
      if (brakeTorque <= 0) continue;
      const delta = (brakeTorque / wheel.effectiveInertia) * dt;
      // Braking can stop the wheel but must never spin it backwards.
      if (Math.abs(wheel.omega) <= delta) wheel.omega = 0;
      else wheel.omega -= Math.sign(wheel.omega) * delta;
    }
  }

  /** Contact-patch forces, plus the reaction torque back onto each wheel. */
  private solveTyres(dt: number, body: VehicleBody): void {
    for (const wheel of this.wheels) {
      const s = wheel.spec;
      if (!wheel.grounded) {
        // A free wheel just spins down slowly.
        wheel.omega *= Math.max(0, 1 - 0.6 * dt);
        wheel.spin += wheel.omega * dt;
        continue;
      }

      // Wheel plane projected onto the contact plane.
      const steer = s.steered ? this.steerAngle : 0;
      this.tmp.copy(this.forward).applyAxisAngle(this.up, steer);
      this.tmp.addScaledVector(wheel.normal, -this.tmp.dot(wheel.normal));
      if (this.tmp.lengthSq() < 1e-6) continue;
      this.tmp.normalize();
      const wheelForward = this.tmp;
      // right = up × forward in a Y-up, Z-forward right-handed frame.
      const wheelRight = this.force.copy(wheel.normal).cross(wheelForward).normalize();

      body.pointVelocity(wheel.contact, this.pointVelocity);
      const longitudinalSpeed = this.pointVelocity.dot(wheelForward);
      const lateralSpeed = this.pointVelocity.dot(wheelRight);

      const forces = solveTyre({
        load: wheel.load,
        longitudinalSpeed,
        lateralSpeed,
        rimSpeed: wheel.omega * s.radius,
        surface: wheel.surface,
        gripLong: s.gripLong,
        gripLat: s.gripLat,
      }, wheel.forces);
      wheel.slip = forces.saturation;

      // Rolling resistance always opposes travel.
      const rolling = -Math.sign(longitudinalSpeed) * s.rollingResistance * wheel.load;
      const fx = forces.longitudinal + rolling;

      this.tmp.copy(wheelForward).multiplyScalar(fx).addScaledVector(wheelRight, forces.lateral);
      body.addForceAtPoint(this.tmp, wheel.contact);

      // Reaction: the ground's push on the tyre spins the wheel the other way,
      // against the same effective inertia the drive torque saw.
      wheel.omega -= (forces.longitudinal * s.radius / wheel.effectiveInertia) * dt;
      wheel.spin += wheel.omega * dt;
    }
  }

  private applyBodyDrag(body: VehicleBody, speed: number): void {
    if (speed < 0.05) return;
    const dims = this.vehicleSpec.dimensions;
    const area = dims.width * dims.height;
    const density = airDensityAt(body.position.y);
    const magnitude = 0.5 * density * 0.36 * area * speed * speed;
    this.tmp.copy(body.velocity).multiplyScalar(-magnitude / speed);
    body.addForce(this.tmp.x, this.tmp.y, this.tmp.z);
    // Yaw damping keeps a spun car from rotating forever.
    body.addTorque(
      -body.angularVelocity.x * body.mass * 0.05,
      -body.angularVelocity.y * body.mass * 0.09,
      -body.angularVelocity.z * body.mass * 0.05,
    );
  }

  /**
   * Keep the hull out of the terrain. Without this a hard landing or a steep
   * bank lets the chassis sink between the wheel rays.
   */
  protected resolveChassisContact(body: VehicleBody, env: VehicleEnvironment): void {
    const clearance = this.chassisClearance;
    env.ground(body.position.x, body.position.z, this.ground);
    const penetration = this.ground.height + clearance * 0.45 - body.position.y;
    if (penetration <= 0) return;
    body.position.y += penetration;
    if (body.velocity.y < 0) {
      // Inelastic: the chassis does not bounce like a ball.
      body.velocity.y *= -0.12;
      body.angularVelocity.multiplyScalar(0.7);
    }
  }

  private writeTelemetry(body: VehicleBody, telemetry: VehicleTelemetry, forwardSpeed: number, speed: number, env: VehicleEnvironment): void {
    let grounded = 0, slip = 0, load = 0;
    let dominant: SurfaceKind = 'asphalt';
    let bestLoad = -1;
    for (const wheel of this.wheels) {
      if (wheel.grounded) grounded++;
      slip += Math.min(1, wheel.slip);
      load += wheel.load;
      if (wheel.grounded && wheel.load > bestLoad) { bestLoad = wheel.load; dominant = wheel.surface; }
    }
    void load;
    env.ground(body.position.x, body.position.z, this.ground);
    telemetry.speed = speed;
    telemetry.forwardSpeed = forwardSpeed;
    telemetry.engineRpm = this.drivetrain.state.rpm;
    telemetry.gear = this.drivetrain.state.gear;
    telemetry.load = this.drivetrain.state.load;
    telemetry.grounded = this.wheels.length > 0 ? grounded / this.wheels.length : 0;
    telemetry.slip = this.wheels.length > 0 ? slip / this.wheels.length : 0;
    telemetry.surface = dominant;
    telemetry.verticalSpeed = body.velocity.y;
    telemetry.altitude = body.position.y - this.ground.height;
    telemetry.airspeed = speed;
  }
}
