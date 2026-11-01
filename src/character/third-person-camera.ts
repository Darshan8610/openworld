import { Euler, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { clamp, damp } from '../utils/math';

/** Aspect ratio from the viewport, with a headless fallback for unit tests. */
function viewportAspect(): number {
  return typeof innerWidth === 'number' && typeof innerHeight === 'number' && innerHeight > 0
    ? innerWidth / innerHeight
    : 16 / 9;
}

/** Ground and solid-geometry probes supplied by the world, in world space. */
export interface CameraProbe {
  groundHeight(x: number, z: number): number | undefined;
  /**
   * Distance to the nearest solid surface along a world-space ray, or Infinity.
   * Buildings and props register here once world colliders exist (Phase 7).
   */
  raycast?(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): number;
}

export interface CameraTarget {
  x: number;
  y: number;
  z: number;
  /** Height of the look anchor above the feet. */
  anchorHeight: number;
  speed: number;
  swimming: boolean;
  /** Vertical speed, used for airborne camera lag. */
  verticalSpeed: number;
}

export interface CameraSettings {
  fov: number;
  minDistance: number;
  maxDistance: number;
  defaultDistance: number;
  shoulderOffset: number;
  pitchMin: number;
  pitchMax: number;
  sensitivity: number;
  collisionRadius: number;
  fovSpeedGain: number;
  firstPersonFov: number;
}

/**
 * Third-person orbit camera with terrain and solid-geometry avoidance, shoulder
 * swapping, zoom, first-person mode, speed FOV and landing shake.
 *
 * Orbiting is pure camera behaviour: the character controller owns facing, so the
 * camera never drags the body through walls. All math is world-space; the final
 * render position is converted to floating-origin-local by the caller.
 */
export class ThirdPersonCamera {
  readonly camera: PerspectiveCamera;
  yaw = Math.PI;
  pitch = -0.16;
  distance: number;
  firstPerson = false;
  shoulder = 1;
  sensitivity: number;
  private fov: number;
  private readonly anchor = new Vector3();
  private anchored = false;
  private currentDistance: number;
  private shake = 0;
  private shakeTime = 0;
  private readonly desired = new Vector3();
  private readonly offset = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly forward = new Vector3();
  private readonly right = new Vector3();

  constructor(private readonly settings: CameraSettings) {
    this.camera = new PerspectiveCamera(settings.fov, viewportAspect(), 0.1, 40000);
    this.distance = settings.defaultDistance;
    this.currentDistance = settings.defaultDistance;
    this.sensitivity = settings.sensitivity;
    this.fov = settings.fov;
  }

  /** Mouse/stick look, in raw pixels (already scaled by user sensitivity). */
  look(deltaX: number, deltaY: number): void {
    const scale = 0.0022 * this.sensitivity;
    this.yaw -= deltaX * scale;
    this.pitch = clamp(this.pitch - deltaY * scale, this.settings.pitchMin, this.settings.pitchMax);
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  /** Wheel or stick zoom; positive values pull the camera in. */
  zoom(amount: number): void {
    if (this.firstPerson) return;
    this.distance = clamp(this.distance * 0.88 ** amount, this.settings.minDistance, this.settings.maxDistance);
  }

  toggleShoulder(): void { this.shoulder = this.shoulder === 0 ? 1 : this.shoulder === 1 ? -1 : 0; }

  setFirstPerson(enabled: boolean): void {
    this.firstPerson = enabled;
    if (!enabled) this.currentDistance = this.distance;
  }

  addShake(amount: number): void {
    this.shake = Math.min(0.5, this.shake + amount);
    this.shakeTime = 0;
  }

  /** Direction the camera is looking, unit length (world space). */
  lookDirection(target = new Vector3()): Vector3 {
    const cos = Math.cos(this.pitch);
    return target.set(-Math.sin(this.yaw) * cos, Math.sin(this.pitch), -Math.cos(this.yaw) * cos);
  }

  /** Yaw the character should adopt to face away from the camera. */
  get bodyYaw(): number { return this.yaw + Math.PI; }

  /**
   * Solve the camera for this frame and write a floating-origin-local position.
   * Returns the local position so callers can feed the active camera to the post
   * chain without re-deriving it.
   */
  update(dt: number, target: CameraTarget, probe: CameraProbe, originAbsolute: Vector3, localOut = new Vector3()): Vector3 {
    const settings = this.settings;
    // First person sits exactly at eye height; third person anchors on the chest.
    const anchorHeight = target.anchorHeight;
    this.desired.set(target.x, target.y + anchorHeight, target.z);
    if (!this.anchored) {
      this.anchor.copy(this.desired);
      this.anchored = true;
    } else {
      // Follow with a little lag so fast gait changes read as momentum, not snap.
      const rate = target.verticalSpeed < -6 ? 26 : 16;
      this.anchor.x = damp(this.anchor.x, this.desired.x, rate, dt);
      this.anchor.z = damp(this.anchor.z, this.desired.z, rate, dt);
      this.anchor.y = damp(this.anchor.y, this.desired.y, target.verticalSpeed < -6 ? 12 : 14, dt);
    }

    const forward = this.lookDirection(this.forward);
    const right = this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this.shakeTime += dt;
    const shake = this.shake * Math.exp(-this.shakeTime * 7);
    this.shake = Math.max(0, this.shake - dt * 1.6);

    if (this.firstPerson) {
      localOut.copy(this.anchor).sub(originAbsolute);
      this.euler.set(this.pitch + shake * 0.6, this.yaw, 0);
      this.camera.quaternion.setFromEuler(this.euler);
      this.camera.position.copy(localOut);
      this.applyFov(dt, target, settings.firstPersonFov);
      return localOut;
    }

    // Boom: camera sits opposite the look direction, offset to the shoulder.
    const boom = this.offset.copy(forward).negate().normalize();
    const shoulder = settings.shoulderOffset * this.shoulder;
    const available = this.solveDistance(this.anchor, boom, probe);
    // Pull in immediately so the camera can never render inside a wall; ease out.
    this.currentDistance = available < this.currentDistance
      ? available
      : damp(this.currentDistance, available, 6, dt);

    const camX = this.anchor.x + right.x * shoulder + boom.x * this.currentDistance;
    const camZ = this.anchor.z + right.z * shoulder + boom.z * this.currentDistance;
    let camY = this.anchor.y + boom.y * this.currentDistance;
    const ground = probe.groundHeight(camX, camZ);
    if (ground !== undefined) camY = Math.max(camY, ground + 0.45);
    localOut.set(camX - originAbsolute.x, camY - originAbsolute.y, camZ - originAbsolute.z);

    this.euler.set(this.pitch + shake * 0.5, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.position.copy(localOut);
    this.applyFov(dt, target, settings.fov);
    return localOut;
  }

  /** March the boom and shorten it to the first occlusion (terrain or collider). */
  private solveDistance(anchor: Vector3, boom: Vector3, probe: CameraProbe): number {
    const radius = this.settings.collisionRadius;
    const requested = clamp(this.distance, this.settings.minDistance, this.settings.maxDistance);
    let limit = requested;
    if (probe.raycast) {
      const hit = probe.raycast(anchor.x, anchor.y, anchor.z, boom.x, boom.y, boom.z, requested + radius);
      if (hit < limit) limit = Math.max(this.settings.minDistance * 0.5, hit - radius);
    }
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = (requested * i) / steps;
      const x = anchor.x + boom.x * t;
      const y = anchor.y + boom.y * t;
      const z = anchor.z + boom.z * t;
      const ground = probe.groundHeight(x, z);
      if (ground !== undefined && y < ground + radius) {
        limit = Math.min(limit, Math.max(this.settings.minDistance * 0.5, t - requested / steps));
        break;
      }
    }
    return Math.max(this.settings.minDistance * 0.5, limit);
  }

  private applyFov(dt: number, target: CameraTarget, base: number): void {
    const gain = clamp(target.speed / 9, 0, 1) * this.settings.fovSpeedGain + (target.swimming ? -2 : 0);
    const desired = base + gain;
    this.fov = damp(this.fov, desired, 4, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  resize(): void {
    this.camera.aspect = viewportAspect();
    this.camera.updateProjectionMatrix();
  }

  /** Drop smoothing state, e.g. after a teleport or seed change. */
  reset(): void {
    this.anchored = false;
    this.currentDistance = this.distance;
    this.shake = 0;
  }
}
