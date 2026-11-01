import { clamp } from '../../utils/math';
import type { VehicleBody } from '../vehicle-body';
import type { VehicleControlInput, VehicleEnvironment, VehicleSpec, VehicleTelemetry } from '../types';
import { WatercraftController } from './watercraft';

/**
 * Submarine: ballast-controlled depth plus dive planes.
 *
 * A submarine does not fly underwater. Depth is held by trimming ballast
 * toward neutral buoyancy, and changed either slowly with ballast or quickly
 * with dive planes — which, like a rudder, only work when there is flow over
 * them. Blowing ballast at depth makes it rise whether or not it is moving;
 * pitching the planes down at zero speed does nothing.
 */
export class SubmarineController extends WatercraftController {
  override readonly kind = 'submarine' as const;
  /** 0 = tanks blown (positively buoyant), 1 = flooded (negatively buoyant). */
  private ballast = 0.5;

  constructor(vehicleSpec: VehicleSpec) {
    super(vehicleSpec);
    if (!vehicleSpec.submarine) throw new Error(`Vehicle "${vehicleSpec.key}" is a submarine but has no submarine spec`);
  }

  get ballastLevel(): number { return this.ballast; }

  override reset(): void {
    super.reset();
    this.ballast = 0.5;
  }

  /** Ballast is integrated over time, so trimming is a deliberate action. */
  protected override verticalBias(input: VehicleControlInput, dt: number): number {
    const spec = this.vehicleSpec.submarine!;
    this.ballast = clamp(this.ballast + clamp(input.ballast, -1, 1) * spec.ballastRate * dt, 0, 1);
    // 0.5 is neutral; the swing is symmetric about it.
    return -(this.ballast - 0.5) * 2 * spec.ballastForce;
  }

  protected override applyPropulsion(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, submersion: number): void {
    super.applyPropulsion(dt, body, input, env, submersion);
    const spec = this.vehicleSpec.submarine!;
    const flow = body.velocity.dot(this.forward);
    // Dive planes: pitch authority proportional to flow, like any control surface.
    const planes = clamp(input.pitch, -1, 1) * spec.planeAuthority * flow * submersion;
    if (planes !== 0) {
      body.addTorque(this.right.x * planes, this.right.y * planes, this.right.z * planes);
    }
    // Crush depth: below it the hull takes damage, reported through telemetry.
    void spec.maxDepth;
  }

  /** A submerged boat should not be forced upright as hard as a surface hull. */
  protected override applyRighting(body: VehicleBody, submersion: number): void {
    super.applyRighting(body, submersion * 0.45);
  }

  protected override writeTelemetry(
    body: VehicleBody, telemetry: VehicleTelemetry, speed: number, vForward: number,
    submersion: number, inWater: boolean, surfaceY: number,
  ): void {
    super.writeTelemetry(body, telemetry, speed, vForward, submersion, inWater, surfaceY);
    telemetry.depth = inWater ? Math.max(0, surfaceY - body.position.y) : 0;
  }

  /** Exceeded the design depth; the vehicle layer turns this into damage. */
  overDepth(telemetry: VehicleTelemetry): boolean {
    return telemetry.depth > this.vehicleSpec.submarine!.maxDepth;
  }
}
