import { PerspectiveCamera, Raycaster, Scene, Vector3 } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import { CONFIG } from '../config';
import type { QualityName } from '../config';
import type { FloatingOrigin } from '../core/floating-origin';
import type { Input } from '../core/input';
import type { TerrainManager } from '../world/terrain-manager';
import { AnimationController } from './animation-controller';
import { CharacterController } from './character-controller';
import type { CharacterEvent, CharacterInputState } from './character-controller';
import { CharacterVisual } from './character-visual';
import { ThirdPersonCamera } from './third-person-camera';
import type { CameraProbe, CameraSettings, CameraTarget } from './third-person-camera';
import { NO_WATER, TerrainCharacterSampler } from './world-sampler';
import { createPlaceholderCharacter, loadCharacterAsset } from './character-assets';
import type { CharacterAsset } from './character-assets';
import type { CharacterSampler, CharacterTuning, WaterQuery } from './locomotion';
import type { RigSemantic } from './rig';

export interface CharacterSystemOptions {
  scene: Scene;
  terrain: TerrainManager;
  origin: FloatingOrigin;
  input: Input;
  quality: QualityName;
  reducedMotion: boolean;
  /** Extra solid geometry (buildings, props) the camera should not pass through. */
  colliders?: Object3D[];
  /**
   * Phase wiring: locomotion solid test for non-terrain geometry (buildings).
   * `feetY` is the character's current foot height; the provider probes at
   * mid-body. Optional — without it the sampler stays terrain-only.
   */
  blocked?: (x: number, z: number, feetY: number) => boolean;
  /** Walkable elevated surface (porch, interior floor) at or above `baseY`. */
  supportHeight?: (x: number, z: number, baseY: number) => number | undefined;
}

export interface CharacterSnapshot {
  spawned: boolean;
  position: [number, number, number];
  yaw: number;
  stance: string;
  animation: string;
  mode: string;
  grounded: boolean;
  sliding: boolean;
  swimming: boolean;
  speed: number;
  verticalSpeed: number;
  distance: number;
  firstPerson: boolean;
  cameraDistance: number;
  cameraPitch: number;
  rig: { source: string; joints: number; clips: number; missingJoints: RigSemantic[]; missingClips: string[]; warnings: string[] };
  safeGround: [number, number, number];
}

const CAMERA_SETTINGS: CameraSettings = { ...CONFIG.personCamera };
const TUNING: CharacterTuning = { ...CONFIG.character };

/**
 * Composition root for the playable human character: rig, animation, locomotion,
 * third-person camera and input mapping. It owns no world streaming; it consumes
 * the existing terrain sampler and reports its canonical world position so the
 * rest of the game (terrain, vegetation, roads) follows the player.
 */
export class CharacterSystem {
  readonly cameraRig = new ThirdPersonCamera(CAMERA_SETTINGS);
  readonly controller = new CharacterController(TUNING);
  private animation?: AnimationController;
  private visual?: CharacterVisual;
  private readonly sampler: TerrainCharacterSampler;
  /** Terrain + optional building solids; what the motion solver actually reads. */
  private readonly motionSampler: CharacterSampler;
  private readonly raycaster = new Raycaster();
  private readonly probe: CameraProbe;
  private readonly colliders: Object3D[];
  private readonly previous = new Vector3();
  private readonly interpolated = new Vector3();
  private readonly localEye = new Vector3();
  private readonly target: CameraTarget = {
    x: 0, y: 0, z: 0, anchorHeight: 1.42, speed: 0, swimming: false, verticalSpeed: 0,
  };
  private readonly spawnWorld = new Vector3();
  private readonly safeGround = new Vector3();
  private readonly lookDirection = new Vector3();
  private spawnX = 0;
  private spawnZ = 0;
  private spawnYaw: number | null = null;
  private spawned = false;
  private wasJumpHeld = false;
  private water: WaterQuery = NO_WATER;
  private asset: CharacterAsset | null = null;
  private disposed = false;
  active = true;
  onEvent?: (event: CharacterEvent) => void;

  constructor(private readonly options: CharacterSystemOptions) {
    this.sampler = new TerrainCharacterSampler(options.terrain);
    // One sampler for the motion solver: terrain contact first, then any
    // walkable building top (porch / interior floor) the player can step onto,
    // and the building solid test for wall sliding. Without providers this
    // degrades to exactly the old terrain-only behaviour.
    const terrain = this.sampler;
    const blocked = options.blocked;
    const supportHeight = options.supportHeight;
    this.motionSampler = {
      contact: (x, z, out) => {
        const contact = terrain.contact(x, z, out);
        if (!contact) return contact;
        const support = supportHeight?.(x, z, out.height);
        if (support !== undefined && support > out.height && support - out.height <= 0.55) {
          out.height = support;
          out.normal.set(0, 1, 0);
        }
        return contact;
      },
      blocked: blocked ? (x, z, feetY) => blocked(x, z, feetY) : undefined,
    };
    this.colliders = options.colliders ?? [];
    this.probe = {
      groundHeight: (x, z) => this.sampler.groundHeight(x, z),
      raycast: (ox, oy, oz, dx, dy, dz, maxDistance) => this.raycastColliders(ox, oy, oz, dx, dy, dz, maxDistance),
    };
    this.install(createPlaceholderCharacter());
  }

  /** Swap in an external humanoid; failures fall back to the placeholder rig. */
  async loadAsset(url?: string | null): Promise<void> {
    if (!url) return;
    try {
      const asset = await loadCharacterAsset(url);
      if (this.disposed) return;
      this.install(asset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.asset?.warnings.push(`character asset failed: ${message}`);
      console.warn('[Wayfarer character]', message);
    }
  }

  private install(asset: CharacterAsset): void {
    const previousVisual = this.visual;
    if (previousVisual) {
      this.options.scene.remove(previousVisual.root);
      previousVisual.dispose();
    }
    this.asset = asset;
    this.animation = new AnimationController(asset.rig.root, asset.rig.bones, asset.clips.entries(), { rootMotion: false });
    this.visual = new CharacterVisual(asset.rig, this.animation);
    this.visual.root.traverse((object) => {
      const mesh = object as { castShadow?: boolean; receiveShadow?: boolean; isMesh?: boolean };
      if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
    });
    this.options.scene.add(this.visual.root);
    this.visual.root.visible = this.spawned;
  }

  setWater(query: WaterQuery | null): void { this.water = query ?? NO_WATER; }

  /** Queue a spawn at a canonical world XZ; the ground is resolved when streamed. */
  spawnAt(x: number, z: number, yaw?: number): void {
    this.spawnX = x;
    this.spawnZ = z;
    this.spawnYaw = yaw ?? null;
    this.spawned = false;
    this.cameraRig.reset();
    this.applySpawnYaw();
    if (this.visual) this.visual.root.visible = false;
  }

  /** Saved camera yaw (radians); restored through `spawnAt(x, z, yaw)`. */
  get yaw(): number { return this.cameraRig.yaw; }

  /**
   * Re-apply a restored yaw after any reset. The camera rig owns the look
   * direction; the body faces away from it (body yaw = camera yaw + π, the
   * same relation `visualPose` uses every frame).
   */
  private applySpawnYaw(): void {
    if (this.spawnYaw === null) return;
    this.cameraRig.yaw = this.spawnYaw;
    this.controller.yaw = this.spawnYaw + Math.PI;
  }

  get position(): Vector3 { return this.controller.position; }
  /** True while the controller is in the swim mode (used for wake effects). */
  get swimming(): boolean { return this.controller.swimming; }
  /** Horizontal speed of the locomotion state, metres per second. */
  get controllerSpeed(): number { return this.controller.motion.horizontalSpeed; }
  get ready(): boolean { return this.spawned; }
  get camera(): PerspectiveCamera { return this.cameraRig.camera; }
  get isFirstPerson(): boolean { return this.cameraRig.firstPerson; }
  get rigSource(): 'placeholder' | 'gltf' { return this.asset?.source ?? 'placeholder'; }

  setFirstPerson(enabled: boolean): void { this.cameraRig.setFirstPerson(enabled); }
  toggleFirstPerson(): boolean { this.cameraRig.setFirstPerson(!this.cameraRig.firstPerson); return this.cameraRig.firstPerson; }
  setSensitivity(value: number): void { this.cameraRig.sensitivity = value; }
  toggleShoulder(): void { this.cameraRig.toggleShoulder(); }

  fixedUpdate(dt: number): void {
    if (this.disposed || !this.active) return;
    if (!this.spawned) {
      if (!this.attemptSpawn()) return;
    }
    const input = this.options.input;
    const held = input.down('Space');
    const jumpPressed = held && !this.wasJumpHeld;
    this.wasJumpHeld = held;
    const state: CharacterInputState = {
      forward: Number(input.down('KeyW', 'ArrowUp')) - Number(input.down('KeyS', 'ArrowDown')),
      right: Number(input.down('KeyD')) - Number(input.down('KeyA')),
      sprint: input.down('ShiftLeft', 'ShiftRight'),
      walk: input.down('AltLeft', 'AltRight'),
      crouch: input.down('ControlLeft', 'ControlRight'),
      strafeLock: input.down('KeyX'),
      jumpHeld: held,
      jumpPressed,
    };
    this.previous.copy(this.controller.position);
    this.controller.fixedUpdate(dt, state, this.cameraRig.yaw, this.motionSampler, this.water);
    // Canonical position drives the floating origin, so the whole streamed world
    // follows the player instead of a survey camera.
    this.options.origin.update(this.controller.position);
    if (this.controller.grounded && !this.controller.motion.sliding) this.safeGround.copy(this.controller.position);
    if (this.controller.fellOutOfWorld(this.spawnWorld.y)) {
      console.warn('[Wayfarer character] fell outside the world; returning to safe ground');
      this.controller.spawn(this.safeGround.x, this.safeGround.y + 0.1, this.safeGround.z);
      this.previous.copy(this.controller.position);
      this.cameraRig.reset();
    }
    if (this.animation?.rootMotionEnabled) {
      const delta = new Vector3();
      if (this.animation.consumeRootMotion(delta)) {
        this.controller.position.add(delta);
        this.options.origin.update(this.controller.position);
      }
    }
  }

  /** Per-frame presentation: interpolate the fixed step, then solve the camera. */
  render(dt: number, alpha: number): void {
    if (this.disposed || !this.visual || !this.active || !this.spawned) return;
    const look = this.options.input.consumeLook();
    if (look.x !== 0 || look.y !== 0) this.cameraRig.look(look.x, look.y);
    if (this.options.input.wheel !== 0) {
      // Wheel up (negative delta) pulls the boom in, matching the survey camera.
      this.cameraRig.zoom(-this.options.input.wheel);
      this.options.input.wheel = 0;
    }
    this.interpolated.lerpVectors(this.previous, this.controller.position, alpha);
    const firstPerson = this.cameraRig.firstPerson;
    this.target.x = this.interpolated.x;
    this.target.y = this.interpolated.y;
    this.target.z = this.interpolated.z;
    this.target.anchorHeight = firstPerson
      ? TUNING.eyeHeight + this.controller.eyeBob()
      : Math.min(1.45, this.asset?.rig.height ?? TUNING.height) * 0.82;
    this.target.speed = this.controller.motion.horizontalSpeed;
    this.target.swimming = this.controller.swimming;
    this.target.verticalSpeed = this.controller.motion.velocity.y;
    this.cameraRig.update(dt, this.target, this.probe, this.options.origin.absolute, this.localEye);

    const cameraYaw = this.cameraRig.yaw + Math.PI;
    let lookYaw = cameraYaw - this.controller.yaw;
    lookYaw = Math.atan2(Math.sin(lookYaw), Math.cos(lookYaw));
    // Reduced-motion users keep the authored clips but lose procedural head sway.
    const headLook = this.options.reducedMotion ? 0 : 1;
    this.visual.update(dt, {
      world: this.interpolated,
      originAbsolute: this.options.origin.absolute,
      groundNormal: this.controller.motion.groundNormal,
      yaw: this.controller.yaw,
      speed: this.controller.motion.horizontalSpeed,
      swimming: this.controller.swimming,
      grounded: this.controller.grounded,
      animation: this.controller.animation,
      lookYaw: lookYaw * headLook,
      cameraPitch: this.cameraRig.pitch * headLook,
      firstPerson: this.cameraRig.firstPerson,
    });
  }

  /** Reset the character to the current spawn point (camera and motion state). */
  respawn(): void {
    const ground = this.sampler.groundHeight(this.spawnX, this.spawnZ);
    if (ground === undefined) return;
    this.controller.spawn(this.spawnX, ground + 0.05, this.spawnZ);
    this.previous.copy(this.controller.position);
    this.cameraRig.reset();
    this.applySpawnYaw();
    this.spawned = true;
    if (this.visual) this.visual.root.visible = true;
  }

  private attemptSpawn(): boolean {
    const ground = this.sampler.groundHeight(this.spawnX, this.spawnZ);
    if (ground === undefined) return false;
    // Streamed tiles are centred on the origin grid; heightAt() integrates the
    // same triangles the renderer draws, so the spawn is exact.
    this.controller.spawn(this.spawnX, ground + 0.05, this.spawnZ);
    this.previous.copy(this.controller.position);
    this.spawnWorld.copy(this.controller.position);
    this.safeGround.copy(this.controller.position);
    this.cameraRig.reset();
    this.applySpawnYaw();
    this.spawned = true;
    if (this.visual) this.visual.root.visible = true;
    this.options.origin.update(this.controller.position);
    return true;
  }

  /** World-space ray test against registered solids, converted to origin-local. */
  private raycastColliders(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): number {
    if (this.colliders.length === 0) return Infinity;
    const origin = this.options.origin.absolute;
    this.lookDirection.set(dx, dy, dz).normalize();
    this.raycaster.set(
      new Vector3(ox - origin.x, oy - origin.y, oz - origin.z),
      this.lookDirection,
    );
    this.raycaster.far = maxDistance;
    const hits = this.raycaster.intersectObjects(this.colliders, true);
    return hits.length > 0 ? hits[0]!.distance : Infinity;
  }

  snapshot(): CharacterSnapshot {
    const diagnostics = this.controller.diagnostics();
    return {
      spawned: this.spawned,
      position: this.controller.position.toArray(),
      yaw: this.controller.yaw,
      stance: diagnostics.stance,
      animation: diagnostics.animation,
      mode: diagnostics.mode,
      grounded: diagnostics.grounded,
      sliding: diagnostics.sliding,
      swimming: this.controller.swimming,
      speed: diagnostics.speed,
      verticalSpeed: diagnostics.verticalSpeed,
      distance: diagnostics.distanceTravelled,
      firstPerson: this.cameraRig.firstPerson,
      cameraDistance: this.cameraRig.distance,
      cameraPitch: this.cameraRig.pitch,
      rig: {
        source: this.asset?.source ?? 'placeholder',
        joints: this.asset?.rig.bones.size ?? 0,
        clips: this.asset?.clips.size ?? 0,
        missingJoints: this.asset?.missingJoints ?? [],
        missingClips: (this.asset?.missingClips ?? []) as string[],
        warnings: this.asset?.warnings ?? [],
      },
      safeGround: this.safeGround.toArray(),
    };
  }

  resize(): void { this.cameraRig.resize(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.visual) this.options.scene.remove(this.visual.root);
    this.visual?.dispose();
    this.visual = undefined;
    this.animation = undefined;
    this.asset = null;
  }
}
