import { AnimationClip, Euler, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three/webgpu';
import type { KeyframeTrack } from 'three/webgpu';
import type { RigBoneMap, RigSemantic } from './rig';

/**
 * Procedural placeholder animation set.
 *
 * These clips are real `AnimationClip`s with quaternion tracks on the semantic
 * joints, driven by a real `AnimationMixer` and cross-faded by weight. They are
 * in-place (no root motion), which is why the character controller owns movement
 * and only asks the animator for a stride state. Imported GLB animation sets
 * replace them through `CharacterAssets` without changing gameplay code.
 *
 * Rotation convention for joints whose rest axis points down (-Y): a NEGATIVE X
 * rotation swings the limb forward (+Z); a POSITIVE X rotation on the shin bends
 * the knee. Arms: negative X raises forward, positive Z swings the left arm out.
 */

export type PlaceholderClipName =
  | 'idle' | 'walk' | 'jog' | 'sprint' | 'backpedal' | 'strafe'
  | 'crouchIdle' | 'crouchWalk' | 'jump' | 'fall' | 'land' | 'swim' | 'tread';

export const PLACEHOLDER_CLIP_NAMES: readonly PlaceholderClipName[] = [
  'idle', 'walk', 'jog', 'sprint', 'backpedal', 'strafe',
  'crouchIdle', 'crouchWalk', 'jump', 'fall', 'land', 'swim', 'tread',
];

/** Clip play rate at the design speed, and the speed each clip was authored for. */
export const CLIP_TIMING: Record<PlaceholderClipName, { duration: number; designSpeed: number; loop: boolean }> = {
  idle: { duration: 4.0, designSpeed: 0, loop: true },
  walk: { duration: 1.02, designSpeed: 1.7, loop: true },
  jog: { duration: 0.76, designSpeed: 4.4, loop: true },
  sprint: { duration: 0.6, designSpeed: 7.6, loop: true },
  backpedal: { duration: 1.12, designSpeed: 2.4, loop: true },
  strafe: { duration: 0.92, designSpeed: 3.0, loop: true },
  crouchIdle: { duration: 3.6, designSpeed: 0, loop: true },
  crouchWalk: { duration: 1.3, designSpeed: 1.15, loop: true },
  jump: { duration: 0.55, designSpeed: 0, loop: false },
  fall: { duration: 0.7, designSpeed: 0, loop: true },
  land: { duration: 0.36, designSpeed: 0, loop: false },
  swim: { duration: 1.5, designSpeed: 2.2, loop: true },
  tread: { duration: 1.6, designSpeed: 0, loop: true },
};

type Degrees = [number, number, number];
type Pose = Partial<Record<RigSemantic, Degrees>>;
interface Keyframe {
  t: number;
  pose: Pose;
  /** Vertical hips offset in metres (bob, crouch, landing absorption). */
  hips?: number;
}

const DEG = Math.PI / 180;
const ZERO: Degrees = [0, 0, 0];

function mirror(pose: Pose): Pose {
  const result: Pose = {};
  for (const [semantic, value] of Object.entries(pose) as [RigSemantic, Degrees][]) {
    const swapped = semantic
      .replace(/L$/, 'X').replace(/R$/, 'L').replace(/X$/, 'R') as RigSemantic;
    // Y and Z flip when a pose crosses the body midline; X (forward swing) does not.
    result[swapped] = [value[0], -value[1], -value[2]];
  }
  return result;
}

function buildClip(name: PlaceholderClipName, keys: readonly Keyframe[], bones: RigBoneMap, rest: Map<RigSemantic, Vector3>): AnimationClip | undefined {
  const timing = CLIP_TIMING[name];
  const tracks: KeyframeTrack[] = [];
  const used = new Set<RigSemantic>();
  for (const key of keys) for (const semantic of Object.keys(key.pose) as RigSemantic[]) used.add(semantic);
  const euler = new Euler(0, 0, 0, 'XYZ');
  const quaternion = new Quaternion();
  for (const semantic of used) {
    const bone = bones.get(semantic);
    if (!bone) continue;
    const times: number[] = [];
    const values: number[] = [];
    for (const key of keys) {
      const rotation = key.pose[semantic] ?? ZERO;
      euler.set(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG);
      quaternion.setFromEuler(euler);
      times.push(key.t);
      values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    }
    tracks.push(new QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  }
  const hips = bones.get('hips');
  const restHips = rest.get('hips');
  if (hips && restHips && keys.some((key) => key.hips !== undefined)) {
    const times = keys.map((key) => key.t);
    const values = keys.flatMap((key) => [restHips.x, restHips.y + (key.hips ?? 0), restHips.z]);
    tracks.push(new VectorKeyframeTrack(`${hips.name}.position`, times, values));
  }
  return tracks.length > 0 ? new AnimationClip(name, timing.duration, tracks) : undefined;
}

export interface PlaceholderClipSet {
  clips: Map<PlaceholderClipName, AnimationClip>;
  missing: PlaceholderClipName[];
}

/** Build the whole locomotion set for any rig whose joints resolve semantically. */
export function buildPlaceholderClips(bones: RigBoneMap, rest: Map<RigSemantic, Vector3>): PlaceholderClipSet {
  const contacts: Keyframe = {
    t: 0,
    pose: {
      thighL: [-24, 0, 0], shinL: [6, 0, 0], footL: [8, 0, 0],
      thighR: [20, 0, 0], shinR: [14, 0, 0], footR: [-12, 0, 0],
      upperArmL: [18, 0, 3], lowerArmL: [-8, 0, 0],
      upperArmR: [-18, 0, -3], lowerArmR: [-20, 0, 0],
      spine: [2, 0, 0], chest: [0, 0, 0], neck: [-2, 0, 0], head: [0, 0, 0],
    },
    hips: -0.015,
  };
  const passing: Keyframe = {
    t: 0.25,
    pose: {
      thighL: [-4, 0, 0], shinL: [6, 0, 0], footL: [0, 0, 0],
      thighR: [4, 0, 0], shinR: [42, 0, 0], footR: [10, 0, 0],
      upperArmL: [4, 0, 3], lowerArmL: [-12, 0, 0],
      upperArmR: [-4, 0, -3], lowerArmR: [-16, 0, 0],
      spine: [2, 0, 0], chest: [0, 0, 0], neck: [-2, 0, 0], head: [0, 0, 0],
    },
    hips: 0.022,
  };

  const walk: Keyframe[] = [
    contacts,
    passing,
    { t: 0.5, pose: mirror(contacts.pose), hips: contacts.hips },
    { t: 0.75, pose: mirror(passing.pose), hips: passing.hips },
    { t: 1.02, pose: contacts.pose, hips: contacts.hips },
  ];

  const jogContact: Keyframe = {
    t: 0,
    pose: {
      thighL: [-36, 0, 0], shinL: [14, 0, 0], footL: [10, 0, 0],
      thighR: [26, 0, 0], shinR: [52, 0, 0], footR: [-14, 0, 0],
      upperArmL: [30, 0, 6], lowerArmL: [-62, 0, 0],
      upperArmR: [-34, 0, -6], lowerArmR: [-70, 0, 0],
      spine: [6, 0, 0], chest: [2, 0, 0], neck: [-4, 0, 0], head: [-2, 0, 0],
    },
    hips: -0.035,
  };
  const jogFlight: Keyframe = {
    t: 0.19,
    pose: {
      thighL: [-12, 0, 0], shinL: [26, 0, 0], footL: [0, 0, 0],
      thighR: [-6, 0, 0], shinR: [86, 0, 0], footR: [16, 0, 0],
      upperArmL: [6, 0, 6], lowerArmL: [-72, 0, 0],
      upperArmR: [-10, 0, -6], lowerArmR: [-78, 0, 0],
      spine: [6, 0, 0], chest: [2, 0, 0], neck: [-4, 0, 0], head: [-2, 0, 0],
    },
    hips: 0.05,
  };
  const jog: Keyframe[] = [
    jogContact,
    jogFlight,
    { t: 0.38, pose: mirror(jogContact.pose), hips: jogContact.hips },
    { t: 0.57, pose: mirror(jogFlight.pose), hips: jogFlight.hips },
    { t: 0.76, pose: jogContact.pose, hips: jogContact.hips },
  ];

  const sprintContact: Keyframe = {
    t: 0,
    pose: {
      thighL: [-48, 0, 0], shinL: [20, 0, 0], footL: [12, 0, 0],
      thighR: [34, 0, 0], shinR: [64, 0, 0], footR: [-16, 0, 0],
      upperArmL: [44, 0, 8], lowerArmL: [-84, 0, 0],
      upperArmR: [-50, 0, -8], lowerArmR: [-92, 0, 0],
      spine: [11, 0, 0], chest: [4, 0, 0], neck: [-7, 0, 0], head: [-4, 0, 0],
    },
    hips: -0.05,
  };
  const sprintFlight: Keyframe = {
    t: 0.15,
    pose: {
      thighL: [-16, 0, 0], shinL: [40, 0, 0], footL: [0, 0, 0],
      thighR: [-14, 0, 0], shinR: [104, 0, 0], footR: [20, 0, 0],
      upperArmL: [8, 0, 8], lowerArmL: [-96, 0, 0],
      upperArmR: [-14, 0, -8], lowerArmR: [-100, 0, 0],
      spine: [11, 0, 0], chest: [4, 0, 0], neck: [-7, 0, 0], head: [-4, 0, 0],
    },
    hips: 0.06,
  };
  const sprint: Keyframe[] = [
    sprintContact,
    sprintFlight,
    { t: 0.3, pose: mirror(sprintContact.pose), hips: sprintContact.hips },
    { t: 0.45, pose: mirror(sprintFlight.pose), hips: sprintFlight.hips },
    { t: 0.6, pose: sprintContact.pose, hips: sprintContact.hips },
  ];

  const backpedalContact: Pose = {
    thighL: [18, 0, 0], shinL: [12, 0, 0], footL: [-6, 0, 0],
    thighR: [-16, 0, 0], shinR: [22, 0, 0], footR: [4, 0, 0],
    upperArmL: [-16, 0, 4], lowerArmL: [-24, 0, 0],
    upperArmR: [16, 0, -4], lowerArmR: [-24, 0, 0],
    spine: [-3, 0, 0], neck: [3, 0, 0],
  };
  const backpedalPassing: Pose = {
    thighL: [2, 0, 0], shinL: [8, 0, 0], thighR: [-2, 0, 0], shinR: [30, 0, 0],
    upperArmL: [-4, 0, 4], lowerArmL: [-20, 0, 0],
    upperArmR: [4, 0, -4], lowerArmR: [-20, 0, 0],
    spine: [-3, 0, 0], neck: [3, 0, 0],
  };
  const backpedal: Keyframe[] = [
    { t: 0, pose: backpedalContact, hips: -0.01 },
    { t: 0.28, pose: backpedalPassing, hips: 0.015 },
    { t: 0.56, pose: mirror(backpedalContact), hips: -0.01 },
    { t: 0.84, pose: mirror(backpedalPassing), hips: 0.015 },
    { t: 1.12, pose: backpedalContact, hips: -0.01 },
  ];

  const strafe: Keyframe[] = [
    {
      t: 0,
      pose: {
        thighL: [-6, 0, 14], shinL: [10, 0, 0], footL: [0, 0, -8],
        thighR: [-2, 0, -4], shinR: [16, 0, 0], footR: [0, 0, 0],
        upperArmL: [4, 0, 16], lowerArmL: [-18, 0, 0],
        upperArmR: [-4, 0, -10], lowerArmR: [-22, 0, 0],
        spine: [2, 0, -3], chest: [0, 0, -2], neck: [0, 0, 3],
      },
      hips: -0.01,
    },
    {
      t: 0.23,
      pose: {
        thighL: [-2, 0, 24], shinL: [24, 0, 0], footL: [0, 0, -10],
        thighR: [2, 0, -8], shinR: [8, 0, 0], footR: [0, 0, 0],
        upperArmL: [0, 0, 22], lowerArmL: [-16, 0, 0],
        upperArmR: [0, 0, -6], lowerArmR: [-24, 0, 0],
        spine: [2, 0, -4], chest: [0, 0, -2], neck: [0, 0, 4],
      },
      hips: 0.02,
    },
    {
      t: 0.46,
      pose: {
        thighL: [4, 0, 6], shinL: [14, 0, 0], footL: [0, 0, -2],
        thighR: [6, 0, -20], shinR: [20, 0, 0], footR: [0, 0, 6],
        upperArmL: [-4, 0, 10], lowerArmL: [-20, 0, 0],
        upperArmR: [4, 0, -18], lowerArmR: [-18, 0, 0],
        spine: [2, 0, -2], chest: [0, 0, -1], neck: [0, 0, 2],
      },
      hips: -0.005,
    },
    {
      t: 0.69,
      pose: {
        thighL: [2, 0, 8], shinL: [8, 0, 0], thighR: [0, 0, -24], shinR: [26, 0, 0], footR: [0, 0, 10],
        upperArmL: [0, 0, 8], lowerArmL: [-22, 0, 0],
        upperArmR: [0, 0, -24], lowerArmR: [-16, 0, 0],
        spine: [2, 0, -3], chest: [0, 0, -2], neck: [0, 0, 3],
      },
      hips: 0.02,
    },
    {
      t: 0.92,
      pose: {
        thighL: [-6, 0, 14], shinL: [10, 0, 0], footL: [0, 0, -8],
        thighR: [-2, 0, -4], shinR: [16, 0, 0],
        upperArmL: [4, 0, 16], lowerArmL: [-18, 0, 0],
        upperArmR: [-4, 0, -10], lowerArmR: [-22, 0, 0],
        spine: [2, 0, -3], chest: [0, 0, -2], neck: [0, 0, 3],
      },
      hips: -0.01,
    },
  ];

  const crouchBase: Pose = {
    thighL: [-64, 0, 6], shinL: [82, 0, 0], footL: [-18, 0, 0],
    thighR: [-64, 0, -6], shinR: [82, 0, 0], footR: [-18, 0, 0],
    spine: [16, 0, 0], chest: [7, 0, 0], neck: [-12, 0, 0], head: [-4, 0, 0],
    upperArmL: [10, 0, 12], lowerArmL: [-58, 0, 0],
    upperArmR: [10, 0, -12], lowerArmR: [-58, 0, 0],
  };
  const crouchIdle: Keyframe[] = [
    { t: 0, pose: crouchBase, hips: -0.34 },
    { t: 1.2, pose: { ...crouchBase, chest: [9, 0, 0], spine: [18, 0, 0], upperArmL: [13, 0, 12], upperArmR: [13, 0, -12] }, hips: -0.325 },
    { t: 2.4, pose: crouchBase, hips: -0.345 },
    { t: 3.6, pose: crouchBase, hips: -0.34 },
  ];
  const crouchWalk: Keyframe[] = [
    { t: 0, pose: { ...crouchBase, thighL: [-78, 0, 6], shinL: [86, 0, 0], thighR: [-48, 0, -6], shinR: [68, 0, 0], upperArmL: [-4, 0, 12], upperArmR: [24, 0, -12] }, hips: -0.35 },
    { t: 0.32, pose: { ...crouchBase, thighL: [-62, 0, 6], shinL: [74, 0, 0], thighR: [-62, 0, -6], shinR: [90, 0, 0], upperArmL: [8, 0, 12], upperArmR: [12, 0, -12] }, hips: -0.325 },
    { t: 0.65, pose: { ...crouchBase, thighL: [-48, 0, 6], shinL: [68, 0, 0], thighR: [-78, 0, -6], shinR: [86, 0, 0], upperArmL: [24, 0, 12], upperArmR: [-4, 0, -12] }, hips: -0.35 },
    { t: 0.98, pose: { ...crouchBase, thighL: [-62, 0, 6], shinL: [90, 0, 0], thighR: [-62, 0, -6], shinR: [74, 0, 0], upperArmL: [12, 0, 12], upperArmR: [8, 0, -12] }, hips: -0.325 },
    { t: 1.3, pose: { ...crouchBase, thighL: [-78, 0, 6], shinL: [86, 0, 0], thighR: [-48, 0, -6], shinR: [68, 0, 0], upperArmL: [-4, 0, 12], upperArmR: [24, 0, -12] }, hips: -0.35 },
  ];

  const jump: Keyframe[] = [
    { t: 0, pose: { thighL: [-22, 0, 0], shinL: [26, 0, 0], thighR: [-18, 0, 0], shinR: [22, 0, 0], spine: [8, 0, 0], upperArmL: [-42, 0, 10], upperArmR: [-42, 0, -10], lowerArmL: [-26, 0, 0], lowerArmR: [-26, 0, 0] }, hips: -0.1 },
    { t: 0.16, pose: { thighL: [-56, 0, 0], shinL: [78, 0, 0], thighR: [-40, 0, 0], shinR: [62, 0, 0], spine: [10, 0, 0], upperArmL: [-96, 0, 14], upperArmR: [-96, 0, -14], lowerArmL: [-34, 0, 0], lowerArmR: [-34, 0, 0] }, hips: -0.06 },
    { t: 0.34, pose: { thighL: [-16, 0, 0], shinL: [30, 0, 0], thighR: [-24, 0, 0], shinR: [34, 0, 0], spine: [2, 0, 0], upperArmL: [-64, 0, 12], upperArmR: [-64, 0, -12], lowerArmL: [-20, 0, 0], lowerArmR: [-20, 0, 0] }, hips: 0.02 },
    { t: 0.55, pose: { thighL: [-26, 0, 0], shinL: [38, 0, 0], thighR: [-22, 0, 0], shinR: [34, 0, 0], spine: [4, 0, 0], upperArmL: [-30, 0, 10], upperArmR: [-30, 0, -10], lowerArmL: [-30, 0, 0], lowerArmR: [-30, 0, 0] }, hips: 0 },
  ];

  const fall: Keyframe[] = [
    { t: 0, pose: { thighL: [-16, 0, 8], shinL: [34, 0, 0], thighR: [12, 0, -8], shinR: [26, 0, 0], spine: [-4, 0, 0], upperArmL: [-104, 0, 30], upperArmR: [-104, 0, -30], lowerArmL: [-30, 0, 0], lowerArmR: [-30, 0, 0], neck: [-6, 0, 0] }, hips: 0 },
    { t: 0.35, pose: { thighL: [-10, 0, 10], shinL: [26, 0, 0], thighR: [6, 0, -10], shinR: [34, 0, 0], spine: [-2, 0, 0], upperArmL: [-112, 0, 34], upperArmR: [-112, 0, -34], lowerArmL: [-24, 0, 0], lowerArmR: [-24, 0, 0], neck: [-8, 0, 0] }, hips: 0.01 },
    { t: 0.7, pose: { thighL: [-16, 0, 8], shinL: [34, 0, 0], thighR: [12, 0, -8], shinR: [26, 0, 0], spine: [-4, 0, 0], upperArmL: [-104, 0, 30], upperArmR: [-104, 0, -30], lowerArmL: [-30, 0, 0], lowerArmR: [-30, 0, 0], neck: [-6, 0, 0] }, hips: 0 },
  ];

  const land: Keyframe[] = [
    { t: 0, pose: { thighL: [-52, 0, 8], shinL: [72, 0, 0], footL: [-16, 0, 0], thighR: [-48, 0, -8], shinR: [68, 0, 0], footR: [-16, 0, 0], spine: [22, 0, 0], chest: [8, 0, 0], neck: [-16, 0, 0], upperArmL: [30, 0, 18], upperArmR: [30, 0, -18], lowerArmL: [-40, 0, 0], lowerArmR: [-40, 0, 0] }, hips: -0.24 },
    { t: 0.12, pose: { thighL: [-44, 0, 8], shinL: [64, 0, 0], footL: [-12, 0, 0], thighR: [-40, 0, -8], shinR: [60, 0, 0], footR: [-12, 0, 0], spine: [18, 0, 0], chest: [6, 0, 0], neck: [-12, 0, 0], upperArmL: [24, 0, 16], upperArmR: [24, 0, -16], lowerArmL: [-34, 0, 0], lowerArmR: [-34, 0, 0] }, hips: -0.2 },
    { t: 0.36, pose: { spine: [2, 0, 0], upperArmL: [4, 0, 4], upperArmR: [4, 0, -4], lowerArmL: [-14, 0, 0], lowerArmR: [-14, 0, 0] }, hips: -0.01 },
  ];

  const swim: Keyframe[] = [
    { t: 0, pose: { upperArmL: [-150, 0, 16], lowerArmL: [-24, 0, 0], upperArmR: [-58, 0, -16], lowerArmR: [-52, 0, 0], thighL: [-12, 0, 4], shinL: [22, 0, 0], thighR: [10, 0, -4], shinR: [30, 0, 0], spine: [4, 0, 0], neck: [-26, 0, 0], head: [-14, 0, 0] }, hips: 0 },
    { t: 0.38, pose: { upperArmL: [-104, 0, 20], lowerArmL: [-46, 0, 0], upperArmR: [-104, 0, -20], lowerArmR: [-46, 0, 0], thighL: [8, 0, 4], shinL: [30, 0, 0], thighR: [-10, 0, -4], shinR: [22, 0, 0], spine: [2, 0, 0], neck: [-24, 0, 0], head: [-12, 0, 0] }, hips: 0.015 },
    { t: 0.76, pose: { upperArmL: [-58, 0, 16], lowerArmL: [-52, 0, 0], upperArmR: [-150, 0, -16], lowerArmR: [-24, 0, 0], thighL: [10, 0, 4], shinL: [30, 0, 0], thighR: [-12, 0, -4], shinR: [22, 0, 0], spine: [4, 0, 0], neck: [-26, 0, 0], head: [-14, 0, 0] }, hips: 0 },
    { t: 1.5, pose: { upperArmL: [-150, 0, 16], lowerArmL: [-24, 0, 0], upperArmR: [-58, 0, -16], lowerArmR: [-52, 0, 0], thighL: [-12, 0, 4], shinL: [22, 0, 0], thighR: [10, 0, -4], shinR: [30, 0, 0], spine: [4, 0, 0], neck: [-26, 0, 0], head: [-14, 0, 0] }, hips: 0 },
  ];

  const tread: Keyframe[] = [
    { t: 0, pose: { upperArmL: [-20, 0, 74], lowerArmL: [-58, 0, 0], upperArmR: [-20, 0, -74], lowerArmR: [-58, 0, 0], thighL: [-34, 0, 10], shinL: [56, 0, 0], thighR: [16, 0, -10], shinR: [38, 0, 0], spine: [2, 0, 0], neck: [-6, 0, 0] }, hips: 0 },
    { t: 0.4, pose: { upperArmL: [-38, 0, 82], lowerArmL: [-44, 0, 0], upperArmR: [-38, 0, -82], lowerArmR: [-44, 0, 0], thighL: [6, 0, 10], shinL: [34, 0, 0], thighR: [-22, 0, -10], shinR: [52, 0, 0], spine: [2, 0, 0], neck: [-6, 0, 0] }, hips: 0.02 },
    { t: 0.8, pose: { upperArmL: [-20, 0, 74], lowerArmL: [-58, 0, 0], upperArmR: [-20, 0, -74], lowerArmR: [-58, 0, 0], thighL: [-16, 0, 10], shinL: [44, 0, 0], thighR: [-4, 0, -10], shinR: [46, 0, 0], spine: [2, 0, 0], neck: [-6, 0, 0] }, hips: 0 },
    { t: 1.2, pose: { upperArmL: [-38, 0, 82], lowerArmL: [-44, 0, 0], upperArmR: [-38, 0, -82], lowerArmR: [-44, 0, 0], thighL: [-26, 0, 10], shinL: [50, 0, 0], thighR: [10, 0, -10], shinR: [36, 0, 0], spine: [2, 0, 0], neck: [-6, 0, 0] }, hips: 0.02 },
    { t: 1.6, pose: { upperArmL: [-20, 0, 74], lowerArmL: [-58, 0, 0], upperArmR: [-20, 0, -74], lowerArmR: [-58, 0, 0], thighL: [-34, 0, 10], shinL: [56, 0, 0], thighR: [16, 0, -10], shinR: [38, 0, 0], spine: [2, 0, 0], neck: [-6, 0, 0] }, hips: 0 },
  ];

  const idle: Keyframe[] = [
    { t: 0, pose: { spine: [1, 0, 0], chest: [1, 0, 0], neck: [1, 0, 0], upperArmL: [2, 0, 5], upperArmR: [2, 0, -5], lowerArmL: [-12, 0, 0], lowerArmR: [-12, 0, 0], thighL: [-2, 0, 2], thighR: [-2, 0, -2] }, hips: 0 },
    { t: 1.0, pose: { spine: [2, 0, 0], chest: [3, 0, 0], neck: [0, 0, 0], upperArmL: [3, 0, 6], upperArmR: [3, 0, -6], lowerArmL: [-14, 0, 0], lowerArmR: [-14, 0, 0], thighL: [-2, 0, 2], thighR: [-2, 0, -2] }, hips: 0.008 },
    { t: 2.0, pose: { spine: [2, 0, 0], chest: [2, 0, 0], neck: [2, 0, 0], upperArmL: [2, 0, 6], upperArmR: [2, 0, -6], lowerArmL: [-13, 0, 0], lowerArmR: [-13, 0, 0], thighL: [-3, 0, 2], thighR: [-1, 0, -2] }, hips: -0.004 },
    { t: 3.0, pose: { spine: [1, 0, 0], chest: [2, 0, 0], neck: [1, 0, 0], upperArmL: [3, 0, 5], upperArmR: [3, 0, -5], lowerArmL: [-12, 0, 0], lowerArmR: [-12, 0, 0], thighL: [-2, 0, 2], thighR: [-2, 0, -2] }, hips: 0.006 },
    { t: 4.0, pose: { spine: [1, 0, 0], chest: [1, 0, 0], neck: [1, 0, 0], upperArmL: [2, 0, 5], upperArmR: [2, 0, -5], lowerArmL: [-12, 0, 0], lowerArmR: [-12, 0, 0], thighL: [-2, 0, 2], thighR: [-2, 0, -2] }, hips: 0 },
  ];

  const sources: Record<PlaceholderClipName, Keyframe[]> = {
    idle, walk, jog, sprint, backpedal, strafe, crouchIdle, crouchWalk, jump, fall, land, swim, tread,
  };

  const clips = new Map<PlaceholderClipName, AnimationClip>();
  const missing: PlaceholderClipName[] = [];
  for (const name of PLACEHOLDER_CLIP_NAMES) {
    const clip = buildClip(name, sources[name], bones, rest);
    if (clip) clips.set(name, clip);
    else missing.push(name);
  }
  return { clips, missing };
}
