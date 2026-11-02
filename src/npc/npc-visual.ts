import {
  Color, CylinderGeometry, Group, Mesh, MeshStandardNodeMaterial, Object3D, SphereGeometry, Vector3,
} from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { AnimationController } from '../character/animation-controller';
import type { AnimState } from '../character/animation-controller';
import { CharacterVisual } from '../character/character-visual';
import type { VisualState } from '../character/character-visual';
import { createPlaceholderCharacter } from '../character/character-assets';
import type { WorldPoint } from '../core/coordinates';
import type { NpcDefinition } from './types';
import { buildUniqueHeadAccessories } from './npc-face';

/**
 * NPC rendering, in two honest fidelity tiers:
 *
 *  - **Rigged** — the same skinned 19-j oint placeholder humanoid, `AnimationMixer`
 *    and `CharacterVisual` the player uses, with a role tint. Used for the nearest
 *    NPCs, bounded by the quality preset's rig budget.
 *  - **Proxy** — a cheap procedural stand-in (torso, head, legs) that walks, turns
 *    and bobs. Explicitly a reduced-detail representation, not a fake animation
 *    system, and used only beyond the full-fidelity band.
 *
 * Background NPCs have no visual at all (the manager does not acquire one).
 * Visuals are pooled, so walking in and out of the rig band does not churn GPU
 * resources.
 */

export interface NpcPose {
  /** Canonical world position of the feet. */
  readonly world: WorldPoint;
  readonly origin: WorldPoint;
  readonly yaw: number;
  readonly speed: number;
  readonly animation: AnimState;
  /** Ground normal, used to align the body on slopes. */
  readonly groundNormal: Vector3;
  /** Head look offset in radians (towards the player). */
  readonly lookYaw: number;
}

export interface NpcVisual {
  readonly root: Object3D;
  /** True when this visual drives a skinned rig and mixer. */
  readonly rigged: boolean;
  /** Role key used for pooling. */
  readonly role: string;
  /** Role accent used for pooling. */
  readonly accent: number;
  configureNpc?(id: string): void;
  update(dt: number, pose: NpcPose): void;
  dispose(): void;
}

const TINT_STRENGTH = 0.45;

/** Full-fidelity NPC: shared player rig + animation controller, role-tinted. */
export class RiggedNpcVisual implements NpcVisual {
  readonly root: Object3D;
  readonly rigged = true;
  readonly role: string;
  readonly accent: number;
  private readonly asset = createPlaceholderCharacter();
  private readonly animation: AnimationController;
  private readonly visual: CharacterVisual;
  private readonly world = new Vector3();
  private readonly origin = new Vector3();
  private readonly state: VisualState;
  private readonly tint = new Color();

  constructor(private readonly definition: NpcDefinition) {
    this.role = definition.role;
    this.accent = definition.accent;
    this.animation = new AnimationController(this.asset.rig.root, this.asset.rig.bones, this.asset.clips.entries());
    this.visual = new CharacterVisual(this.asset.rig, this.animation);
    this.visual.root.name = `npc/${definition.role}`;
    this.asset.rig.root.scale.setScalar(definition.heightScale);
    this.applyTint();
    this.state = {
      world: this.world, originAbsolute: this.origin, groundNormal: new Vector3(0, 1, 0),
      yaw: 0, speed: 0, swimming: false, grounded: true, animation: 'idle',
      lookYaw: 0, cameraPitch: 0, firstPerson: false,
    };
    this.root = this.visual.root;
  }

  configureNpc(id: string): void {
    const headBone = this.asset.rig.bones.get('head');
    if (headBone) {
      buildUniqueHeadAccessories(headBone, id);
    }
  }

  update(dt: number, pose: NpcPose): void {
    this.world.set(pose.world.x, pose.world.y, pose.world.z);
    this.origin.set(pose.origin.x, pose.origin.y, pose.origin.z);
    this.state.yaw = pose.yaw;
    this.state.speed = pose.speed;
    this.state.animation = pose.animation;
    this.state.groundNormal.copy(pose.groundNormal);
    this.state.lookYaw = pose.lookYaw;
    this.visual.update(dt, this.state);
  }

  dispose(): void {
    this.visual.root.removeFromParent();
    this.visual.dispose();
  }

  /** Blend the role accent into the placeholder outfit, leaving skin tones visible. */
  private applyTint(): void {
    const mesh = this.asset.rig.skin;
    if (!mesh) return;
    const material = mesh.material as Material & { color?: Color };
    if (!material.color) return;
    this.tint.setHex(this.definition.accent);
    material.color.setRGB(
      1 + (this.tint.r - 1) * TINT_STRENGTH,
      1 + (this.tint.g - 1) * TINT_STRENGTH,
      1 + (this.tint.b - 1) * TINT_STRENGTH,
    );
  }
}

/* Shared proxy resources: created once, reused by every proxy NPC. */
let proxyTorso: CylinderGeometry | undefined;
let proxyHead: SphereGeometry | undefined;
let proxyLeg: CylinderGeometry | undefined;
const proxyMaterials = new Map<number, MeshStandardNodeMaterial>();

function proxyMaterial(accent: number): MeshStandardNodeMaterial {
  const cached = proxyMaterials.get(accent);
  if (cached) return cached;
  const material = new MeshStandardNodeMaterial({ color: accent, roughness: 0.85, metalness: 0.02 });
  material.name = `npc/proxy/${accent.toString(16)}`;
  proxyMaterials.set(accent, material);
  return material;
}

/** Cheap reduced-detail stand-in used beyond the rigged band. */
export class ProxyNpcVisual implements NpcVisual {
  readonly root = new Group();
  readonly rigged = false;
  readonly role: string;
  readonly accent: number;
  private readonly body: Mesh;
  private readonly head: Mesh;
  private readonly legs: Mesh;
  private readonly material: MeshStandardNodeMaterial;
  private phase = 0;

  constructor(definition: NpcDefinition) {
    this.role = definition.role;
    this.accent = definition.accent;
    proxyTorso ??= new CylinderGeometry(0.19, 0.22, 0.62, 8);
    proxyHead ??= new SphereGeometry(0.115, 10, 8);
    proxyLeg ??= new CylinderGeometry(0.075, 0.065, 0.78, 6);
    this.material = proxyMaterial(definition.accent);
    this.body = new Mesh(proxyTorso, this.material);
    this.body.position.y = 1.15;
    this.head = new Mesh(proxyHead, this.material);
    this.head.position.y = 1.58;
    this.legs = new Mesh(proxyLeg, this.material);
    this.legs.position.y = 0.39;
    for (const part of [this.body, this.head, this.legs]) {
      part.castShadow = true;
      part.receiveShadow = true;
      this.root.add(part);
    }
    this.root.name = `npc/${definition.role}/proxy`;
    this.root.scale.setScalar(definition.heightScale);
  }

  configureNpc(id: string): void {
    buildUniqueHeadAccessories(this.head, id);
  }

  update(dt: number, pose: NpcPose): void {
    this.root.position.set(
      pose.world.x - pose.origin.x,
      pose.world.y - pose.origin.y,
      pose.world.z - pose.origin.z,
    );
    this.root.rotation.y = pose.yaw;
    const moving = Math.min(1, pose.speed / 2);
    this.phase += dt * (3 + pose.speed * 1.8);
    // A visible gait cue so a proxy still reads as walking rather than sliding.
    this.root.position.y += Math.abs(Math.sin(this.phase)) * 0.045 * moving;
    const resting = pose.animation === 'crouchIdle';
    this.body.position.y = resting ? 0.86 : 1.15;
    this.head.position.y = resting ? 1.24 : 1.58;
    this.legs.scale.y = resting ? 0.6 : 1;
    this.legs.position.y = resting ? 0.3 : 0.39;
    this.head.rotation.y = pose.lookYaw;
  }

  dispose(): void { this.root.removeFromParent(); }
}

/**
 * Visual pool. Rigs are expensive (skinned geometry, skeleton, 13 clips) so at
 * most one spare of each role is recycled; proxies are cheap and pooled per
 * accent. Nothing here outlives `dispose()`.
 */
export class NpcVisualPool {
  private readonly rigs = new Map<string, RiggedNpcVisual[]>();
  private readonly proxies = new Map<number, ProxyNpcVisual[]>();
  private readonly live = new Set<NpcVisual>();

  acquire(definition: NpcDefinition, rigged: boolean, id?: string): NpcVisual {
    const visual = rigged ? (this.rigs.get(definition.role)?.pop() ?? new RiggedNpcVisual(definition)) : (this.proxies.get(definition.accent)?.pop() ?? new ProxyNpcVisual(definition));
    if (id && visual.configureNpc) {
      visual.configureNpc(id);
    }
    this.live.add(visual);
    return visual;
  }

  release(visual: NpcVisual): void {
    if (!this.live.delete(visual)) return;
    visual.root.removeFromParent();
    if (visual instanceof RiggedNpcVisual) {
      const pool = this.rigs.get(visual.role) ?? [];
      // One spare rig per role is enough to absorb level-boundary crossings.
      if (pool.length < 1) pool.push(visual);
      else visual.dispose();
      this.rigs.set(visual.role, pool);
      return;
    }
    const proxy = visual as ProxyNpcVisual;
    const pool = this.proxies.get(proxy.accent) ?? [];
    if (pool.length < 4) pool.push(proxy);
    else proxy.dispose();
    this.proxies.set(proxy.accent, pool);
  }

  get liveCount(): number { return this.live.size; }

  dispose(): void {
    for (const visual of this.live) visual.dispose();
    this.live.clear();
    for (const pool of this.rigs.values()) for (const visual of pool) visual.dispose();
    this.rigs.clear();
    for (const pool of this.proxies.values()) for (const visual of pool) visual.dispose();
    this.proxies.clear();
    proxyTorso?.dispose(); proxyTorso = undefined;
    proxyHead?.dispose(); proxyHead = undefined;
    proxyLeg?.dispose(); proxyLeg = undefined;
    for (const material of proxyMaterials.values()) material.dispose();
    proxyMaterials.clear();
  }
}
