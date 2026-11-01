import { clamp } from '../utils/math';
import type { Input } from '../core/input';
import type { VehicleClass, VehicleControlInput } from './types';

/**
 * Maps the keyboard onto the universal control structure.
 *
 * One mapper serves every class because `VehicleControlInput` is a superset:
 * a car reads throttle/brake/steer and ignores collective, a helicopter reads
 * collective/cyclic and ignores the gearbox. The *bindings* differ per class
 * where the same physical key means something genuinely different — W is
 * "accelerate" in a car but "nose down" in an aeroplane — and that difference
 * lives here rather than leaking into the controllers.
 *
 * Analogue axes are ramped rather than snapped so keyboard input does not look
 * like a square wave; the ramp is time-based, never frame-based.
 */
export interface VehicleInputBindings {
  readonly forward: readonly string[];
  readonly back: readonly string[];
  readonly left: readonly string[];
  readonly right: readonly string[];
  readonly up: readonly string[];
  readonly down: readonly string[];
  readonly brake: readonly string[];
  readonly handbrake: readonly string[];
  readonly boost: readonly string[];
}

export const DEFAULT_BINDINGS: VehicleInputBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyR'],
  down: ['KeyF'],
  brake: ['Space'],
  handbrake: ['ShiftLeft', 'ShiftRight'],
  boost: ['ControlLeft', 'ControlRight'],
};

/** Rate at which a held key drives an axis from 0 to 1, per second. */
const RAMP_UP = 4.6;
/** Rate at which a released axis returns to centre, per second. */
const RAMP_DOWN = 7.2;

function approach(current: number, target: number, dt: number): number {
  const rate = Math.abs(target) > Math.abs(current) ? RAMP_UP : RAMP_DOWN;
  const delta = target - current;
  const step = rate * dt;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

export class VehicleInputMapper {
  private steer = 0;
  private pitch = 0;
  private roll = 0;
  private yaw = 0;
  private throttle = 0;

  constructor(private readonly bindings: VehicleInputBindings = DEFAULT_BINDINGS) {}

  reset(): void {
    this.steer = 0; this.pitch = 0; this.roll = 0; this.yaw = 0; this.throttle = 0;
  }

  /**
   * Write the current keyboard state into `out`.
   *
   * @param dt Frame delta used only for axis ramping; the physics step is
   *   separate, so control feel never changes the simulation rate.
   */
  apply(input: Input, vehicleClass: VehicleClass, dt: number, out: VehicleControlInput): VehicleControlInput {
    const b = this.bindings;
    const axis = (negative: readonly string[], positive: readonly string[]): number =>
      (input.down(...positive) ? 1 : 0) - (input.down(...negative) ? 1 : 0);

    const longitudinal = axis(b.back, b.forward);
    const lateral = axis(b.left, b.right);
    const vertical = axis(b.down, b.up);
    const braking = input.down(...b.brake);

    out.handbrake = input.down(...b.handbrake) ? 1 : 0;
    out.ignition = true;

    switch (vehicleClass) {
      case 'wheeled':
      case 'motorcycle': {
        // Pressing back while rolling forward brakes; from rest it reverses.
        this.throttle = approach(this.throttle, Math.max(0, longitudinal), dt);
        this.steer = approach(this.steer, lateral, dt);
        out.throttle = this.throttle;
        out.steer = this.steer;
        out.brake = braking ? 1 : Math.max(0, -longitudinal);
        out.reverse = longitudinal < 0 && !braking;
        break;
      }
      case 'aircraft': {
        // Stick: pull back (S) to raise the nose, which is why `back` is +pitch.
        this.pitch = approach(this.pitch, -longitudinal, dt);
        this.roll = approach(this.roll, lateral, dt);
        this.yaw = approach(this.yaw, 0, dt);
        this.throttle = clamp(this.throttle + vertical * dt * 0.75, 0, 1);
        out.pitch = this.pitch;
        out.roll = this.roll;
        out.yaw = axis(b.handbrake, b.boost);
        out.throttle = this.throttle;
        out.brake = braking ? 1 : 0;
        out.steer = 0;
        break;
      }
      case 'helicopter': {
        this.pitch = approach(this.pitch, -longitudinal, dt);
        this.roll = approach(this.roll, lateral, dt);
        out.pitch = this.pitch;
        out.roll = this.roll;
        out.yaw = axis(b.handbrake, b.boost);
        out.collective = clamp(out.collective + vertical * dt * 0.8, 0, 1);
        out.throttle = out.collective;
        out.brake = braking ? 1 : 0;
        break;
      }
      case 'watercraft':
      case 'sailboat': {
        this.throttle = approach(this.throttle, Math.max(0, longitudinal), dt);
        this.steer = approach(this.steer, lateral, dt);
        out.throttle = this.throttle;
        out.steer = this.steer;
        out.reverse = longitudinal < 0;
        out.brake = braking ? 1 : 0;
        break;
      }
      case 'submarine': {
        this.throttle = approach(this.throttle, Math.max(0, longitudinal), dt);
        this.steer = approach(this.steer, lateral, dt);
        out.throttle = this.throttle;
        out.steer = this.steer;
        // Dive planes on the vertical axis, ballast on the boost/handbrake pair.
        out.pitch = -vertical;
        out.ballast = axis(b.boost, b.handbrake);
        out.brake = braking ? 1 : 0;
        break;
      }
      default: {
        // Exhaustive: a new vehicle class is a compile error here, not a
        // silently uncontrollable vehicle.
        const never: never = vehicleClass;
        throw new Error(`Unmapped vehicle class: ${String(never)}`);
      }
    }
    return out;
  }
}
