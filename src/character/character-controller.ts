import { Vector3 } from 'three/webgpu';
import { CharacterMotion } from './locomotion';
import type { CharacterSampler, CharacterTuning, GroundContact, MotionResult, WaterQuery } from './locomotion';
import type { AnimState } from './animation-controller';
import { clamp } from '../utils/math';

/** Walking, jogging, sprinting, crouching and swimming are distinct stances. */
export type PlayerStance = 'walk' | 'run' | 'sprint' | 'crouch';

export interface CharacterInputState {
  /** -1 (back) .. 1 (forward), camera relative. */
  forward: number;
  /** -1 (left) .. 1 (right), camera relative. */
  right: number;
  sprint: boolean;
  walk: boolean;
  crouch: boolean;
  /** Character faces the camera instead of its travel direction. */
  strafeLock: boolean;
  jumpHeld: boolean;
  jumpPressed: boolean;
}

export type CharacterEvent =
  | { type: 'character/jumped' }
  | { type: 'character/landed'; impactSpeed: number }
  | { type: 'character/water-entered' }
  | { type: 'character/water-exited' }
  | { type: 'character/stance-changed'; stance: PlayerStance }
  | { type: 'character/footstep'; surface: number; intensity: number; x: number; y: number; z: number };

export interface CharacterDiagnostics {
  stance: PlayerStance;
  animation: AnimState;
  speed: number;
  verticalSpeed: number;
  mode: MotionResult['mode'];
  grounded: boolean;
  sliding: boolean;
  distanceTravelled: number;
  /** Seconds since the character last had ground contact. */
  airTime: number;
}

const STRIDE_LENGTH: Record<PlayerStance, number> = { walk: 0.78, run: 1.32, sprint: 1.85, crouch: 0.6 };

/**
 * Turns player input into locomotion intent and chooses the animation state.
 * Owns facing, stance, landing response and footstep cadence; owns no rendering.
 */
export class CharacterController {
  readonly motion: CharacterMotion;
  readonly position: Vector3;
  yaw = 0;
  stance: PlayerStance = 'run';
  animation: AnimState = 'idle';
  distance = 0;
  lastResult: MotionResult | null = null;
  private landTimer = 0;
  private strikeAccumulator = 0;
  private readonly moveDirection = new Vector3();
  private readonly contactProbe: GroundContact = { height: 0, normal: new Vector3(0, 1, 0), biome: 0 };
  private readonly facing = new Vector3();
  onEvent?: (event: CharacterEvent) => void;

  constructor(tuning: CharacterTuning) {
    this.motion = new CharacterMotion(tuning);
    this.position = this.motion.position;
  }

  get tuning(): CharacterTuning { return this.motion.tuning; }
  get grounded(): boolean { return this.motion.grounded; }
  get swimming(): boolean { return this.motion.mode === 'swim'; }
  get speed(): number { return this.motion.horizontalSpeed; }

  /** Teleport to a world XZ; the motion solver resolves the ground height. */
  spawn(x: number, y: number, z: number): void {
    this.motion.place(x, y, z);
    this.yaw = 0;
    this.animation = 'idle';
    this.stance = 'run';
    this.landTimer = 0;
    this.strikeAccumulator = 0;
  }

  fixedUpdate(dt: number, input: CharacterInputState, cameraYaw: number, sampler: CharacterSampler, water?: WaterQuery): MotionResult {
    const forwardX = -Math.sin(cameraYaw);
    const forwardZ = -Math.cos(cameraYaw);
    const rightX = Math.cos(cameraYaw);
    const rightZ = -Math.sin(cameraYaw);
    const magnitude = Math.min(1, Math.hypot(input.forward, input.right));
    this.moveDirection.set(
      forwardX * input.forward + rightX * input.right,
      0,
      forwardZ * input.forward + rightZ * input.right,
    );
    const moving = magnitude > 0.05;
    if (moving) this.moveDirection.normalize();

    const stance = this.resolveStance(input);
    if (stance !== this.stance) {
      this.stance = stance;
      this.onEvent?.({ type: 'character/stance-changed', stance });
    }
    const stanceSpeed = this.stanceSpeed(input);
    const targetSpeed = moving ? stanceSpeed * magnitude : 0;

    const result = this.motion.step(dt, {
      x: moving ? this.moveDirection.x : 0,
      z: moving ? this.moveDirection.z : 0,
      speed: targetSpeed,
      sprint: input.sprint,
      crouch: input.crouch,
      jumpHeld: input.jumpHeld,
      jumpPressed: input.jumpPressed,
    }, sampler, water);
    this.lastResult = result;
    if (result.jumped) this.onEvent?.({ type: 'character/jumped' });
    if (result.waterEntry) this.onEvent?.({ type: 'character/water-entered' });
    if (result.waterExit) this.onEvent?.({ type: 'character/water-exited' });
    if (result.landed && result.impactSpeed > 0.4) {
      this.onEvent?.({ type: 'character/landed', impactSpeed: result.impactSpeed });
      // Harder landings hold the absorb pose longer: a readable impact response.
      this.landTimer = clamp(0.12 + result.impactSpeed * 0.022, 0.12, 0.34);
    }
    this.landTimer = Math.max(0, this.landTimer - dt);

    this.updateFacing(dt, input, cameraYaw, moving);
    this.animation = this.resolveAnimation(result, moving, input);
    this.trackFootsteps(dt, result, sampler);
    return result;
  }

  private resolveStance(input: CharacterInputState): PlayerStance {
    if (input.crouch) return 'crouch';
    if (input.sprint) return 'sprint';
    if (input.walk) return 'walk';
    return 'run';
  }

  private stanceSpeed(input: CharacterInputState): number {
    const tuning = this.tuning;
    let speed: number;
    switch (this.stance) {
      case 'crouch': speed = tuning.crouchSpeed; break;
      case 'walk': speed = tuning.walkSpeed; break;
      case 'sprint': speed = tuning.sprintSpeed; break;
      default: speed = tuning.jogSpeed;
    }
    // Facing the camera means moving sideways or backward under your own eyes:
    // those directions are slower than a forward run, and the clips say so.
    if (input.strafeLock) {
      if (input.forward < -0.5) speed = Math.min(speed, tuning.backpedalSpeed);
      else if (Math.abs(input.right) > 0.7) speed = Math.min(speed, tuning.strafeSpeed);
    }
    return speed;
  }

  private updateFacing(dt: number, input: CharacterInputState, cameraYaw: number, moving: boolean): void {
    let target = this.yaw;
    if (input.strafeLock) {
      // Facing the camera is what makes strafing and backpedalling readable.
      target = cameraYaw + Math.PI;
    } else if (moving) {
      target = Math.atan2(this.moveDirection.x, this.moveDirection.z);
    } else if (this.motion.mode !== 'swim') {
      target = this.yaw;
    }
    // Shortest-arc smoothing so a reversal turns through the body, not a snap.
    let delta = target - this.yaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const rate = input.strafeLock ? 14 : moving ? 11 : 3;
    this.yaw += delta * (1 - Math.exp(-rate * dt));
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  private resolveAnimation(result: MotionResult, moving: boolean, input: CharacterInputState): AnimState {
    if (result.mode === 'swim') return moving ? 'swim' : 'tread';
    if (result.mode === 'air' && !result.grounded) return this.motion.velocity.y > 0.4 ? 'jump' : 'fall';
    if (this.landTimer > 0) return 'land';
    if (this.stance === 'crouch') return moving ? 'crouchWalk' : 'crouchIdle';
    if (!moving) return 'idle';
    // Facing-relative direction: backpedal and strafe are real states, not relabels.
    this.facing.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const forward = this.moveDirection.x * this.facing.x + this.moveDirection.z * this.facing.z;
    const lateral = this.moveDirection.x * Math.cos(this.yaw) - this.moveDirection.z * Math.sin(this.yaw);
    if (input.strafeLock && forward < -0.45) return 'backpedal';
    if (input.strafeLock && Math.abs(lateral) > 0.7) return 'strafe';
    if (this.stance === 'sprint') return 'sprint';
    if (this.stance === 'walk') return 'walk';
    if (forward < -0.5) return 'backpedal';
    // Analog or gamepad input below jog speed reads as a walk, not a slow jog.
    return result.speed < this.tuning.walkSpeed * 0.95 ? 'walk' : 'jog';
  }

  private trackFootsteps(dt: number, result: MotionResult, sampler: CharacterSampler): void {
    if (!result.grounded || result.speed < 0.35) {
      if (result.speed < 0.05) this.strikeAccumulator = 0;
      return;
    }
    this.distance += result.speed * dt;
    this.strikeAccumulator += result.speed * dt;
    const stride = STRIDE_LENGTH[this.stance];
    if (this.strikeAccumulator < stride) return;
    this.strikeAccumulator -= stride;
    const biome = sampler.contact(this.position.x, this.position.z, this.contactProbe)?.biome ?? 0;
    this.onEvent?.({
      type: 'character/footstep',
      surface: biome,
      intensity: clamp(result.speed / this.tuning.sprintSpeed, 0.2, 1),
      x: this.position.x, y: this.position.y, z: this.position.z,
    });
  }

  /** True when the character has fallen outside any recoverable terrain. */
  fellOutOfWorld(baselineY: number): boolean {
    return this.position.y < Math.min(-1200, baselineY - 900);
  }

  diagnostics(): CharacterDiagnostics {
    return {
      stance: this.stance,
      animation: this.animation,
      speed: this.motion.horizontalSpeed,
      verticalSpeed: this.motion.velocity.y,
      mode: this.motion.mode,
      grounded: this.motion.grounded,
      sliding: this.motion.sliding,
      distanceTravelled: this.distance,
      airTime: this.motion.airTime,
    };
  }

  /** Stride-locked eye bob in metres, used by the first-person camera. */
  eyeBob(): number {
    if (!this.motion.grounded) return 0;
    const amplitude = clamp(this.motion.horizontalSpeed / this.tuning.jogSpeed, 0, 1) * 0.035;
    return Math.sin(this.distance * 6.2) * amplitude;
  }
}
