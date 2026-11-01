import { Vector3 } from 'three/webgpu';
import { clamp } from '../utils/math';

/**
 * Collision-aware character locomotion.
 *
 * This is a *character controller*, not mesh translation: it owns a capsule
 * footprint, ground contact, slope classification, step climbing, coyote time,
 * jump buffering, variable jump height, momentum and gravity, and it resolves
 * motion against a sampler instead of writing a position straight from input.
 *
 * It is intentionally free of Three.js scene objects and of the rest of the game,
 * so the whole movement model is unit-tested against synthetic terrain.
 *
 * Solid world geometry (buildings, props, vehicles) plugs in through
 * `CharacterSampler.blocked()`; terrain alone is supplied by `contact()`.
 */

export type MovementMode = 'ground' | 'air' | 'swim';

export interface GroundContact {
  height: number;
  /** Surface normal at the sampled point, unit length. */
  normal: Vector3;
  /** Biome id from the terrain surface attribute, for footstep/surface logic. */
  biome: number;
}

export interface CharacterSampler {
  /** Ground height and normal under a world XZ, or undefined while not streamed. */
  contact(x: number, z: number, out: GroundContact): GroundContact | undefined;
  /** Solid obstacle test for non-terrain geometry (buildings, props, vehicles). */
  blocked?(x: number, z: number, feetY: number): boolean;
}

export interface WaterSample {
  surfaceY: number;
  /** Surface current in metres per second; rivers and tides supply this later. */
  flowX: number;
  flowZ: number;
}

export type WaterQuery = (x: number, z: number) => WaterSample | undefined;

export interface MoveIntent {
  /** Unit-length world XZ direction the character wants to travel (or 0,0). */
  x: number;
  z: number;
  /** Requested ground speed in m/s, after stance selection. */
  speed: number;
  sprint: boolean;
  crouch: boolean;
  jumpHeld: boolean;
  /** Rising edge of the jump input during this tick. */
  jumpPressed: boolean;
}

export interface CharacterTuning {
  height: number;
  radius: number;
  eyeHeight: number;
  walkSpeed: number;
  jogSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  backpedalSpeed: number;
  strafeSpeed: number;
  acceleration: number;
  deceleration: number;
  airAcceleration: number;
  gravity: number;
  jumpHeight: number;
  jumpCutMultiplier: number;
  stepHeight: number;
  groundSnap: number;
  maxSlopeDeg: number;
  slopeSlideAcceleration: number;
  coyoteTime: number;
  jumpBufferTime: number;
  /** Feet depth below a water surface at which the character starts swimming. */
  swimDepth: number;
  swimFeetDepth: number;
  swimSpeed: number;
  swimAcceleration: number;
  swimBuoyancy: number;
  swimDrag: number;
  swimVerticalSpeed: number;
  /** Guard against tunnelling through a cliff in a single tick. */
  maxHorizontalStep: number;
}

export interface MotionResult {
  mode: MovementMode;
  grounded: boolean;
  /** Slope is too steep to stand on; the character is sliding. */
  sliding: boolean;
  jumped: boolean;
  landed: boolean;
  /** Downward speed at the moment of contact (m/s). */
  impactSpeed: number;
  /** Horizontal motion was rejected by an obstacle this tick. */
  blocked: boolean;
  waterEntry: boolean;
  waterExit: boolean;
  /** Speed along the ground plane, excluding vertical motion. */
  speed: number;
}

/** Frame-rate independent exponential approach toward a target scalar. */
function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export class CharacterMotion {
  /** Canonical world position of the capsule's feet. */
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly groundNormal = new Vector3(0, 1, 0);
  mode: MovementMode = 'air';
  grounded = false;
  sliding = false;
  spawnReady = false;
  private coyote = 0;
  private jumpBuffer = 0;
  private jumpCutAvailable = false;
  /** Seconds since the character last had ground contact (fall diagnostics). */
  airTime = 0;
  private readonly contactOut: GroundContact = { height: 0, normal: new Vector3(0, 1, 0), biome: 0 };

  constructor(public readonly tuning: CharacterTuning) {}

  /** Place the capsule and clear all motion state (spawn, respawn, seed change). */
  place(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.sliding = false;
    this.mode = 'air';
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpCutAvailable = false;
    this.airTime = 0;
    this.spawnReady = true;
  }

  get eyeY(): number { return this.position.y + this.tuning.eyeHeight; }
  get horizontalSpeed(): number { return Math.hypot(this.velocity.x, this.velocity.z); }
  get slopeCosThreshold(): number { return Math.cos((this.tuning.maxSlopeDeg * Math.PI) / 180); }

  /**
   * Advance one fixed simulation tick. `dt` is seconds and must be the fixed step.
   * No render-frame coupling: identical inputs always produce identical motion.
   */
  step(dt: number, intent: MoveIntent, sampler: CharacterSampler, water?: WaterQuery): MotionResult {
    const result: MotionResult = {
      mode: this.mode, grounded: this.grounded, sliding: this.sliding, jumped: false, landed: false,
      impactSpeed: 0, blocked: false, waterEntry: false, waterExit: false, speed: 0,
    };
    if (!this.spawnReady) return result;
    const tuning = this.tuning;
    const previousMode = this.mode;

    const waterSample = water?.(this.position.x, this.position.z);
    const depth = waterSample ? waterSample.surfaceY - this.position.y : -Infinity;
    const swimming = waterSample !== undefined && depth > tuning.swimDepth;

    this.coyote = Math.max(0, this.coyote - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (intent.jumpPressed) this.jumpBuffer = tuning.jumpBufferTime;

    if (swimming && waterSample) {
      if (previousMode !== 'swim') result.waterEntry = true;
      this.mode = 'swim';
      this.grounded = false;
      this.sliding = false;
      this.airTime = 0;
      this.swim(dt, intent, waterSample, result);
      result.mode = this.mode;
      result.grounded = false;
      result.speed = Math.hypot(this.velocity.x, this.velocity.z);
      return result;
    }
    if (previousMode === 'swim') result.waterExit = true;

    // Horizontal steering.
    const hasDirection = intent.x !== 0 || intent.z !== 0;
    const dirLength = Math.hypot(intent.x, intent.z);
    const dirX = hasDirection ? intent.x / dirLength : 0;
    const dirZ = hasDirection ? intent.z / dirLength : 0;
    const supportsWeight = this.grounded;
    const support = this.grounded && !this.sliding;
    const targetSpeed = hasDirection ? intent.speed : 0;

    // Uphill costs more, downhill is assisted; steep ground bleeds speed away.
    let slopeFactor = 1;
    let slideX = 0;
    let slideZ = 0;
    if (supportsWeight && this.groundNormal.y < this.slopeCosThreshold) this.sliding = true;
    if (supportsWeight) {
      if (this.sliding) {
        // Downhill is the projection of gravity onto the slope plane.
        slideX = this.groundNormal.x * this.groundNormal.y * tuning.slopeSlideAcceleration;
        slideZ = this.groundNormal.z * this.groundNormal.y * tuning.slopeSlideAcceleration;
      } else {
        const uphill = -(dirX * this.groundNormal.x + dirZ * this.groundNormal.z);
        slopeFactor = clamp(1 - uphill * 1.35, 0.25, 1.25);
      }
    }

    const targetX = dirX * targetSpeed * slopeFactor;
    const targetZ = dirZ * targetSpeed * slopeFactor;
    // No traction while sliding: the solver stops steering toward the input and
    // lets the slope + mild friction own the horizontal motion.
    const rate = this.sliding ? 0 : support ? (targetSpeed > 0.01 ? tuning.acceleration : tuning.deceleration) : tuning.airAcceleration;
    const maxDelta = rate * dt;
    this.velocity.x = approach(this.velocity.x, targetX, maxDelta);
    this.velocity.z = approach(this.velocity.z, targetZ, maxDelta);
    if (slideX !== 0 || slideZ !== 0) {
      this.velocity.x += slideX * dt;
      this.velocity.z += slideZ * dt;
      const drag = Math.min(0.5, dt * 1.2);
      this.velocity.x *= 1 - drag;
      this.velocity.z *= 1 - drag;
    }

    // Jump: buffered input, coyote grace, and variable height while rising.
    if (this.jumpBuffer > 0 && (support || this.coyote > 0)) {
      this.velocity.y = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight);
      this.grounded = false;
      this.sliding = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.jumpCutAvailable = true;
      result.jumped = true;
    }
    if (!intent.jumpHeld && this.jumpCutAvailable && this.velocity.y > 0) {
      this.velocity.y *= tuning.jumpCutMultiplier;
      this.jumpCutAvailable = false;
    }

    if (this.grounded) {
      // Keep a little downward pressure so the capsule stays glued on descents.
      this.velocity.y = Math.min(0, this.velocity.y);
    } else {
      this.airTime += dt;
      this.velocity.y -= tuning.gravity * dt;
    }

    // Horizontal integration with a tunnelling guard and axis-separated sliding.
    const stepX = this.velocity.x * dt;
    const stepZ = this.velocity.z * dt;
    const stepLength = Math.hypot(stepX, stepZ);
    const clampScale = stepLength > tuning.maxHorizontalStep ? tuning.maxHorizontalStep / stepLength : 1;
    const moveX = stepX * clampScale;
    const moveZ = stepZ * clampScale;

    const blockedAt = (nx: number, nz: number): boolean =>
      sampler.blocked?.(nx, nz, this.position.y) === true;

    let nextX = this.position.x + moveX;
    let nextZ = this.position.z + moveZ;
    let contact = sampler.contact(nextX, nextZ, this.contactOut);
    if (blockedAt(nextX, nextZ) || this.tooHighToStep(contact, support)) {
      // Try each axis alone so the character slides along walls instead of sticking.
      const axisX = sampler.contact(nextX, this.position.z, this.contactOut);
      if (!blockedAt(nextX, this.position.z) && !this.tooHighToStep(axisX, support)) {
        nextZ = this.position.z;
        contact = axisX;
        this.velocity.z = 0;
      } else {
        const axisZ = sampler.contact(this.position.x, nextZ, this.contactOut);
        if (!blockedAt(this.position.x, nextZ) && !this.tooHighToStep(axisZ, support)) {
          nextX = this.position.x;
          contact = axisZ;
          this.velocity.x = 0;
        } else {
          nextX = this.position.x;
          nextZ = this.position.z;
          contact = sampler.contact(nextX, nextZ, this.contactOut);
          this.velocity.x = 0;
          this.velocity.z = 0;
          result.blocked = true;
        }
      }
    }
    this.position.x = nextX;
    this.position.z = nextZ;

    // Vertical resolution against the ground.
    if (!contact) {
      // Terrain ahead is not streamed yet: hold height and keep the fall state.
      this.grounded = false;
      this.sliding = false;
      this.mode = 'air';
      result.mode = this.mode;
      result.grounded = false;
      result.sliding = false;
      result.speed = Math.hypot(this.velocity.x, this.velocity.z);
      return result;
    }

    this.position.y += this.velocity.y * dt;
    const groundY = contact.height;
    const walkable = contact.normal.y >= this.slopeCosThreshold;

    if (this.position.y <= groundY) {
      // In contact with the surface. Steep ground still counts as contact; it is
      // the `sliding` flag that removes traction and adds downhill acceleration.
      const impact = -this.velocity.y;
      if (!this.grounded && impact > 0.5) {
        result.landed = true;
        result.impactSpeed = Math.max(0, impact);
      }
      this.position.y = groundY;
      this.velocity.y = 0;
      this.grounded = true;
      this.sliding = !walkable;
      this.airTime = 0;
      if (!this.sliding) this.coyote = tuning.coyoteTime;
    } else if (this.grounded) {
      const drop = this.position.y - groundY;
      // Walkable ground is sticky within the snap distance; steep ground lets the
      // body follow the surface while it slides. Beyond that, we are airborne.
      const snap = walkable ? tuning.groundSnap : tuning.groundSnap * 1.5;
      if (drop <= snap) {
        this.position.y = groundY;
        this.velocity.y = 0;
        this.sliding = !walkable;
        if (!this.sliding) this.coyote = tuning.coyoteTime;
      } else {
        this.grounded = false;
        this.sliding = false;
      }
    } else {
      this.sliding = false;
    }

    if (this.grounded) {
      this.groundNormal.copy(contact.normal);
      this.mode = 'ground';
      this.airTime = 0;
    } else {
      this.mode = 'air';
    }
    result.mode = this.mode;
    result.grounded = this.grounded;
    result.sliding = this.sliding;
    result.speed = Math.hypot(this.velocity.x, this.velocity.z);
    return result;
  }

  private tooHighToStep(contact: GroundContact | undefined, support: boolean): boolean {
    if (!support || !contact) return false;
    const rise = contact.height - this.position.y;
    if (rise > this.tuning.stepHeight) return true;
    // Steep ground behaves like a wall for horizontal motion: you cannot walk up
    // it, you slide along it. Only walkable terrain is stepped onto.
    return rise > 0.02 && contact.normal.y < this.slopeCosThreshold;
  }

  private swim(dt: number, intent: MoveIntent, sample: WaterSample, result: MotionResult): void {
    const tuning = this.tuning;
    const targetY = sample.surfaceY - tuning.swimFeetDepth;
    const dirLength = Math.hypot(intent.x, intent.z);
    const targetX = dirLength > 0 ? (intent.x / dirLength) * intent.speed : 0;
    const targetZ = dirLength > 0 ? (intent.z / dirLength) * intent.speed : 0;
    const rate = intent.speed > 0.01 ? tuning.swimAcceleration : tuning.swimAcceleration * 0.7;
    this.velocity.x = approach(this.velocity.x, targetX, rate * dt);
    this.velocity.z = approach(this.velocity.z, targetZ, rate * dt);
    // Current drags the body; rivers and tides set this later.
    this.velocity.x += sample.flowX * dt * 0.9;
    this.velocity.z += sample.flowZ * dt * 0.9;
    // Buoyancy is a spring toward neutral buoyancy plus vertical drag.
    const verticalTarget = (targetY - this.position.y) * 1.6;
    const climb = intent.jumpHeld ? tuning.swimVerticalSpeed : intent.crouch ? -tuning.swimVerticalSpeed : clamp(verticalTarget, -tuning.swimVerticalSpeed * 0.5, tuning.swimVerticalSpeed);
    this.velocity.y = approach(this.velocity.y, climb, tuning.swimBuoyancy * dt);
    this.velocity.y *= 1 - clamp(tuning.swimDrag * dt, 0, 0.6);
    this.velocity.x *= 1 - clamp(tuning.swimDrag * 0.35 * dt, 0, 0.5);
    this.velocity.z *= 1 - clamp(tuning.swimDrag * 0.35 * dt, 0, 0.5);
    this.position.addScaledVector(this.velocity, dt);
    result.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }
}
