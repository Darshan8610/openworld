import { Vector3 } from 'three/webgpu';
import { CONFIG } from '../config';
import { CharacterMotion } from '../character/locomotion';
import type { CharacterSampler, CharacterTuning, GroundContact, WaterQuery } from '../character/locomotion';
import type { AnimState } from '../character/animation-controller';
import { hashSeed, seededRandom } from '../utils/random';
import { clamp } from '../utils/math';
import type { WorldPoint } from '../core/coordinates';
import { toRenderPoint } from '../core/coordinates';
import type { SimulationLevel } from '../game/entity';
import type { ObjectState } from '../objects/archetypes';
import type { PersistencePolicy } from '../core/entities';
import type { InteractionAction, InteractionArchetype, InteractionContext, InteractionProvider } from '../interaction/types';
import { Perception } from './perception';
import type { NavigationService } from './navigation';
import { NpcBrain } from './behaviour';
import type { NpcAgent } from './behaviour';
import { resolveActivity, scheduleFor, scheduleOffset } from './schedule';
import type { ScheduleEntry } from './schedule';
import type { NpcActivity, NpcDefinition, NpcBehaviourId, NpcRecord, PlacedNpc } from './types';
import type { NpcPose, NpcVisual } from './npc-visual';
import type { NpcGroundSampler } from './npc-sampler';
import type { WorldQueries } from '../world/world-queries';

/** Shared capsule tuning: NPCs move through the same solver as the player. */
const NPC_TUNING: CharacterTuning = { ...CONFIG.character, radius: 0.32, height: 1.76, eyeHeight: 1.6 };

/** Perception cadence (Hz). Sight is LOS-heavy, so it does not run at 120 Hz. */
const PERCEPTION_HZ = 7;
const EYE_HEIGHT = 1.6;
/** Separation radius from neighbouring NPCs, metres. */
const SEPARATION_RADIUS = 1.5;

export interface NpcInstanceOptions {
  readonly placed: PlacedNpc;
  readonly definition: NpcDefinition;
  readonly navigation: NavigationService;
  readonly ground: NpcGroundSampler;
  readonly queries: WorldQueries;
  readonly water?: WaterQuery;
  /** Called when the player uses the interaction system on this NPC. */
  readonly requestTalk: (npc: NpcInstance) => void;
  /** Called when the NPC is removed from the world. */
  readonly requestRemove: (npc: NpcInstance) => void;
}

/**
 * One simulated character.
 *
 * It owns a real capsule motion solver (the player's), a perception system, a
 * behaviour tree and an interaction provider; it owns no world streaming and no
 * meshes beyond its own pooled visual. Position is canonical world metres, so a
 * floating-origin rebase never moves an NPC in simulation space — the visual is
 * recomputed from `canonical - origin` every frame.
 */
export class NpcInstance implements NpcAgent, InteractionProvider, CharacterSampler {
  readonly id: string;
  readonly role;
  readonly definition: NpcDefinition;
  readonly placed: PlacedNpc;
  readonly anchors;
  readonly motion = new CharacterMotion(NPC_TUNING);
  readonly perception: Perception;
  readonly navigation: NavigationService;
  readonly random: () => number;
  readonly archetype: InteractionArchetype;
  readonly persistence: PersistencePolicy = 'world';
  readonly centre: WorldPoint = { x: 0, y: 0, z: 0 };

  behaviour: NpcBehaviourId = 'idle';
  activity: NpcActivity = 'wander';
  level: SimulationLevel = 0;
  /** Reduced/background think accumulator, owned here so the manager stays stateless. */
  reducedAccumulator = 0;
  talking = false;
  talked = false;
  visual: NpcVisual | undefined;

  private readonly brain: NpcBrain;
  private readonly schedule: readonly ScheduleEntry[];
  private readonly phaseHours: number;
  private readonly ground: NpcGroundSampler;
  private readonly water?: WaterQuery;
  private readonly requestTalk: (npc: NpcInstance) => void;
  private readonly requestRemove: (npc: NpcInstance) => void;
  private readonly actionList: readonly InteractionAction[];
  private readonly stateValue: ObjectState = {};
  private readonly previous = new Vector3();
  private readonly renderPoint: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly groundNormal = new Vector3(0, 1, 0);
  private readonly playerPoint: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly facePoint: WorldPoint = { x: 0, y: 0, z: 0 };

  private path: WorldPoint[] = [];
  private pathTarget: WorldPoint | undefined;
  private desiredTarget: WorldPoint | undefined;
  private desiredSpeed = 0;
  private searchCooldown = 0;
  private perceptionTimer = 0;
  private thoughtTime = 0;
  private yawValue = 0;
  private desiredYaw = 0;
  private hasFacePoint = false;
  private separationX = 0;
  private separationZ = 0;
  private distance = Number.POSITIVE_INFINITY;

  constructor(options: NpcInstanceOptions) {
    this.id = options.placed.id;
    this.definition = options.definition;
    this.role = options.placed.role;
    this.placed = options.placed;
    this.anchors = options.placed.anchors;
    this.navigation = options.navigation;
    this.ground = options.ground;
    this.water = options.water;
    this.requestTalk = options.requestTalk;
    this.requestRemove = options.requestRemove;
    this.random = seededRandom(hashSeed(`${options.placed.id}:ai`));
    this.schedule = scheduleFor(options.definition.schedule);
    this.phaseHours = scheduleOffset(hashSeed(options.placed.id), options.placed.role.length);
    this.perception = new Perception(options.queries);
    this.brain = new NpcBrain(this, this.schedule, this.phaseHours);
    this.archetype = { key: `npc:${options.placed.role}`, label: options.definition.label };
    this.actionList = [{
      id: 'talk',
      label: () => (this.talking ? 'End conversation' : 'Talk'),
      key: 'E',
      run: (_context: InteractionContext) => { this.requestTalk(this); },
    }];
    this.yawValue = options.placed.yaw;
    this.desiredYaw = options.placed.yaw;
    this.motion.place(options.placed.x, options.placed.y, options.placed.z);
    this.previous.copy(this.motion.position);
    this.updateCentre();
  }

  /* ---- identity & interaction ------------------------------------------- */

  get position(): WorldPoint { return this.motion.position; }
  get speed(): number { return CONFIG.npc.speeds.walk * this.definition.speedScale; }
  get alertDistance(): number { return this.definition.alertDistance; }
  get player(): WorldPoint { return this.playerPoint; }
  get now(): number { return this.thoughtTime; }
  get yaw(): number { return this.yawValue; }
  get distanceToPlayer(): number { return this.distance; }
  get walkSpeed(): number { return this.motion.horizontalSpeed; }

  get radius(): number { return 0.45; }
  get range(): number { return CONFIG.npc.talkRange; }
  get targetLabel(): string { return this.definition.label; }

  actions(): readonly InteractionAction[] { return this.actionList; }

  state(): ObjectState { return this.stateValue; }

  setState(patch: Partial<ObjectState>): void {
    if (patch.visited !== undefined) this.talked = patch.visited;
    if (patch.open !== undefined) this.talking = patch.open;
    this.stateValue.visited = this.talked;
  }

  remove(): void { this.requestRemove(this); }

  /** Facing target used while talking or working. */
  face(x: number, z: number): void {
    this.facePoint.x = x; this.facePoint.z = z;
    this.hasFacePoint = true;
  }

  setBehaviour(behaviour: NpcBehaviourId): void { this.behaviour = behaviour; }

  /* ---- motion ------------------------------------------------------------ */

  contact(x: number, z: number, out: GroundContact): GroundContact | undefined {
    return this.ground.contact(x, z, out);
  }

  blocked(x: number, z: number): boolean {
    if (this.ground.blocked(x, z)) return true;
    // Do not walk through the player, but never deadlock while already overlapping.
    if (this.distance > 0.85) {
      const dx = x - this.playerPoint.x, dz = z - this.playerPoint.z;
      if (dx * dx + dz * dz < 0.55 * 0.55) return true;
    }
    return false;
  }

  /**
   * Look `distance` metres ahead along the current travel intent (or facing when
   * standing still) and report whether that step is impassable.
   */
  probeAhead(distance = 2): boolean {
    let dx = 0, dz = 0;
    const target = this.desiredTarget;
    if (target) { dx = target.x - this.position.x; dz = target.z - this.position.z; }
    const length = Math.hypot(dx, dz);
    if (length < 0.05) { dx = Math.sin(this.yawValue); dz = Math.cos(this.yawValue); }
    else { dx /= length; dz /= length; }
    return this.blocked(this.position.x + dx * distance, this.position.z + dz * distance);
  }

  walkTo(target: WorldPoint, speed: number): boolean {
    this.desiredTarget = { x: target.x, y: target.y, z: target.z };
    this.desiredSpeed = speed;
    if (this.path.length === 0 && this.navigation.lineOfSight(this.position, target)) {
      this.path = [{ x: target.x, y: target.y, z: target.z }];
      this.pathTarget = this.desiredTarget;
    }
    return this.path.length > 0 || this.navigation.isWalkable(target.x, target.z);
  }

  stop(): void {
    this.desiredTarget = undefined;
    this.path = [];
    this.pathTarget = undefined;
    this.hasFacePoint = false;
  }

  wanderTarget(radius: number): WorldPoint | undefined {
    return this.navigation.randomWalkablePoint(this.position.x, this.position.z, radius, this.random);
  }

  fleeTarget(distance: number): WorldPoint | undefined {
    let best: WorldPoint | undefined;
    let bestDistance = -Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = this.navigation.randomWalkablePoint(this.position.x, this.position.z, distance, this.random);
      if (!candidate) continue;
      const away = Math.hypot(candidate.x - this.playerPoint.x, candidate.z - this.playerPoint.z);
      if (away > bestDistance) { best = candidate; bestDistance = away; }
    }
    return best;
  }

  /** True when the manager should spend an A* search on this NPC. */
  get needsPath(): boolean {
    if (!this.desiredTarget || this.level >= 2 || this.searchCooldown > 0) return false;
    if (this.path.length === 0) return true;
    const target = this.pathTarget;
    return target === undefined || Math.hypot(target.x - this.desiredTarget.x, target.z - this.desiredTarget.z) > 3;
  }

  /** Run one bounded path search. The manager enforces the per-tick budget. */
  searchPath(): boolean {
    this.searchCooldown = CONFIG.npc.navigation.repathSeconds;
    const target = this.desiredTarget;
    if (!target) return false;
    const path = this.navigation.findPath(this.position, target);
    if (!path || path.length === 0) { this.path = []; return false; }
    this.path = path;
    this.pathTarget = target;
    return true;
  }

  /** Neighbour separation hint computed by the manager each simulation tick. */
  applySeparation(dx: number, dz: number): void {
    this.separationX = dx;
    this.separationZ = dz;
  }

  cooldown(dt: number): void {
    this.searchCooldown = Math.max(0, this.searchCooldown - dt);
  }

  /* ---- simulation -------------------------------------------------------- */

  /**
   * One simulation tick at the NPC's assigned fidelity. `dt` is the fixed step
   * for full-fidelity NPCs and an accumulated interval for reduced ones.
   */
  think(dt: number, hour: number, player: WorldPoint, separationX: number, separationZ: number): void {
    this.thoughtTime += dt;
    this.playerPoint.x = player.x; this.playerPoint.y = player.y; this.playerPoint.z = player.z;
    this.distance = Math.hypot(this.position.x - player.x, this.position.z - player.z);
    this.applySeparation(separationX, separationZ);
    this.cooldown(dt);
    this.previous.copy(this.motion.position);

    this.perceptionTimer += dt;
    if (this.perceptionTimer >= 1 / PERCEPTION_HZ) {
      this.perception.update(this.perceptionTimer, {
        position: this.position, yaw: this.yawValue, eyeHeight: EYE_HEIGHT,
      }, [{ id: 'player', kind: 'player', position: this.playerPoint }]);
      this.perceptionTimer = 0;
    }

    this.brain.tick(dt, hour);
    this.stepMotion(dt);
    this.updateCentre();
  }

  /**
   * Background-fidelity tick: no locomotion and no perception, just the schedule
   * so a distant NPC still changes activity and keeps its persistent state.
   */
  idleThink(dt: number, hour: number, player: WorldPoint): void {
    this.thoughtTime += dt;
    this.playerPoint.x = player.x; this.playerPoint.y = player.y; this.playerPoint.z = player.z;
    this.activity = resolveActivity(this.schedule, hour + this.phaseHours);
    this.behaviour = this.activity === 'work' ? 'work' : this.activity === 'sleep' ? 'sleep' : 'idle';
    this.distance = Math.hypot(this.position.x - player.x, this.position.z - player.z);
    this.updateCentre();
  }

  /** Eye point in canonical space (debug rays, future dialogue framing). */
  get eye(): WorldPoint {
    return { x: this.position.x, y: this.position.y + EYE_HEIGHT, z: this.position.z };
  }

  /** Apply a restored record (position, facing, persistent flags). */
  applyRecord(record: NpcRecord): void {
    this.motion.place(record.x, record.y, record.z);
    this.previous.copy(this.motion.position);
    this.yawValue = record.yaw;
    this.desiredYaw = record.yaw;
    this.talked = record.talked;
    this.stateValue.visited = record.talked;
    this.updateCentre();
  }

  toRecord(): NpcRecord {
    return {
      role: this.role,
      x: this.position.x, y: this.position.y, z: this.position.z,
      yaw: this.yawValue,
      behaviour: this.behaviour,
      activity: this.activity,
      talked: this.talked,
    };
  }

  /** Non-default state only: an untouched NPC is reproducible from the seed. */
  get isChanged(): boolean {
    if (this.talked) return true;
    if (Math.hypot(this.position.x - this.placed.x, this.position.z - this.placed.z) > 2.5) return true;
    return false;
  }

  /** Animation state implied by what the body is actually doing. */
  get animation(): AnimState {
    if (this.talking) return 'idle';
    // Seated states use the rig's crouch pose; the shared humanoid has no sit clip.
    const seated = this.behaviour === 'sleep' || this.behaviour === 'rest'
      || this.behaviour === 'sit' || this.behaviour === 'eat';
    if (seated) return 'crouchIdle';
    if (!this.motion.grounded) return this.motion.mode === 'swim' ? 'tread' : 'fall';
    if (this.motion.mode === 'swim') return 'swim';
    const speed = this.motion.horizontalSpeed;
    if (speed > 2.6) return this.behaviour === 'run' ? 'sprint' : 'jog';
    if (speed > 0.18) return 'walk';
    return 'idle';
  }

  /** Refresh the cached player distance (used for ordering before a think tick). */
  measureDistance(player: WorldPoint): number {
    this.distance = Math.hypot(this.position.x - player.x, this.position.z - player.z);
    return this.distance;
  }

  /** Begin/end a conversation; the manager owns the session and its events. */
  setTalking(talking: boolean): void {
    this.talking = talking;
    if (talking) { this.talked = true; this.stateValue.visited = true; this.stop(); this.face(this.playerPoint.x, this.playerPoint.z); }
    this.brain.reset();
  }

  /* ---- rendering --------------------------------------------------------- */

  /** Update the pooled visual: interpolated canonical pose minus the origin. */
  render(dt: number, alpha: number, origin: WorldPoint): void {
    const visual = this.visual;
    if (!visual) return;
    toRenderPoint(this.motion.position, origin, this.renderPoint);
    const px = this.previous.x, pz = this.previous.z, py = this.previous.y;
    const world = {
      x: px + (this.motion.position.x - px) * alpha,
      y: py + (this.motion.position.y - py) * alpha,
      z: pz + (this.motion.position.z - pz) * alpha,
    };
    this.groundNormal.set(0, 1, 0);
    const sample = this.ground.contact(world.x, world.z, this.groundContact);
    if (sample) this.groundNormal.copy(this.groundContact.normal);

    let lookYaw = 0;
    if (this.talking || this.distance < 8) {
      const dx = this.playerPoint.x - world.x, dz = this.playerPoint.z - world.z;
      if (dx * dx + dz * dz > 1e-4) {
        const toPlayer = Math.atan2(dx, dz);
        lookYaw = clamp(wrapAngle(toPlayer - this.yawValue), -1.1, 1.1);
      }
    }
    const pose: NpcPose = {
      world, origin, yaw: this.yawValue,
      speed: this.motion.horizontalSpeed,
      animation: this.animation,
      groundNormal: this.groundNormal,
      lookYaw,
    };
    visual.update(dt, pose);
  }

  /** Pose for debug/tests without a renderer. */
  pose(): { x: number; y: number; z: number; yaw: number } {
    return { x: this.position.x, y: this.position.y, z: this.position.z, yaw: this.yawValue };
  }

  dispose(): void {
    this.visual = undefined;
    this.path = [];
  }

  /* ---- internals --------------------------------------------------------- */

  private readonly groundContact: GroundContact = { height: 0, normal: new Vector3(0, 1, 0), biome: 0 };

  private updateCentre(): void {
    this.centre.x = this.position.x;
    this.centre.y = this.position.y + 1.05;
    this.centre.z = this.position.z;
  }

  private stepMotion(dt: number): void {
    // Consume reached waypoints (a path can complete inside one tick).
    while (this.path.length > 0) {
      const next = this.path[0]!;
      if (Math.hypot(next.x - this.position.x, next.z - this.position.z) <= CONFIG.npc.navigation.arriveRadius) this.path.shift();
      else break;
    }

    let dirX = 0, dirZ = 0, speed = 0;
    const waypoint = this.path[0];
    if (waypoint) {
      const dx = waypoint.x - this.position.x, dz = waypoint.z - this.position.z;
      const length = Math.hypot(dx, dz);
      if (length > 1e-4) {
        dirX = dx / length; dirZ = dz / length;
        speed = this.desiredSpeed;
      }
    }

    // Separation nudges, not commands: two NPCs drift apart without breaking a path.
    if (this.separationX !== 0 || this.separationZ !== 0) {
      dirX += this.separationX * 0.65;
      dirZ += this.separationZ * 0.65;
      const length = Math.hypot(dirX, dirZ);
      if (length > 1e-4) { dirX /= length; dirZ /= length; }
    }

    const result = this.motion.step(dt, {
      x: this.path.length > 0 ? dirX : 0,
      z: this.path.length > 0 ? dirZ : 0,
      speed: this.path.length > 0 ? speed : 0,
      sprint: false,
      crouch: false,
      jumpHeld: false,
      jumpPressed: false,
    }, this, this.water);

    // Facing follows movement; otherwise the node's look target (work, player).
    if (this.motion.horizontalSpeed > 0.35) {
      this.desiredYaw = Math.atan2(this.motion.velocity.x, this.motion.velocity.z);
    } else if (this.hasFacePoint) {
      const dx = this.facePoint.x - this.position.x, dz = this.facePoint.z - this.position.z;
      if (dx * dx + dz * dz > 0.04) this.desiredYaw = Math.atan2(dx, dz);
    }
    if (result.blocked && this.path.length > 0) {
      // A blocked step means the cached route is stale: let the manager retry.
      this.path = [];
      this.searchCooldown = Math.min(this.searchCooldown, 0.4);
    }
    const turn = wrapAngle(this.desiredYaw - this.yawValue);
    const maxTurn = 7 * dt;
    this.yawValue = wrapAngle(this.yawValue + clamp(turn, -maxTurn, maxTurn));
  }
}

function wrapAngle(angle: number): number {
  const wrapped = ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  return wrapped - Math.PI;
}

/** Distance between two canonical XZ points, exported for the manager/tests. */
export function distanceXZ(a: WorldPoint, b: WorldPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export const NPC_SEPARATION_RADIUS = SEPARATION_RADIUS;
