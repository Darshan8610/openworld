import type { Vector3 } from 'three/webgpu';
import type { VehicleBody } from '../vehicle-body';
import type {
  VehicleClass, VehicleControlInput, VehicleEnvironment, VehicleSpec, VehicleTelemetry,
} from '../types';

/** Per-wheel presentation state the renderer reads; also useful for tests. */
export interface WheelView {
  readonly id: string;
  /** Suspension extension from the attach point, metres. */
  suspensionLength: number;
  /** Steering angle, radians. */
  steer: number;
  /** Accumulated spin for the visual, radians. */
  spin: number;
  /** Wheel angular velocity, rad/s. */
  omega: number;
  grounded: boolean;
  /** Normal load, newtons. */
  load: number;
  /** Friction-ellipse saturation; ≥ 1 means the tyre is sliding. */
  slip: number;
}

/**
 * One physics model per vehicle family.
 *
 * Every controller receives the same body, controls and environment and writes
 * the same telemetry, but nothing is shared between the models themselves: a
 * car integrates tyre forces, an aeroplane integrates aerodynamic forces, a
 * boat integrates buoyancy. That is the whole point of the interface.
 */
export interface VehicleController {
  readonly kind: VehicleClass;
  /** Advance one fixed step, accumulating forces on `body`. */
  step(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, telemetry: VehicleTelemetry): void;
  /** Return to a rest state (respawn, recovery, teleport). */
  reset(): void;
  /** Wheels/skids for rendering; empty for vehicles without them. */
  readonly wheels: readonly WheelView[];
  /** Spinning visual parts (propellers, rotors) as a 0..1 rate, for rendering. */
  readonly rotorRate: number;
  /** Control-surface deflections for rendering, radians. */
  readonly surfaceDeflection: { pitch: number; roll: number; yaw: number };
}

/** Shared helper: quadratic drag against a reference area. */
export function applyQuadraticDrag(body: VehicleBody, density: number, area: number, drag: number, scratch: Vector3): void {
  const speed = body.velocity.length();
  if (speed < 1e-3) return;
  const magnitude = 0.5 * density * drag * area * speed * speed;
  scratch.copy(body.velocity).multiplyScalar(-magnitude / speed);
  body.addForce(scratch.x, scratch.y, scratch.z);
}

/** Air density falls off with altitude (ISA-like exponential approximation). */
export function airDensityAt(altitude: number): number {
  return 1.225 * Math.exp(-Math.max(0, altitude) / 8500);
}

export const spec = (value: VehicleSpec): VehicleSpec => value;
