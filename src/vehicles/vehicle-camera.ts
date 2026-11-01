import { Quaternion, Vector3 } from 'three/webgpu';
import { clamp, damp } from '../utils/math';
import type { Vehicle } from './vehicle';
import type { VehicleGroundSample } from './types';

/**
 * Vehicle camera rig.
 *
 * Produces a canonical world-space eye and look-at pair; the caller converts
 * to floating-origin-local exactly as it does for the character camera, so
 * nothing here needs to know about rebasing.
 *
 * Each view is a genuinely different rig rather than one chase camera with
 * different offsets: the cockpit view is rigidly bolted to the hull, the chase
 * camera trails on a spring and leans with lateral load, the cinematic camera
 * stands still and lets the vehicle drive past it.
 */
export const VEHICLE_VIEWS = ['chase', 'hood', 'cockpit', 'first-person', 'orbit', 'cinematic'] as const;
export type VehicleView = (typeof VEHICLE_VIEWS)[number];

/**
 * The vectors in a pose are owned and reused by the camera, so a pose is only
 * valid until the next `update`. Copy out anything that must outlive the call;
 * reusing them keeps the render loop allocation-free.
 */
export interface VehicleCameraPose {
  readonly eye: Vector3;
  readonly target: Vector3;
  /** Field of view in degrees; rises with speed for a sense of pace. */
  readonly fov: number;
  /** Roll about the view axis, radians — only the cockpit views use it. */
  readonly roll: number;
}

export interface VehicleCameraProbe {
  /** Terrain height used to keep the camera out of the ground. */
  ground(x: number, z: number, out: VehicleGroundSample): VehicleGroundSample;
}

interface ViewTuning {
  /** Distance behind the vehicle, in vehicle lengths. */
  readonly distance: number;
  /** Height above the hull centre, metres. */
  readonly height: number;
  readonly fov: number;
  /** How hard the rig resists following rotation; 0 = rigid. */
  readonly lag: number;
}

const TUNING: Record<VehicleView, ViewTuning> = {
  chase: { distance: 1.75, height: 1.25, fov: 62, lag: 6.5 },
  hood: { distance: -0.12, height: 0.62, fov: 66, lag: 0 },
  cockpit: { distance: 0, height: 0, fov: 70, lag: 0 },
  'first-person': { distance: 0, height: 0, fov: 74, lag: 0 },
  orbit: { distance: 2.4, height: 1.1, fov: 58, lag: 9 },
  cinematic: { distance: 3.2, height: 1.4, fov: 46, lag: 0 },
};

/** Views that sit inside the vehicle and should hide its own bodywork. */
export const INTERIOR_VIEWS: ReadonlySet<VehicleView> = new Set<VehicleView>(['cockpit', 'first-person']);

export class VehicleCamera {
  view: VehicleView = 'chase';
  /** Free-look yaw/pitch, used by `orbit` and as a glance offset elsewhere. */
  orbitYaw = 0;
  orbitPitch = -0.12;

  private readonly eye = new Vector3();
  private readonly target = new Vector3();
  private readonly smoothedEye = new Vector3();
  private readonly smoothedTarget = new Vector3();
  private readonly desired = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly scratch = new Vector3();
  private readonly orientation = new Quaternion();
  private readonly groundSample: VehicleGroundSample = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass' };
  private fov = 62;
  private roll = 0;
  private initialised = false;
  /** Fixed anchor the cinematic view holds while the vehicle drives past. */
  private readonly cinematicAnchor = new Vector3();
  private cinematicAge = 0;

  /** Jump straight to the correct pose, with no interpolation from the old one. */
  reset(): void {
    this.initialised = false;
    this.cinematicAge = 0;
  }

  cycle(): VehicleView {
    const index = VEHICLE_VIEWS.indexOf(this.view);
    this.view = VEHICLE_VIEWS[(index + 1) % VEHICLE_VIEWS.length]!;
    this.reset();
    return this.view;
  }

  setView(view: VehicleView): void {
    if (view === this.view) return;
    this.view = view;
    this.reset();
  }

  /**
   * @param alpha Render interpolation factor for the fixed step, so the camera
   *   is as smooth as the vehicle it is following and never FPS-coupled.
   */
  update(dt: number, vehicle: Vehicle, alpha: number, probe?: VehicleCameraProbe): VehicleCameraPose {
    const tuning = TUNING[this.view];
    const body = vehicle.body;
    const length = Math.max(2, vehicle.spec.dimensions.length);

    body.renderPosition(alpha, this.scratch);
    body.renderOrientation(alpha, this.orientation);
    this.forward.set(0, 0, 1).applyQuaternion(this.orientation);
    this.right.set(1, 0, 0).applyQuaternion(this.orientation);
    this.up.set(0, 1, 0).applyQuaternion(this.orientation);

    const speed = vehicle.telemetry.speed;

    if (this.view === 'cockpit' || this.view === 'first-person') {
      this.poseInterior(vehicle, tuning, speed);
    } else if (this.view === 'cinematic') {
      this.poseCinematic(dt, tuning, length, speed);
    } else {
      this.poseExterior(vehicle, tuning, length, speed);
    }

    // Keep the camera out of the ground. Interior views are already inside the
    // hull, so they are exempt — clamping them would push the driver's head
    // through the roof on a steep hill.
    if (probe && !INTERIOR_VIEWS.has(this.view)) {
      const sample = probe.ground(this.eye.x, this.eye.z, this.groundSample);
      const floor = sample.height + 0.55;
      if (this.eye.y < floor) this.eye.y = floor;
    }

    if (!this.initialised) {
      this.smoothedEye.copy(this.eye);
      this.smoothedTarget.copy(this.target);
      this.initialised = true;
    } else if (tuning.lag > 0) {
      // Critically-damped follow, frame-rate independent via `damp`.
      this.smoothedEye.set(
        damp(this.smoothedEye.x, this.eye.x, tuning.lag, dt),
        damp(this.smoothedEye.y, this.eye.y, tuning.lag, dt),
        damp(this.smoothedEye.z, this.eye.z, tuning.lag, dt),
      );
      this.smoothedTarget.set(
        damp(this.smoothedTarget.x, this.target.x, tuning.lag * 1.4, dt),
        damp(this.smoothedTarget.y, this.target.y, tuning.lag * 1.4, dt),
        damp(this.smoothedTarget.z, this.target.z, tuning.lag * 1.4, dt),
      );
    } else {
      this.smoothedEye.copy(this.eye);
      this.smoothedTarget.copy(this.target);
    }

    return { eye: this.smoothedEye, target: this.smoothedTarget, fov: this.fov, roll: this.roll };
  }

  /** Rigidly attached: the view rolls and pitches with the hull. */
  private poseInterior(vehicle: Vehicle, tuning: ViewTuning, speed: number): void {
    const seat = vehicle.driverSeat;
    const body = vehicle.body;
    if (seat) body.localPoint(seat.eye ?? seat.local, this.eye);
    else this.eye.copy(body.position).addScaledVector(this.up, vehicle.spec.dimensions.height * 0.3);

    this.target.copy(this.eye).addScaledVector(this.forward, 12);
    // Free-look inside the cabin without moving the head.
    if (this.orbitYaw !== 0 || this.orbitPitch !== -0.12) {
      this.scratch.copy(this.forward).multiplyScalar(Math.cos(this.orbitYaw));
      this.scratch.addScaledVector(this.right, Math.sin(this.orbitYaw));
      this.target.copy(this.eye).addScaledVector(this.scratch, 12).addScaledVector(this.up, this.orbitPitch * 8);
    }
    this.fov = tuning.fov + clamp(speed * 0.12, 0, 9);
    this.roll = Math.atan2(this.right.y, this.up.y);
  }

  /** Trails the vehicle and leans with lateral acceleration. */
  private poseExterior(vehicle: Vehicle, tuning: ViewTuning, length: number, speed: number): void {
    const body = vehicle.body;
    const distance = length * tuning.distance;
    const height = vehicle.spec.dimensions.height * 0.5 + tuning.height;

    // The chase rig follows the *heading* rather than the full orientation, so
    // a roll or a jump does not whip the camera around.
    const yaw = body.yaw + (this.view === 'orbit' ? this.orbitYaw : 0);
    const pitch = this.view === 'orbit' ? this.orbitPitch : -0.1;
    const flatX = Math.sin(yaw);
    const flatZ = Math.cos(yaw);

    this.desired.set(-flatX * distance, height - pitch * distance, -flatZ * distance);
    this.eye.copy(body.position).add(this.desired);

    // Aim slightly ahead at speed so the driver sees where they are going.
    const lead = clamp(speed * 0.22, 0, 9);
    this.target.copy(body.position);
    this.target.y += vehicle.spec.dimensions.height * 0.35;
    this.target.x += flatX * lead;
    this.target.z += flatZ * lead;

    this.fov = tuning.fov + clamp(speed * 0.28, 0, 16);
    this.roll = 0;
  }

  /**
   * Stands at a fixed point and lets the vehicle drive through frame, picking a
   * new vantage once it has been left behind. No path following, no dolly.
   */
  private poseCinematic(dt: number, tuning: ViewTuning, length: number, speed: number): void {
    this.cinematicAge += dt;
    const away = this.cinematicAnchor.distanceTo(this.target.copy(this.scratch));
    if (!this.initialised || this.cinematicAge > 7 || away > length * 14) {
      const side = this.cinematicAge % 2 < 1 ? 1 : -1;
      this.cinematicAnchor.copy(this.scratch);
      this.cinematicAnchor.addScaledVector(this.forward, length * tuning.distance);
      this.cinematicAnchor.addScaledVector(this.right, side * length * 1.8);
      this.cinematicAnchor.y += tuning.height + 1.1;
      this.cinematicAge = 0;
    }
    this.eye.copy(this.cinematicAnchor);
    this.target.copy(this.scratch);
    this.fov = tuning.fov + clamp(speed * 0.1, 0, 6);
    this.roll = 0;
  }
}
