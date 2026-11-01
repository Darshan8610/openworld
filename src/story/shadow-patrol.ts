import { Group, Mesh, CylinderGeometry, SphereGeometry, MeshStandardMaterial } from 'three/webgpu';

/**
 * The thing that circles the Forestry Station.
 *
 * Act II's evasion beat: a tall, non-human silhouette patrols an orbit around
 * the compound while Jack works the dispatch desk. Detection blends three
 * signals the player actually controls — distance, stance (crouch walks are
 * nearly invisible, sprints carry) and line of sight against the same camera
 * solids the third-person camera collides with (walls, trees of buildings,
 * the barrier dressing). Break line of sight and it loses interest after a
 * short hunt; reaching the terminal while it is still hunting credits no
 * `evaded_patrol` flag.
 *
 * Pure logic lives in `update()` so the whole detection contract is unit
 * testable without a renderer; the silhouette is a handful of primitives.
 */

export interface PatrolPlayer {
  readonly x: number;
  readonly z: number;
  /** Only people on foot are hunted — steel cages are ignored. */
  readonly onFoot: boolean;
  readonly crouched: boolean;
  readonly sprinting: boolean;
  /** Flashlight beam cutting the dark — light carries, and it carries far. */
  readonly lit: boolean;
  /** Camera/controller yaw (unused by detection; kept for caller convenience). */
  readonly yaw: number;
}

export interface ShadowPatrolDeps {
  readonly ground: (x: number, z: number) => number;
  /** True when solids occlude the segment (patrol eye ↔ player chest). */
  readonly losBlocked: (ax: number, az: number, bx: number, bz: number) => boolean;
  /** Fired once per detection streak (not every frame it stays visible). */
  readonly onSpotted: (timesSpotted: number) => void;
}

/** Standing detection envelope, metres (before stance modifiers). */
const SIGHT_UPRIGHT = 19;
const CROUCH_BONUS = -11;
const SPRINT_PENALTY = 5;
/** Seconds without a fresh sighting before the hunt ends. */
const SEARCH_SECONDS = 12;

export class ShadowPatrol {
  readonly group = new Group();
  private readonly figure: Group;
  /** Orbit centre (Forestry Station compound). */
  private readonly cx: number;
  private readonly cz: number;
  private readonly radius: number;
  private angle: number;
  private readonly speed = 3.1;
  private readonly huntSpeed = 6.4;
  private hunting = false;
  private searchTimer = 0;
  private spottedTotal = 0;
  private lastSeenX = 0;
  private lastSeenZ = 0;
  private clock = 0;
  private positionX: number;
  private positionZ: number;

  constructor(center: { x: number; z: number }, radius: number, private readonly deps: ShadowPatrolDeps) {
    this.cx = center.x;
    this.cz = center.z;
    this.radius = radius;
    this.angle = 0.6;
    this.positionX = this.cx + Math.cos(this.angle) * radius;
    this.positionZ = this.cz + Math.sin(this.angle) * radius;

    // A too-tall, too-thin silhouette: shoulders, elongated head, no face.
    const dark = new MeshStandardMaterial({ color: 0x05070a, roughness: 1, metalness: 0, emissive: 0x070b10, emissiveIntensity: 0.6 });
    const body = new Mesh(new CylinderGeometry(0.34, 0.2, 1.9, 7), dark);
    body.position.y = 1.05;
    const head = new Mesh(new SphereGeometry(0.21, 8, 6), dark);
    head.position.y = 2.16;
    head.scale.y = 1.45;
    this.figure = new Group();
    this.figure.add(body, head);
    this.group.add(this.figure);
    this.group.name = 'story/shadow-patrol';
    this.group.visible = false;
  }

  /** Act gating: only the station investigation wakes it. */
  get active(): boolean { return this.group.visible; }
  set active(value: boolean) {
    if (this.group.visible === value) return;
    this.group.visible = value;
    this.hunting = false;
    this.searchTimer = 0;
    if (value) {
      // Fresh orbit far from the dispatch desk when the hunt begins.
      this.angle = 2.2;
      this.positionX = this.cx + Math.cos(this.angle) * this.radius;
      this.positionZ = this.cz + Math.sin(this.angle) * this.radius;
    }
  }

  get timesSpotted(): number { return this.spottedTotal; }
  /** True while it is still actively hunting the player. */
  get searching(): boolean { return this.active && this.hunting; }
  /** Where it believes the player is (last confirmed sighting). */
  get lastKnown(): { x: number; z: number } { return { x: this.lastSeenX, z: this.lastSeenZ }; }
  get position(): { x: number; z: number } { return { x: this.positionX, z: this.positionZ }; }

  /** Reachable while hunting? Used by the terminal to credit `evaded_patrol`. */
  creditsEvade(): boolean { return !this.searching; }

  /** Detection envelope for a stance — exposed for tests and tuning. */
  static sightRange(player: Pick<PatrolPlayer, 'crouched' | 'sprinting' | 'lit'>): number {
    return Math.max(4, SIGHT_UPRIGHT
      + (player.crouched ? CROUCH_BONUS : 0)
      + (player.sprinting ? SPRINT_PENALTY : 0)
      + (player.lit ? SPRINT_PENALTY : 0));
  }

  update(dt: number, player: PatrolPlayer): void {
    if (!this.active || dt <= 0) return;
    this.clock += dt;

    const sees = this.detects(player);
    if (sees) {
      this.lastSeenX = player.x;
      this.lastSeenZ = player.z;
      if (!this.hunting) {
        this.hunting = true;
        this.spottedTotal += 1;
        this.deps.onSpotted(this.spottedTotal);
      }
      this.searchTimer = SEARCH_SECONDS;
    } else if (this.hunting) {
      this.searchTimer -= dt;
      if (this.searchTimer <= 0) this.hunting = false;
    }

    // Movement: lazy orbit when calm, direct pursuit of the last sighting.
    if (this.hunting) {
      const dx = this.lastSeenX - this.positionX;
      const dz = this.lastSeenZ - this.positionZ;
      const distance = Math.hypot(dx, dz);
      if (distance > 1.4) {
        const step = Math.min(this.huntSpeed * dt, distance);
        this.positionX += (dx / distance) * step;
        this.positionZ += (dz / distance) * step;
      }
    } else {
      this.angle += (this.speed / this.radius) * dt;
      // Gentle organic wobble so the orbit never reads as a turntable.
      const wobble = Math.sin(this.clock * 0.53) * 2.4;
      const targetX = this.cx + Math.cos(this.angle) * (this.radius + wobble);
      const targetZ = this.cz + Math.sin(this.angle) * (this.radius + wobble);
      this.positionX += (targetX - this.positionX) * Math.min(1, dt * 3);
      this.positionZ += (targetZ - this.positionZ) * Math.min(1, dt * 3);
    }

    const ground = this.deps.ground(this.positionX, this.positionZ);
    // Hover a hand's width off the ground; the bob sells the wrongness.
    const bob = Math.sin(this.clock * 2.1) * 0.07;
    this.figure.position.set(this.positionX, ground + 0.12 + bob, this.positionZ);
    const faceX = this.hunting ? this.lastSeenX : this.cx;
    const faceZ = this.hunting ? this.lastSeenZ : this.cz;
    this.figure.rotation.y = Math.atan2(faceX - this.positionX, faceZ - this.positionZ);
    // The silhouette sways like something remembering how to stand.
    this.figure.rotation.z = Math.sin(this.clock * 1.35) * 0.045;
  }

  private detects(player: PatrolPlayer): boolean {
    if (!player.onFoot) return false;
    const dx = player.x - this.positionX;
    const dz = player.z - this.positionZ;
    const distance = Math.hypot(dx, dz);
    if (distance > ShadowPatrol.sightRange(player)) return false;
    if (this.deps.losBlocked(this.positionX, this.positionZ, player.x, player.z)) return false;
    return true;
  }

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) for (const entry of material) entry.dispose();
      else material?.dispose();
    });
    this.group.clear();
  }
}
