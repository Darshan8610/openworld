import { Group, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { clamp } from '../utils/math';
import type { AnimationController, AnimState } from './animation-controller';
import type { Rig } from './rig';

export interface VisualState {
  /** Canonical world position of the feet. */
  world: Vector3;
  originAbsolute: Vector3;
  groundNormal: Vector3;
  yaw: number;
  speed: number;
  swimming: boolean;
  grounded: boolean;
  animation: AnimState;
  /** Camera yaw relative to the body, wrapped to ±π (head look). */
  lookYaw: number;
  cameraPitch: number;
  firstPerson: boolean;
}

const UP = new Vector3(0, 1, 0);
const PRONE = 1.22; // ~70°: a surface-swimming body lies mostly flat

/**
 * Places and orientates the rig, and drives the animation controller.
 *
 * The rig is parented to a pivot at hip height so lean and swim pitch rotate the
 * body around its hips instead of around its feet. Floating-origin correctness
 * comes from recomputing the local position from canonical world space each
 * frame, so an origin rebase can never leave the player behind.
 */
export class CharacterVisual {
  readonly group = new Group();
  private readonly pivot = new Group();
  private readonly smoothUp = new Vector3(0, 1, 0);
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly matrix = new Matrix4();
  private readonly orientation = new Quaternion();
  private leanPitch = 0;
  private leanRoll = 0;
  private previousYaw = 0;

  constructor(private readonly rig: Rig, private readonly animation: AnimationController) {
    this.group.name = 'Player / character';
    this.pivot.name = 'Player / hip pivot';
    this.pivot.position.set(0, 1.0, 0);
    rig.root.position.y = -1.0;
    this.pivot.add(rig.root);
    this.group.add(this.pivot);
  }

  update(dt: number, state: VisualState): void {
    const { originAbsolute, world } = state;
    this.group.position.set(world.x - originAbsolute.x, world.y - originAbsolute.y, world.z - originAbsolute.z);

    // Smooth the contact normal: raw per-triangle normals jitter the silhouette.
    const targetUp = state.swimming || !state.grounded ? UP : state.groundNormal;
    this.up.copy(this.smoothUp).lerp(targetUp, 1 - Math.exp(-dt * 12)).normalize();
    if (this.up.lengthSq() < 0.5) this.up.copy(UP);
    this.smoothUp.copy(this.up);

    this.forward.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
    // Project forward onto the ground plane so the body does not sink into slopes.
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up));
    if (this.forward.lengthSq() < 1e-5) this.forward.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
    this.forward.normalize();
    this.right.copy(this.up).cross(this.forward).normalize();
    this.matrix.makeBasis(this.right, this.up, this.forward);
    this.orientation.setFromRotationMatrix(this.matrix);
    this.group.quaternion.copy(this.orientation);

    // Lean into acceleration/speed, roll into turns, pitch flat when swimming.
    let yawDelta = state.yaw - this.previousYaw;
    yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
    this.previousYaw = state.yaw;
    const turn = dt > 0 ? yawDelta / dt : 0;
    const speedFactor = clamp(state.speed / 7.6, 0, 1);
    const desiredPitch = state.swimming ? PRONE : speedFactor * 0.12;
    // Ease into the prone swim pose and back out of it; one value drives the pitch.
    this.leanPitch += (desiredPitch - this.leanPitch) * (1 - Math.exp(-dt * (state.swimming ? 6 : 9)));
    const desiredRoll = state.swimming ? 0 : clamp(-turn * 0.02, -0.12, 0.12);
    this.leanRoll += (desiredRoll - this.leanRoll) * (1 - Math.exp(-dt * 8));
    this.pivot.rotation.set(this.leanPitch, 0, this.leanRoll);

    this.group.visible = !state.firstPerson;

    this.animation.play(state.animation, this.fadeFor(state.animation), state.speed);
    this.animation.update(dt);
    // Head look is additive on top of the mixer pose, then the pose is final.
    if (!state.firstPerson) {
      const lookYaw = clamp(state.lookYaw, -1.1, 1.1);
      this.animation.offsetJoint('neck', clamp(state.cameraPitch, -0.5, 0.5) * 0.18, lookYaw * 0.18, 0);
      this.animation.offsetJoint('head', clamp(state.cameraPitch, -0.5, 0.5) * 0.2, lookYaw * 0.22, 0);
    }
  }

  private fadeFor(animation: AnimState): number {
    switch (animation) {
      case 'land': return 0.08;
      case 'jump': return 0.1;
      case 'fall': return 0.16;
      case 'idle': return 0.26;
      default: return 0.2;
    }
  }

  get root(): Group { return this.group; }
  get bones() { return this.rig.bones; }

  dispose(): void {
    this.animation.dispose();
    this.group.remove(this.pivot);
    this.pivot.remove(this.rig.root);
    this.rig.dispose();
  }
}
