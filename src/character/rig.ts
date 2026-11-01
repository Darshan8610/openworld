import { Bone, Object3D, SkinnedMesh, Skeleton } from 'three/webgpu';

/**
 * Semantic joints. Gameplay and animation code addresses joints by meaning, never
 * by asset-specific bone names, so a placeholder rig and an imported GLTF humanoid
 * can be driven by the same animation controller.
 */
export const RIG_SEMANTICS = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'shoulderR', 'upperArmL', 'upperArmR', 'lowerArmL', 'lowerArmR', 'handL', 'handR',
  'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR',
] as const;
export type RigSemantic = typeof RIG_SEMANTICS[number];
export type RigBoneMap = Map<RigSemantic, Bone>;

export type RigSource = 'placeholder' | 'gltf';

/** A resolved character rig: either the procedural placeholder or an imported GLB. */
export interface Rig {
  /** Transform node that gameplay code positions in the world. */
  readonly root: Object3D;
  readonly bones: RigBoneMap;
  readonly skeleton?: Skeleton;
  readonly skin?: SkinnedMesh;
  /** Nominal standing height in metres, used for capsule and camera placement. */
  readonly height: number;
  readonly source: RigSource;
  dispose(): void;
}

/** Normalize an asset bone name: "mixamorig:LeftArm" -> "leftarm". */
export function normalizeBoneName(name: string): string {
  return name
    .replace(/^mixamorig[:_-]?/i, '')
    .replace(/^armature[:_|]+/i, '')
    .replace(/^def[:_-]/i, '')
    .replace(/[_\-.:\s]/g, '')
    .toLowerCase();
}

/**
 * Common-name heuristics for imported humanoids (Mixamo, Rigify, UE mannequin,
 * Blender defaults). Ordered: earlier patterns win, and a bone is never assigned
 * to two semantics. Unmatched semantics simply stay absent; the animation set
 * degrades to the joints that do exist instead of failing.
 */
const NAME_HINTS: Record<RigSemantic, readonly RegExp[]> = {
  hips: [/^hips?$/, /pelvis/, /^root$/],
  spine: [/^spine$/, /spine0?1/, /^spine1$/],
  chest: [/chest/, /^spine2$/, /spine3/, /upperchest/],
  neck: [/neck/],
  head: [/^head$/, /headjoint/],
  shoulderL: [/leftshoulder/, /^lshoulder$/, /shoulderleft/, /leftclavicle/, /leftscapula/],
  shoulderR: [/rightshoulder/, /^rshoulder$/, /shoulderright/, /rightclavicle/, /rightscapula/],
  upperArmL: [/leftarm$/, /leftupperarm/, /^lupperarm$/, /leftshoulderjoint/],
  upperArmR: [/rightarm$/, /rightupperarm/, /^rupperarm$/, /rightshoulderjoint/],
  lowerArmL: [/leftforearm/, /leftlowerarm/, /^lforearm$/],
  lowerArmR: [/rightforearm/, /rightlowerarm/, /^rforearm$/],
  handL: [/lefthand/, /handleft/, /^lhand$/],
  handR: [/righthand/, /handright/, /^rhand$/],
  thighL: [/leftupleg/, /leftthigh/, /^lthigh$/, /upperlegleft/],
  thighR: [/rightupleg/, /rightthigh/, /^rthigh$/, /upperlegright/],
  shinL: [/leftleg$/, /leftshin/, /^lshin$/, /leftlowerleg/, /calfl/],
  shinR: [/rightleg$/, /rightshin/, /^rshin$/, /rightlowerleg/, /calfr/],
  footL: [/leftfoot/, /leftankle/, /^lfoot$/],
  footR: [/rightfoot/, /rightankle/, /^rfoot$/],
};

export interface ResolvedBones {
  bones: RigBoneMap;
  /** Semantics the asset did not provide. */
  missing: RigSemantic[];
}

/** Map an arbitrary humanoid hierarchy onto the semantic joint set. */
export function resolveRigBones(root: Object3D): ResolvedBones {
  const candidates: { bone: Bone; name: string }[] = [];
  root.traverse((object) => {
    const bone = object as Bone;
    if (!(bone as unknown as { isBone?: boolean }).isBone) return;
    candidates.push({ bone, name: normalizeBoneName(bone.name) });
  });
  const bones: RigBoneMap = new Map();
  const used = new Set<Bone>();
  for (const semantic of RIG_SEMANTICS) {
    for (const pattern of NAME_HINTS[semantic]) {
      const match = candidates.find((entry) => !used.has(entry.bone) && pattern.test(entry.name));
      if (match) {
        bones.set(semantic, match.bone);
        used.add(match.bone);
        break;
      }
    }
  }
  return { bones, missing: RIG_SEMANTICS.filter((semantic) => !bones.has(semantic)) };
}

/** Depth-first bone list so parents precede children for skeleton construction. */
export function flattenedBones(bones: RigBoneMap): Bone[] {
  return [...new Set(bones.values())];
}

export const hasSkinning = (mesh: SkinnedMesh): boolean =>
  mesh.geometry.getAttribute('skinIndex') !== undefined && mesh.geometry.getAttribute('skinWeight') !== undefined;
