import { AnimationAction, AnimationClip, AnimationMixer, Euler, LoopOnce, LoopRepeat, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import type { Bone } from 'three/webgpu';
import type { RigBoneMap, RigSemantic } from './rig';

/** Animation states are named after the locomotion they depict, not after assets. */
export type AnimState =
  | 'idle' | 'walk' | 'jog' | 'sprint' | 'backpedal' | 'strafe'
  | 'crouchIdle' | 'crouchWalk' | 'jump' | 'fall' | 'land' | 'swim' | 'tread';

export interface ClipDefinition {
  clip: AnimationClip;
  loop: boolean;
  /** Speed the clip was authored for; used to scale playback with gait speed. */
  designSpeed: number;
  source: 'placeholder' | 'gltf';
}

export interface AnimationControllerOptions {
  /** Apply hips XZ translation from the clip to gameplay (imported root motion). */
  rootMotion?: boolean;
}

/**
 * Owns the mixer and the action set. Gameplay asks for a semantic state; the
 * controller handles cross-fades, playback rate and loop policy. Nothing here
 * knows about vehicles, NPCs or the camera.
 */
export class AnimationController {
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<AnimState, AnimationAction>();
  private readonly definitions = new Map<AnimState, ClipDefinition>();
  private current: AnimState | null = null;
  private currentRate = 1;
  private readonly hipsWorld = new Vector3();
  private readonly hipsLocal = new Vector3();
  private readonly baseQuaternions = new Map<RigSemantic, Quaternion>();
  private readonly offsetEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly offsetQuat = new Quaternion();
  private readonly previousHips = new Vector3();
  private readonly rootMotion = new Vector3();
  private hasPreviousHips = false;
  rootMotionEnabled: boolean;

  constructor(private readonly root: Object3D, private readonly bones: RigBoneMap, clips: Iterable<[AnimState, ClipDefinition]>, options: AnimationControllerOptions = {}) {
    this.mixer = new AnimationMixer(root);
    this.rootMotionEnabled = options.rootMotion ?? false;
    for (const [state, definition] of clips) {
      this.definitions.set(state, definition);
      const action = this.mixer.clipAction(definition.clip);
      action.loop = definition.loop ? LoopRepeat : LoopOnce;
      action.clampWhenFinished = !definition.loop;
      action.enabled = true;
      action.setEffectiveWeight(0);
      this.actions.set(state, action);
    }
  }

  get available(): AnimState[] { return [...this.actions.keys()]; }
  get active(): AnimState | null { return this.current; }
  get playbackRate(): number { return this.currentRate; }
  get time(): number { return this.current ? (this.actions.get(this.current)?.time ?? 0) : 0; }

  /**
   * Blend to a state. `speed` is metres per second; looping gaits scale their
   * playback rate against the speed they were authored for so feet do not skate.
   */
  play(state: AnimState, fade = 0.22, speed?: number): void {
    const action = this.actions.get(state);
    const definition = this.definitions.get(state);
    if (!action || !definition) return;
    let rate = 1;
    if (speed !== undefined && definition.designSpeed > 0) {
      rate = Math.min(1.65, Math.max(0.62, speed / definition.designSpeed));
    }
    if (this.current === state) {
      action.setEffectiveTimeScale(rate);
      this.currentRate = rate;
      return;
    }
    const previous = this.current ? this.actions.get(this.current) : undefined;
    action.reset();
    action.setEffectiveTimeScale(rate);
    action.setEffectiveWeight(1);
    if (previous && fade > 0) {
      action.play();
      previous.crossFadeTo(action, fade, true);
    } else {
      previous?.fadeOut(Math.max(0.05, fade));
      action.fadeIn(Math.max(0.05, fade)).play();
    }
    this.current = state;
    this.currentRate = rate;
    this.hasPreviousHips = false;
  }

  /** Restart a non-looping state (landing, jump) even if it is already active. */
  restart(state: AnimState, fade = 0.08): void {
    const action = this.actions.get(state);
    if (!action) return;
    action.reset();
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.play();
    if (this.current && this.current !== state) {
      this.actions.get(this.current)?.crossFadeTo(action, fade, true);
    }
    this.current = state;
    this.currentRate = 1;
    this.hasPreviousHips = false;
  }

  update(dt: number): void {
    this.mixer.update(dt);
    for (const [semantic, bone] of this.bones) {
      const stored = this.baseQuaternions.get(semantic);
      if (stored) stored.copy(bone.quaternion);
      else this.baseQuaternions.set(semantic, bone.quaternion.clone());
    }
    if (!this.rootMotionEnabled) return;
    const hips = this.bones.get('hips');
    if (!hips) return;
    this.root.updateMatrixWorld(true);
    hips.getWorldPosition(this.hipsWorld);
    this.hipsLocal.copy(this.root.worldToLocal(this.hipsWorld.clone()));
    if (this.hasPreviousHips) {
      // Vertical bob belongs to the clip; only horizontal drift is gameplay motion.
      this.rootMotion.x += this.hipsLocal.x - this.previousHips.x;
      this.rootMotion.z += this.hipsLocal.z - this.previousHips.z;
    }
    this.previousHips.copy(this.hipsLocal);
    this.hasPreviousHips = true;
  }

  consumeRootMotion(target: Vector3): boolean {
    if (this.rootMotion.lengthSq() < 1e-8) return false;
    target.copy(this.rootMotion);
    this.rootMotion.set(0, 0, 0);
    return true;
  }

  /** Post-mixer additive offset on one joint (used for head look). */
  offsetJoint(semantic: RigSemantic, x: number, y: number, z: number): Bone | undefined {
    const bone = this.bones.get(semantic);
    if (!bone) return undefined;
    const base = this.baseQuaternions.get(semantic);
    if (base) bone.quaternion.copy(base);
    this.offsetEuler.set(x, y, z, 'YXZ');
    this.offsetQuat.setFromEuler(this.offsetEuler);
    bone.quaternion.multiply(this.offsetQuat);
    return bone;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    // Clips hold no GPU resources of their own; uncaching releases the bindings.
    for (const definition of this.definitions.values()) this.mixer.uncacheClip(definition.clip);
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
    this.definitions.clear();
    this.baseQuaternions.clear();
    this.current = null;
  }
}
