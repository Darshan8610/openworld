import {
  Bone, BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute,
  FrontSide, Group, Matrix4, Mesh, MeshStandardNodeMaterial, Quaternion, SkinnedMesh,
  Skeleton, SphereGeometry, Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Rig, RigBoneMap, RigSemantic } from './rig';

/**
 * PROCEDURAL PLACEHOLDER CHARACTER.
 *
 * This is a real skinned mesh: one merged bind-pose geometry with per-vertex
 * `skinIndex`/`skinWeight` attributes, a 19-joint bone hierarchy and a Skeleton,
 * so gameplay, animation blending and joint-level tooling are exercised exactly
 * as they will be for an imported GLB humanoid.
 *
 * It is deliberately NOT presented as production art. `Rig.source` reports
 * 'placeholder'; the HUD shows "PLACEHOLDER RIG"; `CharacterAssets` swaps in a
 * licensed GLTF humanoid without touching controller or animation code.
 */

interface BoneSpec {
  semantic: RigSemantic;
  name: string;
  parent: RigSemantic | 'root';
  position: readonly [number, number, number];
}

const BONES: readonly BoneSpec[] = [
  { semantic: 'hips', name: 'wayfarer_hips', parent: 'root', position: [0, 0.94, 0] },
  { semantic: 'spine', name: 'wayfarer_spine', parent: 'hips', position: [0, 0.13, 0] },
  { semantic: 'chest', name: 'wayfarer_chest', parent: 'spine', position: [0, 0.21, 0] },
  { semantic: 'neck', name: 'wayfarer_neck', parent: 'chest', position: [0, 0.22, 0] },
  { semantic: 'head', name: 'wayfarer_head', parent: 'neck', position: [0, 0.09, 0] },
  { semantic: 'shoulderL', name: 'wayfarer_shoulder_l', parent: 'chest', position: [0.185, 0.17, 0] },
  { semantic: 'shoulderR', name: 'wayfarer_shoulder_r', parent: 'chest', position: [-0.185, 0.17, 0] },
  { semantic: 'upperArmL', name: 'wayfarer_upperarm_l', parent: 'shoulderL', position: [0.04, 0, 0] },
  { semantic: 'upperArmR', name: 'wayfarer_upperarm_r', parent: 'shoulderR', position: [-0.04, 0, 0] },
  { semantic: 'lowerArmL', name: 'wayfarer_lowerarm_l', parent: 'upperArmL', position: [0, -0.29, 0] },
  { semantic: 'lowerArmR', name: 'wayfarer_lowerarm_r', parent: 'upperArmR', position: [0, -0.29, 0] },
  { semantic: 'handL', name: 'wayfarer_hand_l', parent: 'lowerArmL', position: [0, -0.25, 0] },
  { semantic: 'handR', name: 'wayfarer_hand_r', parent: 'lowerArmR', position: [0, -0.25, 0] },
  { semantic: 'thighL', name: 'wayfarer_thigh_l', parent: 'hips', position: [0.105, -0.04, 0] },
  { semantic: 'thighR', name: 'wayfarer_thigh_r', parent: 'hips', position: [-0.105, -0.04, 0] },
  { semantic: 'shinL', name: 'wayfarer_shin_l', parent: 'thighL', position: [0, -0.44, 0] },
  { semantic: 'shinR', name: 'wayfarer_shin_r', parent: 'thighR', position: [0, -0.44, 0] },
  { semantic: 'footL', name: 'wayfarer_foot_l', parent: 'shinL', position: [0, -0.42, 0] },
  { semantic: 'footR', name: 'wayfarer_foot_r', parent: 'shinR', position: [0, -0.42, 0] },
];

/** Keep the palette consistent with the Wayfarer landscape UI. */
const SKIN = 0xc49773;
const JACKET = 0x2f5c52;
const JACKET_DARK = 0x24463f;
const TROUSERS = 0x39424a;
const BOOTS = 0x26211d;
const PACK = 0x6a5638;
const GLOVES = 0x2b2b2b;

const tint = (hex: number, amount: number): Color => new Color(hex).multiplyScalar(amount);

interface Part {
  bone: RigSemantic;
  geometry: BufferGeometry;
}

const box = (width: number, height: number, depth: number): BufferGeometry => new BoxGeometry(width, height, depth, 1, 1, 1);
const tube = (radiusTop: number, radiusBottom: number, height: number, segments = 10): BufferGeometry =>
  new CylinderGeometry(radiusTop, radiusBottom, height, segments, 1, false);

function place(geometry: BufferGeometry, x: number, y: number, z: number, rotation?: Quaternion): BufferGeometry {
  const matrix = new Matrix4().makeTranslation(x, y, z);
  if (rotation) matrix.multiply(new Matrix4().makeRotationFromQuaternion(rotation));
  return geometry.applyMatrix4(matrix);
}

function paint(geometry: BufferGeometry, color: Color): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Segments of the body in bind pose, each rigidly weighted to one joint. */
function buildParts(): Part[] {
  const parts: Part[] = [];
  const add = (bone: RigSemantic, geometry: BufferGeometry) => parts.push({ bone, geometry });

  // Torso stack.
  add('hips', place(paint(box(0.30, 0.21, 0.21), tint(TROUSERS, 1)), 0, 1.00, 0));
  add('spine', place(paint(tube(0.155, 0.145, 0.24, 12), tint(JACKET, 1)), 0, 1.16, 0));
  add('chest', place(paint(tube(0.185, 0.16, 0.30, 12), tint(JACKET, 1)), 0, 1.36, 0));
  add('chest', place(paint(box(0.30, 0.16, 0.20), tint(JACKET_DARK, 1)), 0, 1.47, 0));
  add('chest', place(paint(box(0.24, 0.30, 0.15), tint(PACK, 1)), 0, 1.30, -0.19));
  add('neck', place(paint(tube(0.052, 0.058, 0.11, 8), tint(SKIN, 0.92)), 0, 1.52, 0));
  add('head', place(paint(new SphereGeometry(0.108, 14, 12).scale(1, 1.14, 1.06), tint(SKIN, 1)), 0, 1.655, 0.005));
  add('head', place(paint(new SphereGeometry(0.113, 14, 10), tint(0x2a2320, 1)), 0, 1.69, -0.02));
  add('head', place(paint(box(0.155, 0.05, 0.04), tint(0x1d2b2f, 1)), 0, 1.655, 0.10));

  for (const side of [1, -1] as const) {
    const suffix = side > 0 ? 'L' : 'R';
    const shoulder = `shoulder${suffix}` as RigSemantic;
    const upperArm = `upperArm${suffix}` as RigSemantic;
    const lowerArm = `lowerArm${suffix}` as RigSemantic;
    const hand = `hand${suffix}` as RigSemantic;
    const thigh = `thigh${suffix}` as RigSemantic;
    const shin = `shin${suffix}` as RigSemantic;
    const foot = `foot${suffix}` as RigSemantic;

    add(shoulder, place(paint(new SphereGeometry(0.075, 10, 8), tint(JACKET, 0.95)), side * 0.20, 1.475, 0));
    add(upperArm, place(paint(tube(0.055, 0.048, 0.29, 8), tint(JACKET, 1)), side * 0.225, 1.33, 0));
    add(lowerArm, place(paint(tube(0.046, 0.038, 0.26, 8), tint(JACKET_DARK, 1)), side * 0.225, 1.045, 0));
    add(hand, place(paint(box(0.072, 0.13, 0.06), tint(GLOVES, 1)), side * 0.225, 0.895, 0));

    add(thigh, place(paint(tube(0.082, 0.068, 0.44, 10), tint(TROUSERS, 1)), side * 0.105, 0.70, 0));
    add(shin, place(paint(tube(0.062, 0.05, 0.42, 10), tint(TROUSERS, 0.92)), side * 0.105, 0.26, 0));
    add(foot, place(paint(box(0.105, 0.085, 0.26), tint(BOOTS, 1)), side * 0.105, 0.045, 0.055));
  }
  return parts;
}

export interface PlaceholderRig extends Rig {
  readonly boneSpecs: readonly BoneSpec[];
}

export function createPlaceholderRig(): PlaceholderRig {
  const root = new Group();
  root.name = 'character-rig (placeholder)';
  const map: RigBoneMap = new Map();
  for (const spec of BONES) {
    const bone = new Bone();
    bone.name = spec.name;
    bone.position.set(spec.position[0], spec.position[1], spec.position[2]);
    const parent = spec.parent === 'root' ? root : map.get(spec.parent);
    if (!parent) throw new Error(`Character rig bone ${spec.semantic} has no parent ${spec.parent}`);
    parent.add(bone);
    map.set(spec.semantic, bone);
  }

  const parts = buildParts();
  const geometries = parts.map((part) => part.geometry);
  const merged = mergeGeometries(geometries, false);
  if (!merged) throw new Error('Failed to merge the placeholder character geometry');
  for (const geometry of geometries) geometry.dispose();

  // Rigid skinning: every vertex belongs to exactly one joint. Cheap, stable and
  // sufficient for a stylized placeholder; imported GLBs bring their own weights.
  const skinIndices = new Uint16Array(merged.getAttribute('position').count * 4);
  const skinWeights = new Float32Array(merged.getAttribute('position').count * 4);
  const ordered = [...map.keys()];
  let vertex = 0;
  for (const part of parts) {
    const index = ordered.indexOf(part.bone);
    const count = part.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      skinIndices[(vertex + i) * 4] = index;
      skinWeights[(vertex + i) * 4] = 1;
    }
    vertex += count;
  }
  if (vertex !== skinWeights.length / 4) throw new Error('Character skin weights do not match merged vertex count');
  merged.setAttribute('skinIndex', new Float32BufferAttribute(skinIndices, 4));
  merged.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));
  merged.computeBoundingSphere();

  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.02, side: FrontSide });
  material.name = 'Character / placeholder skinned body';
  const skin = new SkinnedMesh(merged, material);
  skin.name = 'character-body (placeholder)';
  skin.castShadow = true;
  skin.receiveShadow = true;
  // One small mesh: hierarchy changes move it, so static bind-pose culling hurts.
  skin.frustumCulled = false;

  const bones = [...map.values()];
  root.add(skin);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  skin.bind(skeleton);

  const eye = new Mesh(new SphereGeometry(0.02, 6, 5), material);
  eye.visible = false;
  root.add(eye);

  return {
    root,
    bones: map,
    skeleton,
    skin,
    height: 1.8,
    source: 'placeholder',
    boneSpecs: BONES,
    dispose() {
      merged.dispose();
      material.dispose();
      skeleton.dispose();
      eye.geometry.dispose();
      root.remove(...root.children);
      map.clear();
    },
  };
}

/** Bind-pose rest position of a joint, in rig-local space (metres). */
export function restPosition(semantic: RigSemantic): Vector3 {
  const spec = BONES.find((entry) => entry.semantic === semantic);
  return spec ? new Vector3(spec.position[0], spec.position[1], spec.position[2]) : new Vector3();
}
