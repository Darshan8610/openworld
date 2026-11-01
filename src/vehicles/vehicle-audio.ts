import type { Vehicle } from './vehicle';
import type { SurfaceKind } from '../physics/surfaces';

/**
 * Vehicle audio hooks.
 *
 * This module deliberately contains no audio engine. It derives a normalised
 * set of continuous signals and discrete events from vehicle telemetry, which
 * a sound backend can map to samples or synthesis however it likes. Keeping it
 * data-only means the physics has no dependency on audio, the signals are unit
 * testable, and a silent build costs nothing.
 *
 * Continuous channels are 0..1 gains plus a pitch ratio; discrete events fire
 * once per occurrence and are drained by the consumer.
 */
export type VehicleSoundChannel =
  | 'engine' | 'transmission' | 'tyre' | 'skid' | 'suspension'
  | 'rotor' | 'propeller' | 'wind' | 'water' | 'wake';

export interface ChannelSignal {
  /** 0..1 loudness. */
  gain: number;
  /** Playback rate relative to the sample's natural pitch. */
  pitch: number;
}

export type VehicleSoundEventKind = 'impact' | 'gear-shift' | 'start' | 'stop' | 'splash' | 'touchdown' | 'surface-change';

export interface VehicleSoundEvent {
  readonly kind: VehicleSoundEventKind;
  /** 0..1 intensity. */
  readonly intensity: number;
  readonly surface?: SurfaceKind;
}

const CHANNELS: readonly VehicleSoundChannel[] = [
  'engine', 'transmission', 'tyre', 'skid', 'suspension',
  'rotor', 'propeller', 'wind', 'water', 'wake',
];

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Derives audio signals for one vehicle. Holds the small amount of state
 * needed to detect edges (gear changes, landings, surface transitions) without
 * the consumer having to diff telemetry itself.
 */
export class VehicleAudioHooks {
  readonly channels: Record<VehicleSoundChannel, ChannelSignal>;
  private readonly pending: VehicleSoundEvent[] = [];
  private lastGear = 0;
  private lastGrounded = 1;
  private lastSubmersion = 0;
  private lastSurface: SurfaceKind | undefined;
  private readonly lastSuspension: number[] = [];
  private running = false;

  constructor() {
    this.channels = {} as Record<VehicleSoundChannel, ChannelSignal>;
    for (const channel of CHANNELS) this.channels[channel] = { gain: 0, pitch: 1 };
  }

  /** Discrete events since the last drain. The array is reused, so copy if kept. */
  drainEvents(out: VehicleSoundEvent[] = []): VehicleSoundEvent[] {
    out.length = 0;
    for (const event of this.pending) out.push(event);
    this.pending.length = 0;
    return out;
  }

  reset(): void {
    for (const channel of CHANNELS) {
      this.channels[channel].gain = 0;
      this.channels[channel].pitch = 1;
    }
    this.pending.length = 0;
    this.lastGear = 0;
    this.lastGrounded = 1;
    this.lastSubmersion = 0;
    this.lastSurface = undefined;
    this.lastSuspension.length = 0;
    this.running = false;
  }

  /** Recompute every channel from the current telemetry. */
  update(vehicle: Vehicle): void {
    const t = vehicle.telemetry;
    const spec = vehicle.spec;
    const c = this.channels;

    // ---- Engine and transmission ---------------------------------------------
    const drivetrain = spec.drivetrain;
    if (drivetrain && drivetrain.maxRpm > 0) {
      const normalised = clamp01(t.engineRpm / drivetrain.maxRpm);
      const alive = t.engineRpm > drivetrain.idleRpm * 0.35;
      c.engine.gain = alive ? 0.25 + 0.75 * clamp01(t.load * 0.6 + normalised * 0.6) : 0;
      // Half an octave below idle up to a little over double at the limiter.
      c.engine.pitch = 0.55 + normalised * 1.55;
      c.transmission.gain = alive ? clamp01(normalised * 0.4) : 0;
      c.transmission.pitch = 0.8 + normalised * 0.7;

      if (alive !== this.running) {
        this.pending.push({ kind: alive ? 'start' : 'stop', intensity: 1 });
        this.running = alive;
      }
      if (t.gear !== this.lastGear) {
        if (this.lastGear !== 0 && t.gear !== 0) {
          this.pending.push({ kind: 'gear-shift', intensity: clamp01(0.35 + normalised * 0.65) });
        }
        this.lastGear = t.gear;
      }
    } else {
      c.engine.gain = 0;
      c.transmission.gain = 0;
    }

    // ---- Tyres and suspension -------------------------------------------------
    const rolling = t.grounded > 0 ? clamp01(t.speed / Math.max(4, spec.topSpeed * 0.55)) : 0;
    c.tyre.gain = rolling * t.grounded;
    c.tyre.pitch = 0.7 + rolling * 0.9;
    // Skid is gated on how fast the contact patch is sliding, not on how fast
    // the vehicle is going: a burnout from a standstill is loud, and a car
    // coasting at 30 m/s with the tyres gripping is not.
    const slide = this.slipSpeed(vehicle);
    c.skid.gain = t.grounded > 0 && t.slip > 0.35
      ? clamp01((t.slip - 0.35) / 0.45) * clamp01(slide / 3.5)
      : 0;
    c.skid.pitch = 0.85 + clamp01(t.slip) * 0.5;
    c.suspension.gain = clamp01(this.suspensionActivity(vehicle) * 2.2);
    c.suspension.pitch = 1;

    if (t.grounded > 0 && this.lastSurface !== undefined && t.surface !== this.lastSurface && t.speed > 1.5) {
      this.pending.push({ kind: 'surface-change', intensity: clamp01(t.speed / 20), surface: t.surface });
    }
    if (t.grounded > 0) this.lastSurface = t.surface;

    // Touchdown: wheels (or hull) finding the ground again after being airborne.
    if (t.grounded > 0.1 && this.lastGrounded <= 0.1) {
      this.pending.push({
        kind: 'touchdown',
        intensity: clamp01(Math.abs(t.verticalSpeed) / 9),
        surface: t.surface,
      });
    }
    this.lastGrounded = t.grounded;

    // ---- Rotors and propellers -------------------------------------------------
    c.rotor.gain = clamp01(t.rotorRpm);
    c.rotor.pitch = 0.5 + clamp01(t.rotorRpm) * 0.75;
    const prop = spec.aero?.propeller ? vehicle.controller.rotorRate : 0;
    c.propeller.gain = clamp01(prop);
    c.propeller.pitch = 0.6 + clamp01(prop) * 0.9;

    // ---- Wind ------------------------------------------------------------------
    // Airspeed, not ground speed: a hover in a gale is loud, a dive is louder.
    const windRef = Math.max(12, spec.topSpeed);
    c.wind.gain = clamp01((t.airspeed - 4) / windRef);
    c.wind.pitch = 0.75 + clamp01(t.airspeed / windRef) * 0.8;

    // ---- Water ------------------------------------------------------------------
    c.water.gain = t.submersion > 0 ? clamp01(0.15 + t.submersion * 0.5) : 0;
    c.water.pitch = 1;
    c.wake.gain = t.submersion > 0 ? clamp01(t.speed / Math.max(4, spec.topSpeed * 0.6)) : 0;
    c.wake.pitch = 0.8 + clamp01(t.speed / Math.max(4, spec.topSpeed)) * 0.6;

    if (t.submersion > 0.05 && this.lastSubmersion <= 0.05) {
      this.pending.push({ kind: 'splash', intensity: clamp01(Math.abs(t.verticalSpeed) / 7 + 0.2) });
    }
    this.lastSubmersion = t.submersion;

    // Bound the queue: a pathological frame must never grow it without limit.
    if (this.pending.length > 16) this.pending.splice(0, this.pending.length - 16);
  }

  /**
   * Mean speed at which the contact patches are sliding over the ground, m/s.
   * Longitudinal slip comes from the difference between rim speed and road
   * speed; lateral slip is folded in through the saturation figure.
   */
  private slipSpeed(vehicle: Vehicle): number {
    const wheels = vehicle.controller.wheels;
    const spec = vehicle.spec.wheels;
    if (!spec || wheels.length === 0) return vehicle.telemetry.speed;
    let total = 0;
    let counted = 0;
    const road = vehicle.telemetry.forwardSpeed;
    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i]!;
      if (!wheel.grounded) continue;
      const radius = spec[i]?.radius ?? 0.3;
      total += Math.abs(wheel.omega * radius - road);
      counted++;
    }
    return counted > 0 ? total / counted : 0;
  }

  /**
   * Mean rate of suspension travel, m/s, measured by differencing the wheel
   * extensions. Derived here rather than in the controller so the physics
   * carries no audio bookkeeping.
   */
  private suspensionActivity(vehicle: Vehicle): number {
    const wheels = vehicle.controller.wheels;
    if (wheels.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < wheels.length; i++) {
      const length = wheels[i]!.suspensionLength;
      const previous = this.lastSuspension[i];
      if (previous !== undefined) total += Math.abs(length - previous);
      this.lastSuspension[i] = length;
    }
    this.lastSuspension.length = wheels.length;
    return total / wheels.length;
  }

  /** Called by the vehicle's damage hook; impacts are not derivable from telemetry. */
  reportImpact(severity: number): void {
    this.pending.push({ kind: 'impact', intensity: clamp01(severity) });
    if (this.pending.length > 16) this.pending.splice(0, this.pending.length - 16);
  }
}
