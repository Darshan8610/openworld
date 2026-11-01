/**
 * Engine, gearbox and differential.
 *
 * The engine is a torque curve sampled by crank speed; the gearbox multiplies
 * that torque and divides wheel speed; the differential splits drive torque
 * between the driven wheels and can be locked. RPM is derived from the driven
 * wheels through the current ratio, so the audio layer gets a real engine speed
 * instead of a throttle-shaped fake.
 */
import { clamp } from '../utils/math';
import type { DrivetrainSpec } from './types';

export interface DrivetrainState {
  /** -1 reverse, 0 neutral, 1..n forward gear. */
  gear: number;
  rpm: number;
  /** Seconds remaining in the current shift (torque is cut while shifting). */
  shiftTimer: number;
  /** 0..1 engine load for audio and exhaust effects. */
  load: number;
}

const SHIFT_TIME = 0.22;

/** Fraction of `maxRpm` at which the soft limiter starts cutting fuel. */
const LIMITER_BAND = 0.985;

/**
 * Normalised torque fraction at a crank speed. A broad plateau around the
 * torque peak with a falloff toward idle and the limiter — characteristic of a
 * road engine and good enough to drive gearing decisions honestly.
 */
export function torqueFraction(rpm: number, spec: DrivetrainSpec): number {
  const { idleRpm, peakTorqueRpm, maxRpm } = spec;
  if (rpm <= idleRpm) return 0.42;
  if (rpm >= maxRpm) return 0.22;
  if (rpm <= peakTorqueRpm) {
    const t = (rpm - idleRpm) / Math.max(1, peakTorqueRpm - idleRpm);
    // Rises from a driveable idle torque to the peak.
    return 0.42 + 0.58 * Math.sin((t * Math.PI) / 2);
  }
  const t = (rpm - peakTorqueRpm) / Math.max(1, maxRpm - peakTorqueRpm);
  // Falls away toward the limiter but keeps useful power high in the range.
  return 1 - 0.62 * t * t;
}

export class Drivetrain {
  readonly state: DrivetrainState = { gear: 1, rpm: 0, shiftTimer: 0, load: 0 };

  constructor(private readonly spec: DrivetrainSpec) {
    this.state.rpm = spec.idleRpm;
  }

  get gearCount(): number { return this.spec.gears.length; }

  /** Total reduction from crank to wheel for the current gear (0 in neutral). */
  ratio(): number {
    const { gear } = this.state;
    if (gear === 0) return 0;
    if (gear < 0) return -this.spec.reverseRatio * this.spec.finalDrive;
    const gearRatio = this.spec.gears[gear - 1];
    return gearRatio === undefined ? 0 : gearRatio * this.spec.finalDrive;
  }

  shiftUp(): void {
    if (this.state.shiftTimer > 0) return;
    if (this.state.gear < this.spec.gears.length) {
      this.state.gear = this.state.gear <= 0 ? 1 : this.state.gear + 1;
      this.state.shiftTimer = SHIFT_TIME;
    }
  }

  shiftDown(): void {
    if (this.state.shiftTimer > 0) return;
    if (this.state.gear > -1) {
      this.state.gear = this.state.gear <= 1 ? (this.state.gear === 1 ? 0 : -1) : this.state.gear - 1;
      this.state.shiftTimer = SHIFT_TIME;
    }
  }

  setGear(gear: number): void {
    this.state.gear = clamp(Math.round(gear), -1, this.spec.gears.length);
  }

  /**
   * Advance the gearbox and produce the torque delivered to the driven axle.
   *
   * `drivenWheelOmega` is the mean angular speed of the driven wheels, rad/s.
   * Returns the torque at the wheels in N·m (already multiplied by the ratio).
   */
  update(dt: number, throttle: number, drivenWheelOmega: number, input: { automatic: boolean; shiftUp: boolean; shiftDown: boolean; reverse: boolean; ignition: boolean }): number {
    const spec = this.spec;
    this.state.shiftTimer = Math.max(0, this.state.shiftTimer - dt);

    if (input.reverse && this.state.gear > 0 && Math.abs(drivenWheelOmega) < 1.2) this.state.gear = -1;
    else if (!input.reverse && this.state.gear < 0 && Math.abs(drivenWheelOmega) < 1.2) this.state.gear = 1;

    if (!input.automatic) {
      if (input.shiftUp) this.shiftUp();
      if (input.shiftDown) this.shiftDown();
    }

    const ratio = this.ratio();
    // Crank speed follows the wheels through the gearbox; neutral idles.
    const geared = Math.abs(drivenWheelOmega * ratio) * (60 / (2 * Math.PI));
    // A dead engine is spun by the wheels alone — no idle floor, so it reads
    // zero rpm once the car stops.
    const idle = input.ignition ? spec.idleRpm : 0;
    const target = ratio === 0
      ? idle + (input.ignition ? throttle * (spec.maxRpm - spec.idleRpm) * 0.55 : 0)
      : Math.max(idle, geared);
    // Driveline inertia smooths the crank rather than snapping it to the wheels.
    const responsiveness = 1 - Math.exp(-(12 / Math.max(0.05, spec.inertia)) * dt);
    this.state.rpm += (Math.min(target, spec.maxRpm) - this.state.rpm) * clamp(responsiveness, 0, 1);

    if (input.automatic && this.state.shiftTimer === 0 && this.state.gear > 0) {
      const up = spec.maxRpm * spec.upshiftRpm;
      const down = spec.maxRpm * spec.downshiftRpm;
      if (this.state.rpm > up && this.state.gear < spec.gears.length) this.shiftUp();
      else if (this.state.rpm < down && this.state.gear > 1) this.shiftDown();
    }

    if (ratio === 0 || this.state.shiftTimer > 0) {
      this.state.load = this.state.shiftTimer > 0 ? throttle * 0.3 : throttle * 0.25;
      return 0;
    }

    const available = spec.peakTorque * torqueFraction(this.state.rpm, spec);
    // The ECU cuts fuel in a band *below* the hard limit, exactly as a real
    // soft limiter does. Testing against `maxRpm` alone never fires, because
    // the crank only approaches it asymptotically — which let a wheel spinning
    // on ice accelerate without bound.
    const onLimiter = this.state.rpm >= spec.maxRpm * LIMITER_BAND;
    const limited = onLimiter || !input.ignition ? 0 : available;
    const drive = limited * throttle;
    // Engine braking: a closed throttle drags on the driveline, and a dead
    // engine being turned over by the wheels drags hardest of all.
    const closed = input.ignition ? 1 - throttle : 1;
    const braking = spec.engineBraking * closed * (this.state.rpm / spec.maxRpm) * spec.peakTorque * 0.25;
    this.state.load = input.ignition ? clamp(throttle * (0.35 + 0.65 * (this.state.rpm / spec.maxRpm)), 0, 1) : 0;
    return (drive - braking) * ratio;
  }

  /**
   * Split axle torque between two wheels. An open differential sends torque to
   * the wheel with least grip; a locked one shares it evenly. `traction` is each
   * wheel's normalised available grip.
   */
  split(axleTorque: number, tractionA: number, tractionB: number): [number, number] {
    const lock = clamp(this.spec.differentialLock, 0, 1);
    const total = tractionA + tractionB;
    if (total <= 1e-5) return [axleTorque * 0.5, axleTorque * 0.5];
    // Open: the slipping wheel (lower traction) limits the other one.
    const openA = axleTorque * 0.5 * (Math.min(tractionA, tractionB) / Math.max(1e-5, tractionA));
    const openB = axleTorque * 0.5 * (Math.min(tractionA, tractionB) / Math.max(1e-5, tractionB));
    const lockedA = axleTorque * (tractionA / total);
    const lockedB = axleTorque * (tractionB / total);
    return [openA + (lockedA - openA) * lock, openB + (lockedB - openB) * lock];
  }

  reset(): void {
    this.state.gear = 1;
    this.state.rpm = this.spec.idleRpm;
    this.state.shiftTimer = 0;
    this.state.load = 0;
  }
}
