import { AnimationClip, Box3, Mesh, SkinnedMesh, Vector3 } from 'three/webgpu';
import { createPlaceholderRig } from './humanoid-model';
import { buildPlaceholderClips, CLIP_TIMING } from './animation-clips';
import type { PlaceholderClipName } from './animation-clips';
import { resolveRigBones } from './rig';
import type { Rig, RigBoneMap, RigSemantic } from './rig';
import type { AnimState, ClipDefinition } from './animation-controller';

export interface CharacterAsset {
  rig: Rig;
  clips: Map<AnimState, ClipDefinition>;
  /** Semantic joints the source did not provide. */
  missingJoints: RigSemantic[];
  /** Locomotion states left without a usable clip. */
  missingClips: AnimState[];
  source: 'placeholder' | 'gltf';
  /** Non-fatal problems, surfaced in the debug HUD instead of being swallowed. */
  warnings: string[];
}

/** States gameplay relies on; a missing one is reported, not ignored. */
export const REQUIRED_STATES: readonly AnimState[] = [
  'idle', 'walk', 'jog', 'sprint', 'backpedal', 'strafe',
  'crouchIdle', 'crouchWalk', 'jump', 'fall', 'land', 'swim', 'tread',
];

const CLIP_HINTS: readonly [AnimState, RegExp][] = [
  ['crouchIdle', /crouch.*idle|sneak.*idle|idle.*crouch/i],
  ['crouchWalk', /crouch.*(walk|move)|sneak.*(walk|move)|crouch.*crawl/i],
  ['backpedal', /back(ward)?s?|reverse|walkback/i],
  ['strafe', /strafe|sidestep|side.?step/i],
  ['sprint', /sprint|fast.?run/i],
  ['jog', /run|jog/i],
  ['walk', /walk/i],
  ['idle', /idle|breath|stand/i],
  ['jump', /jump|leap|takeoff/i],
  ['fall', /fall|airborne|in.?air/i],
  ['land', /land|impact/i],
  ['swim', /swim/i],
  ['tread', /tread|float|water.?idle/i],
];

/** Snapshot the bind-pose local translations so clips are built from rest data. */
function restMap(bones: RigBoneMap): Map<RigSemantic, Vector3> {
  const map = new Map<RigSemantic, Vector3>();
  for (const [semantic, bone] of bones) map.set(semantic, bone.position.clone());
  return map;
}

function definition(name: PlaceholderClipName, clip: AnimationClip, source: 'placeholder' | 'gltf'): ClipDefinition {
  const timing = CLIP_TIMING[name];
  return { clip, loop: timing.loop, designSpeed: timing.designSpeed, source };
}

/** The fully procedural character: 19 joints, 13 clips, no external assets. */
export function createPlaceholderCharacter(): CharacterAsset {
  const rig = createPlaceholderRig();
  const generated = buildPlaceholderClips(rig.bones, restMap(rig.bones));
  const clips = new Map<AnimState, ClipDefinition>();
  for (const [name, clip] of generated.clips) clips.set(name, definition(name, clip, 'placeholder'));
  return {
    rig,
    clips,
    missingJoints: [],
    missingClips: generated.missing as AnimState[],
    source: 'placeholder',
    warnings: [],
  };
}

/**
 * Load an external humanoid (GLTF/GLB). The asset's own animations are matched to
 * locomotor states by name; any state the file does not cover is filled with the
 * procedural clip built on that asset's bones, so a model with a single idle clip
 * is still playable rather than frozen.
 */
export async function loadCharacterAsset(url: string): Promise<CharacterAsset> {
  const warnings: string[] = [];
  // Loaded on demand: the default placeholder character must not carry the GLTF
  // stack in the main bundle.
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.name = `character (${url.split('/').pop() ?? url})`;

  const skinned: SkinnedMesh[] = [];
  root.traverse((object) => {
    if (object instanceof SkinnedMesh) skinned.push(object);
    if (object instanceof Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  if (skinned.length === 0) throw new Error(`${url} contains no skinned mesh`);

  const resolved = resolveRigBones(root);
  if (resolved.bones.size < 4) throw new Error(`${url} exposes only ${resolved.bones.size} recognisable humanoid joints`);
  if (resolved.missing.length > 0) warnings.push(`missing joints: ${resolved.missing.join(', ')}`);

  const bounds = new Box3().setFromObject(root);
  const height = Math.max(0.6, bounds.max.y - bounds.min.y);
  const clips = new Map<AnimState, ClipDefinition>();
  const importedNames: string[] = [];

  for (const [state, pattern] of CLIP_HINTS) {
    if (clips.has(state)) continue;
    const clip = gltf.animations.find((candidate) => pattern.test(candidate.name));
    if (!clip) continue;
    const name = state as PlaceholderClipName;
    clips.set(state, definition(name, clip, 'gltf'));
    importedNames.push(`${state} <- ${clip.name}`);
  }
  if (clips.size === 0 && gltf.animations[0]) {
    clips.set('idle', definition('idle', gltf.animations[0], 'gltf'));
    importedNames.push(`idle <- ${gltf.animations[0].name}`);
    warnings.push('no animation names matched; first clip used as idle');
  }

  const generated = buildPlaceholderClips(resolved.bones, restMap(resolved.bones));
  for (const [name, clip] of generated.clips) {
    if (clips.has(name)) continue;
    clips.set(name, definition(name, clip, 'placeholder'));
  }

  const missingClips = REQUIRED_STATES.filter((state) => !clips.has(state));
  if (gltf.animations.length === 0) warnings.push('no imported animations; procedural placeholder clips applied');
  else if (importedNames.length < gltf.animations.length) warnings.push(`${importedNames.length}/${gltf.animations.length} imported clips mapped to gameplay states`);

  const rig: Rig = {
    root,
    bones: resolved.bones,
    skeleton: skinned[0]?.skeleton,
    skin: skinned[0],
    height,
    source: 'gltf',
    dispose() {
      root.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) for (const entry of material) entry.dispose();
        else material?.dispose();
      });
    },
  };
  // Clip ownership lives with the AnimationController, which disposes imported and
  // procedural clips alike on teardown; the rig disposes geometry and materials.

  return { rig, clips, missingJoints: resolved.missing, missingClips, source: 'gltf', warnings };
}
