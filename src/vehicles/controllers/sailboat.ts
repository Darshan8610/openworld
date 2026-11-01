import { Vector3 } from 'three/webgpu';
import { clamp } from '../../utils/math';
import type { VehicleBody } from '../vehicle-body';
import type { VehicleControlInput, VehicleEnvironment, VehicleSpec, VehicleTelemetry } from '../types';
import { WatercraftController } from './watercraft';

/**
 * Wind-driven sailing.
 *
 * The sail is an aerofoil working in the *apparent* wind — the vector sum of
 * the true wind and the boat's own motion — which is why a sailing boat
 * accelerates into its own headwind and why its best point of sail is a reach
 * rather than a run. Three real constraints are modelled:
 *
 * - **No-go zone.** Inside `noGoAngle` of the true wind the sail luffs and
 *   produces almost nothing, so you must tack.
 * - **Keel.** A large lateral resistance converts most of the sideways sail
 *   force into forward motion; without it the boat would simply slide downwind.
 * - **Heel.** The centre of effort is above the waterline, so the sail force
 *   produces a rolling moment that the hull's righting moment opposes.
 *
 * There is no engine: throttle trims the sheet instead.
 */
export class SailboatController extends WatercraftController {
  override readonly kind = 'sailboat' as const;
  private apparentAngle = 0;
  private readonly apparent = new Vector3();
  private readonly sailForce = new Vector3();
  private readonly centre = new Vector3();

  constructor(vehicleSpec: VehicleSpec) {
    super(vehicleSpec);
    if (!vehicleSpec.sail) throw new Error(`Vehicle "${vehicleSpec.key}" is a sailboat but has no sail spec`);
  }

  /** Angle between the boat's heading and the apparent wind, radians. */
  get apparentWindAngle(): number { return this.apparentAngle; }

  /** Sails replace the propeller entirely. */
  protected override applyPropulsion(dt: number, body: VehicleBody, input: VehicleControlInput, env: VehicleEnvironment, submersion: number): void {
    const sail = this.vehicleSpec.sail!;
    // Apparent wind = true wind − boat velocity.
    this.apparent.copy(env.wind as Vector3).sub(body.velocity);
    this.apparent.y = 0;
    const windSpeed = this.apparent.length();
    this.propRate += (clamp(windSpeed / 14, 0, 1) - this.propRate) * Math.min(1, 1.5 * dt);
    if (windSpeed < 0.2 || submersion <= 0.02) return;

    const alongForward = this.apparent.dot(this.forward);
    const alongRight = this.apparent.dot(this.right);
    // 0 = wind dead ahead, π = wind astern.
    this.apparentAngle = Math.atan2(alongRight, alongForward);
    const magnitudeAngle = Math.abs(this.apparentAngle);

    // Luffing: too close to the wind and the sail stops driving.
    if (magnitudeAngle < sail.noGoAngle) {
      const luff = clamp(magnitudeAngle / sail.noGoAngle, 0, 1);
      if (luff < 0.35) return;
    }

    // Sheet trim: throttle eases the sail out. A well-trimmed sail peaks near
    // 90° of apparent wind, which makes a beam reach the quickest point of sail.
    const trim = clamp(input.throttle, 0, 1);
    const efficiency = Math.sin(clamp(magnitudeAngle, 0, Math.PI)) * (0.45 + 0.55 * trim);
    const drive = 0.5 * 1.225 * sail.area * windSpeed * windSpeed;
    const lift = drive * sail.liftSlope * efficiency;
    const drag = drive * sail.dragZero;

    // Force is mostly across the apparent wind, resolved into the boat frame.
    this.sailForce.copy(this.forward).multiplyScalar(lift * Math.sin(magnitudeAngle));
    this.sailForce.addScaledVector(this.right, Math.sign(this.apparentAngle) * lift * 0.55);
    this.sailForce.addScaledVector(this.apparent, drag / windSpeed);

    // Applied at the centre of effort up the mast — this is what heels the boat.
    this.centre.copy(body.position).addScaledVector(this.up, sail.centreHeight);
    body.addForceAtPoint(this.sailForce, this.centre);

    // The keel resists leeway, converting side force into forward progress.
    const leeway = body.velocity.dot(this.right);
    this.force.copy(this.right).multiplyScalar(-leeway * sail.keelResistance * submersion);
    body.addForce(this.force.x, this.force.y, this.force.z);
  }

  protected override writeTelemetry(
    body: VehicleBody, telemetry: VehicleTelemetry, speed: number, vForward: number,
    submersion: number, inWater: boolean, surfaceY: number,
  ): void {
    super.writeTelemetry(body, telemetry, speed, vForward, submersion, inWater, surfaceY);
    telemetry.apparentWind = this.apparentAngle;
    telemetry.engineRpm = 0;
  }
}
