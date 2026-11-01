import { Vector3 } from 'three/webgpu';
import { clamp } from '../../utils/math';
import type { VehicleBody } from '../vehicle-body';
import type { VehicleClass, VehicleControlInput, VehicleEnvironment, VehicleSpec } from '../types';
import { WheeledController } from './wheeled';

/**
 * Two-wheeler balance model.
 *
 * A motorcycle is not a narrow car: it corners by leaning, and the steering
 * angle is a *consequence* of the lean rather than the cause of the turn. The
 * rider is modelled as a PD balance controller that drives roll toward the
 * equilibrium lean for the requested turn, and the front wheel is then set to
 * the geometric angle that lean implies:
 *
 *     tan(lean) = v² / (g·r)      and      r = wheelbase / tan(steer)
 *  ⇒  steer = atan(wheelbase · g · tan(lean) / v²)
 *
 * Below walking pace that relation is singular, so the model crosses over to
 * direct steering — which is also what a real rider does when paddling around
 * a car park. If the bike is pushed past its recoverable lean angle the rider
 * can no longer save it and it falls, because the stabilising torque is cut.
 */
const MAX_LEAN = 0.78;
/** Below this the rider steers directly instead of leaning, m/s. */
const WALKING_PACE = 2.6;
/** Past this lean the rider cannot recover and the bike goes down, radians. */
const RECOVERY_LIMIT = 1.05;

export class MotorcycleController extends WheeledController {
  override readonly kind: VehicleClass = 'motorcycle';
  /** Current lean demand, radians (positive = leaning right). */
  private leanTarget = 0;
  private readonly wheelbase: number;
  private readonly axis = new Vector3();
  private fallen = false;

  constructor(vehicleSpec: VehicleSpec) {
    super(vehicleSpec);
    const wheels = vehicleSpec.wheels ?? [];
    const front = wheels.find((wheel) => wheel.steered);
    const rear = wheels.find((wheel) => !wheel.steered);
    this.wheelbase = front && rear ? Math.abs(front.local.z - rear.local.z) : vehicleSpec.dimensions.length * 0.68;
  }

  override reset(): void {
    super.reset();
    this.leanTarget = 0;
    this.fallen = false;
  }

  get leanAngle(): number { return this.leanTarget; }
  get isFallen(): boolean { return this.fallen; }

  /**
   * Front-wheel angle implied by the current lean. At a standstill this falls
   * back to direct steering so the bike can be manoeuvred by hand.
   */
  protected override steerTarget(input: VehicleControlInput, forwardSpeed: number, body: VehicleBody): number {
    const speed = Math.abs(forwardSpeed);
    const demand = clamp(input.steer, -1, 1);
    if (speed < WALKING_PACE) {
      this.leanTarget = 0;
      return demand * 0.52;
    }
    // Lean authority tapers in with speed and out again at very high speed.
    const authority = Math.min(1, (speed - WALKING_PACE) / 7);
    this.leanTarget = -demand * MAX_LEAN * authority;
    const lean = body.roll;
    const steer = Math.atan((this.wheelbase * 9.81 * Math.tan(-lean)) / Math.max(4, speed * speed));
    return clamp(steer, -0.5, 0.5);
  }

  /**
   * The rider's balance torque. This is the only thing keeping the bike up, so
   * cutting it past `RECOVERY_LIMIT` is what makes a crash a real outcome
   * instead of an animation.
   */
  protected override extraForces(
    dt: number, body: VehicleBody, _input: VehicleControlInput, env: VehicleEnvironment, forwardSpeed: number,
  ): void {
    void dt;
    const grounded = this.wheels.some((wheel) => wheel.grounded);
    const lean = body.roll;
    if (Math.abs(lean) > RECOVERY_LIMIT) this.fallen = true;
    else if (Math.abs(lean) < 0.25 && grounded) this.fallen = false;
    if (!grounded || this.fallen) return;

    const speed = Math.abs(forwardSpeed);
    // A stationary bike is held up by the rider's feet; a moving one by steering.
    const strength = speed < WALKING_PACE ? 0.55 : 1;
    const error = this.leanTarget - lean;
    const rollRate = body.angularVelocity.dot(this.forward);
    const inertia = body.mass * 0.42;
    const torque = (error * 18 - rollRate * 5.2) * inertia * strength;

    this.axis.copy(this.forward).multiplyScalar(torque);
    body.addTorque(this.axis.x, this.axis.y, this.axis.z);

    // Gyroscopic self-centring: a rolling wheel resists being tipped.
    const gyro = Math.min(1, speed / 12) * body.mass * 0.08;
    this.axis.copy(this.forward).multiplyScalar(-rollRate * gyro);
    body.addTorque(this.axis.x, this.axis.y, this.axis.z);
    void env;
  }

  /** Bikes sit low; the hull test must not lift them off their wheels. */
  protected override get chassisClearance(): number { return this.vehicleSpec.dimensions.height * 0.22; }
}
