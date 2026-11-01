import type { WorldPoint } from '../core/coordinates';
import type { Perception } from './perception';
import type { NavigationService } from './navigation';
import { ACTIVITY_LABELS, anchorForActivity, resolveActivity } from './schedule';
import type { ScheduleEntry } from './schedule';
import type { NpcActivity, NpcAnchorKind, NpcBehaviourId, NpcRole } from './types';

/**
 * Behaviour architecture.
 *
 * A small behaviour-tree library (leaf actions plus selector/sequence/loop
 * composites) drives every NPC. Leaves set an explicit behaviour id and issue
 * *intent* — walk to a place, stop, face something. They never touch meshes or
 * positions directly: the same locomotion solver that moves the player moves the
 * NPC. Roles differ only by which data-driven tree the schedule selects, so
 * authored NPCs in later phases can register their own trees through
 * `NpcBrain.setBehaviourTree`.
 */

export type BehaviourStatus = 'running' | 'success' | 'failure';

export interface NpcAgent {
  readonly id: string;
  readonly role: NpcRole;
  /** Canonical world position of the NPC's feet. */
  readonly position: WorldPoint;
  /** Walking speed for this role, metres per second. */
  readonly speed: number;
  /** Distance at which this role starts reacting to the player, metres. */
  readonly alertDistance: number;
  readonly anchors: Readonly<Record<NpcAnchorKind, WorldPoint>>;
  readonly perception: Perception;
  readonly navigation: NavigationService;
  readonly player: WorldPoint;
  /** Seeded per-NPC random stream. */
  readonly random: () => number;
  /** Thought clock in seconds. */
  readonly now: number;
  talking: boolean;
  readonly behaviour: NpcBehaviourId;
  setBehaviour(behaviour: NpcBehaviourId): void;
  /** Request a path to a canonical point. False when unreachable. */
  walkTo(target: WorldPoint, speed: number): boolean;
  stop(): void;
  face(x: number, z: number): void;
  /** A walkable point near this one, or undefined when the area is impassable. */
  wanderTarget(radius: number): WorldPoint | undefined;
  /** A walkable point away from the player, used by the flee reaction. */
  fleeTarget(distance: number): WorldPoint | undefined;
  /** True when the ground `distance` metres ahead in the direction of travel is impassable. */
  probeAhead(distance: number): boolean;
}

export interface BehaviourNode {
  readonly id: string;
  tick(agent: NpcAgent, dt: number): BehaviourStatus;
  reset(): void;
}

/** Shared lifecycle: a node runs its start hook once per activation. */
abstract class Node implements BehaviourNode {
  protected started = false;
  protected elapsed = 0;
  /** Behaviour this node owns; re-asserted every tick so the reported state is
   *  never stale when a higher-priority branch pauses or aborts this one. */
  private requested: NpcBehaviourId | undefined;
  constructor(public readonly id: string) {}

  tick(agent: NpcAgent, dt: number): BehaviourStatus {
    if (!this.started) {
      this.started = true;
      this.elapsed = 0;
      this.onStart(agent);
    } else if (this.requested) {
      this.behave(agent, this.requested);
    }
    this.elapsed += dt;
    const status = this.update(agent);
    if (status !== 'running') this.reset();
    return status;
  }

  reset(): void {
    this.started = false;
    this.elapsed = 0;
    this.requested = undefined;
  }

  /** Claim a behaviour for this node and apply it now. */
  protected behave(agent: NpcAgent, behaviour: NpcBehaviourId): void {
    this.requested = behaviour;
    agent.setBehaviour(behaviour);
  }

  protected abstract onStart(agent: NpcAgent): void;
  protected abstract update(agent: NpcAgent): BehaviourStatus;
}

export class PredicateNode implements BehaviourNode {
  constructor(public readonly id: string, private readonly predicate: (agent: NpcAgent) => boolean) {}
  tick(agent: NpcAgent): BehaviourStatus { return this.predicate(agent) ? 'success' : 'failure'; }
  reset(): void { /* stateless */ }
}

export class SequenceNode implements BehaviourNode {
  private index = 0;
  constructor(public readonly id: string, private readonly children: readonly BehaviourNode[]) {}

  tick(agent: NpcAgent, dt: number): BehaviourStatus {
    while (this.index < this.children.length) {
      const status = this.children[this.index]!.tick(agent, dt);
      if (status === 'running') return 'running';
      if (status === 'failure') { this.reset(); return 'failure'; }
      this.index += 1;
    }
    this.reset();
    return 'success';
  }

  reset(): void {
    this.index = 0;
    for (const child of this.children) child.reset();
  }
}

export class SelectorNode implements BehaviourNode {
  private index = 0;
  constructor(public readonly id: string, private readonly children: readonly BehaviourNode[]) {}

  tick(agent: NpcAgent, dt: number): BehaviourStatus {
    while (this.index < this.children.length) {
      const status = this.children[this.index]!.tick(agent, dt);
      if (status === 'running') return 'running';
      if (status === 'success') { this.reset(); return 'success'; }
      this.index += 1;
    }
    this.reset();
    return 'failure';
  }

  reset(): void {
    this.index = 0;
    for (const child of this.children) child.reset();
  }
}

/**
 * Round-robin routine: runs one child at a time and moves to the next when it
 * finishes, forever. Selectors stop at the first success, so an alternating
 * routine (work → look → errand → work) needs this instead. The node only
 * reports success once every child has failed in a row.
 */
export class CycleNode implements BehaviourNode {
  private index = 0;
  private failures = 0;
  constructor(public readonly id: string, private readonly children: readonly BehaviourNode[]) {}

  tick(agent: NpcAgent, dt: number): BehaviourStatus {
    for (let attempt = 0; attempt < this.children.length; attempt++) {
      const child = this.children[this.index];
      if (!child) return 'failure';
      const status = child.tick(agent, dt);
      if (status === 'running') { this.failures = 0; return 'running'; }
      child.reset();
      this.index = (this.index + 1) % this.children.length;
      this.failures = status === 'failure' ? this.failures + 1 : 0;
      if (this.failures >= this.children.length) { this.failures = 0; return 'failure'; }
      if (status === 'success') return 'running';
    }
    return 'running';
  }

  reset(): void {
    this.index = 0;
    this.failures = 0;
    for (const child of this.children) child.reset();
  }
}

/**
 * Priority selector used at the root of every NPC tree. Unlike `SelectorNode` it
 * re-evaluates the higher-priority branches on every tick, so a conversation or a
 * startle can preempt a walk already in progress, and it runs through branches
 * that complete in the same tick. A running branch is returned immediately;
 * paused branches keep their internal state and resume where they stopped.
 */
export class ReactiveSelectorNode implements BehaviourNode {
  constructor(public readonly id: string, private readonly children: readonly BehaviourNode[]) {}

  tick(agent: NpcAgent, dt: number): BehaviourStatus {
    let anySuccess = false;
    for (const child of this.children) {
      const status = child.tick(agent, dt);
      if (status === 'running') return 'running';
      if (status === 'success') anySuccess = true;
    }
    return anySuccess ? 'success' : 'failure';
  }

  reset(): void {
    for (const child of this.children) child.reset();
  }
}

/** Repeats a child forever: success re-arms it, failure propagates. */
export class LoopNode implements BehaviourNode {
  constructor(public readonly id: string, private readonly child: BehaviourNode) {}
  tick(agent: NpcAgent, dt: number): BehaviourStatus {
    const status = this.child.tick(agent, dt);
    if (status === 'success') this.child.reset();
    return status === 'failure' ? 'failure' : 'running';
  }
  reset(): void { this.child.reset(); }
}

function distanceXZ(a: WorldPoint, b: WorldPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Stand still for a randomised duration, then report success. */
export class IdleNode extends Node {
  private duration = 0;
  constructor(
    id: string,
    private readonly minSeconds: number,
    private readonly maxSeconds: number,
    private readonly behaviour: NpcBehaviourId = 'idle',
  ) {
    super(id);
  }

  protected onStart(agent: NpcAgent): void {
    agent.stop();
    this.behave(agent, this.behaviour);
    this.duration = this.minSeconds + (this.maxSeconds - this.minSeconds) * agent.random();
  }

  protected update(): BehaviourStatus {
    return this.elapsed >= this.duration ? 'success' : 'running';
  }

  override reset(): void {
    super.reset();
    this.duration = 0;
  }
}

/** Pick a walkable point nearby, walk to it, then succeed. */
export class WanderNode extends Node {
  private target: WorldPoint | undefined;
  constructor(
    id: string,
    private readonly radius: number,
    private readonly timeout = 28,
    private readonly behaviour: NpcBehaviourId = 'wander',
    private readonly speedScale = 1,
    private readonly arriveRadius = 1.6,
  ) { super(id); }

  protected onStart(agent: NpcAgent): void {
    this.target = agent.wanderTarget(this.radius);
    this.behave(agent, this.behaviour);
    if (this.target && agent.walkTo(this.target, agent.speed * this.speedScale)) return;
    agent.stop();
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    if (!this.target) return 'failure';
    if (distanceXZ(agent.position, this.target) <= this.arriveRadius) return 'success';
    if (this.elapsed > this.timeout) return 'failure';
    return 'running';
  }

  override reset(): void {
    super.reset();
    this.target = undefined;
  }
}

/** Walk to a schedule anchor. */
export class GoToAnchorNode extends Node {
  constructor(id: string, private readonly anchor: NpcAnchorKind, private readonly timeout = 90) { super(id); }

  protected onStart(agent: NpcAgent): void {
    this.behave(agent, 'travel');
    if (!agent.walkTo(agent.anchors[this.anchor], agent.speed)) agent.stop();
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    if (distanceXZ(agent.position, agent.anchors[this.anchor]) <= 2) return 'success';
    return this.elapsed > this.timeout ? 'failure' : 'running';
  }
}

/**
 * Stay at an anchor and keep facing it (work, rest). Runs forever unless a
 * duration is given, in which case it succeeds so a selector can alternate
 * between tasks at the same post.
 */
export class HoldAnchorNode extends Node {
  private duration = Infinity;
  constructor(
    id: string,
    private readonly anchor: NpcAnchorKind,
    private readonly behaviour: NpcBehaviourId,
    private readonly minSeconds = Infinity,
    private readonly maxSeconds = Infinity,
  ) { super(id); }

  protected onStart(agent: NpcAgent): void {
    agent.stop();
    this.behave(agent, this.behaviour);
    const target = agent.anchors[this.anchor];
    agent.face(target.x, target.z);
    this.duration = this.minSeconds + (this.maxSeconds - this.minSeconds) * agent.random();
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    const target = agent.anchors[this.anchor];
    if (distanceXZ(agent.position, target) > 3.4) agent.face(target.x, target.z);
    return this.elapsed >= this.duration ? 'success' : 'running';
  }

  override reset(): void {
    super.reset();
    this.duration = Infinity;
  }
}

/** Stand still and look at the player while a conversation is open. */
export class TalkNode extends Node {
  protected onStart(agent: NpcAgent): void {
    agent.stop();
    this.behave(agent, 'talk');
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    agent.face(agent.player.x, agent.player.z);
    return agent.talking ? 'running' : 'success';
  }
}

/** Walk towards the last place the player was seen, then give up. */
export class InvestigateNode extends Node {
  private target: WorldPoint | undefined;
  constructor(id: string, private readonly timeout = 22) { super(id); }

  protected onStart(agent: NpcAgent): void {
    const memory = agent.perception.playerMemory ?? agent.perception.memoriesList()[0];
    this.target = memory ? { x: memory.x, y: memory.y, z: memory.z } : undefined;
    this.behave(agent, 'investigate');
    if (!this.target || !agent.walkTo(this.target, agent.speed * 0.95)) agent.stop();
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    if (!this.target) return 'failure';
    if (distanceXZ(agent.position, this.target) <= 2) return 'success';
    if (!agent.perception.alerted) return 'success';
    return this.elapsed > this.timeout ? 'failure' : 'running';
  }

  override reset(): void {
    super.reset();
    this.target = undefined;
  }
}

/**
 * Back away from the player for a moment (non-curious roles). Close encounters
 * escalate from a walk to an actual run; both are simulated states, not poses.
 */
export class FleeNode extends Node {
  private target: WorldPoint | undefined;
  constructor(id: string, private readonly seconds = 3.5) { super(id); }

  protected onStart(agent: NpcAgent): void {
    this.target = agent.fleeTarget(7);
    const urgent = distanceXZ(agent.position, agent.player) < 5;
    this.behave(agent, urgent ? 'run' : 'flee');
    if (this.target) agent.walkTo(this.target, agent.speed * (urgent ? 2 : 1.25));
    else agent.stop();
  }

  protected update(): BehaviourStatus {
    return this.elapsed >= this.seconds ? 'success' : 'running';
  }

  override reset(): void {
    super.reset();
    this.target = undefined;
  }
}


/** Stop and turn to inspect the surroundings, a few sweeps at a time. */
export class LookAroundNode extends Node {
  private nextTurn = 0;
  private duration = 2;
  constructor(id: string, private readonly minSeconds = 2, private readonly maxSeconds = 4.5) { super(id); }

  protected onStart(agent: NpcAgent): void {
    agent.stop();
    this.behave(agent, 'look');
    this.duration = this.minSeconds + (this.maxSeconds - this.minSeconds) * agent.random();
    this.nextTurn = 0;
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    if (this.elapsed >= this.nextTurn) {
      this.nextTurn = this.elapsed + 0.9 + agent.random() * 0.8;
      const angle = agent.random() * Math.PI * 2;
      agent.face(agent.position.x + Math.sin(angle) * 5, agent.position.z + Math.cos(angle) * 5);
    }
    return this.elapsed >= this.duration ? 'success' : 'running';
  }

  override reset(): void {
    super.reset();
    this.nextTurn = 0;
    this.duration = 2;
  }
}

/** Stand and wait: used at posts and between errands. */
export class WaitNode extends Node {
  private duration = 3;
  constructor(id: string, private readonly minSeconds = 2, private readonly maxSeconds = 5) { super(id); }

  protected onStart(agent: NpcAgent): void {
    agent.stop();
    this.behave(agent, 'wait');
    this.duration = this.minSeconds + (this.maxSeconds - this.minSeconds) * agent.random();
  }

  protected update(): BehaviourStatus {
    return this.elapsed >= this.duration ? 'success' : 'running';
  }

  override reset(): void {
    super.reset();
    this.duration = 3;
  }
}

/** Settle into a seat-height pose. The rig only has locomotion clips, so this
 *  reports `sit` as a simulated state and drives the crouch pose. */
export class SitNode extends Node {
  private duration = 6;
  constructor(id: string, private readonly minSeconds = 5, private readonly maxSeconds = 12) { super(id); }

  protected onStart(agent: NpcAgent): void {
    agent.stop();
    this.behave(agent, 'sit');
    this.duration = this.minSeconds + (this.maxSeconds - this.minSeconds) * agent.random();
  }

  protected update(): BehaviourStatus {
    return this.elapsed >= this.duration ? 'success' : 'running';
  }

  override reset(): void {
    super.reset();
    this.duration = 6;
  }
}

/**
 * A meal pause at a leisure or rest anchor. NPCs have no inventory yet, so this
 * is a timed activity state (seated, then standing) rather than item consumption.
 */
export class EatNode extends Node {
  private duration = 8;
  constructor(id: string, private readonly minSeconds = 6, private readonly maxSeconds = 11) { super(id); }

  protected onStart(agent: NpcAgent): void {
    this.behave(agent, 'eat');
    this.duration = this.minSeconds + (this.maxSeconds - this.minSeconds) * agent.random();
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    // Keep facing the seat while eating; walking away cancels the pause.
    if (agent.behaviour !== 'eat') return 'failure';
    return this.elapsed >= this.duration ? 'success' : 'running';
  }

  override reset(): void {
    super.reset();
    this.duration = 8;
  }
}

/** Brief startle when the player appears: stop, face them, then hand over. */
export class ReactNode extends Node {
  constructor(id: string, private readonly seconds = 0.8) { super(id); }

  protected onStart(agent: NpcAgent): void {
    agent.stop();
    this.behave(agent, 'react');
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    agent.face(agent.player.x, agent.player.z);
    return this.elapsed >= this.seconds ? 'success' : 'running';
  }
}

/**
 * Detour around an obstacle directly ahead. The locomotion solver still does
 * the fine-grained steering; this node supplies the deliberate side-step so the
 * NPC does not grind against a rock or a parked prop.
 */
export class AvoidNode extends Node {
  private target: WorldPoint | undefined;
  constructor(id: string, private readonly seconds = 1.6, private readonly radius = 4.5) { super(id); }

  protected onStart(agent: NpcAgent): void {
    this.target = agent.wanderTarget(this.radius);
    this.behave(agent, 'avoid');
    if (this.target) agent.walkTo(this.target, agent.speed * 0.9);
    else agent.stop();
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    if (!this.target) return 'failure';
    if (!agent.probeAhead(2) && this.elapsed > 0.4) return 'success';
    if (distanceXZ(agent.position, this.target) <= 1.6) return 'success';
    return this.elapsed >= this.seconds ? 'failure' : 'running';
  }

  override reset(): void {
    super.reset();
    this.target = undefined;
  }
}

/**
 * Escort behaviour: keep the player inside a comfortable band. Fails as soon as
 * the player is out of sight, so nothing follows a target it cannot perceive.
 */
export class FollowNode extends Node {
  private issued: WorldPoint | undefined;
  constructor(id: string, private readonly seconds = 9, private readonly near = 3.4, private readonly far = 5) { super(id); }

  protected onStart(agent: NpcAgent): void {
    this.behave(agent, 'follow');
    this.issued = undefined;
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    if (!agent.perception.seesPlayer) return 'failure';
    const distance = distanceXZ(agent.position, agent.player);
    if (distance <= this.near) {
      agent.stop();
      agent.face(agent.player.x, agent.player.z);
      return this.elapsed >= this.seconds ? 'success' : 'running';
    }
    const moved = this.issued === undefined || distanceXZ(this.issued, agent.player) > 2;
    if (distance > this.far && moved) {
      this.issued = { x: agent.player.x, y: agent.player.y, z: agent.player.z };
      if (!agent.walkTo(this.issued, agent.speed * 1.15)) return 'failure';
    }
    return this.elapsed >= this.seconds + 4 ? 'failure' : 'running';
  }

  override reset(): void {
    super.reset();
    this.issued = undefined;
  }
}

/** Walk back to the schedule post after a detour or a reaction. */
export class ReturnToPostNode extends Node {
  constructor(
    id: string,
    private readonly anchor: NpcAnchorKind,
    private readonly arriveRadius = 2.4,
    private readonly timeout = 70,
  ) { super(id); }

  protected onStart(agent: NpcAgent): void {
    this.behave(agent, 'return');
    const post = agent.anchors[this.anchor];
    if (!agent.walkTo(post, agent.speed * 1.1)) agent.stop();
  }

  protected update(agent: NpcAgent): BehaviourStatus {
    if (distanceXZ(agent.position, agent.anchors[this.anchor]) <= this.arriveRadius) return 'success';
    return this.elapsed > this.timeout ? 'failure' : 'running';
  }
}

/**
 * The brain maps the live schedule activity to a tree, keeps that tree alive
 * between ticks (so long-running nodes keep their state), and layers conversation
 * and perception reactions above it as guarded branches.
 */
export class NpcBrain {
  behaviour: NpcBehaviourId = 'idle';
  activity: NpcActivity = 'wander';
  private root: BehaviourNode | undefined;
  private rootActivity: NpcActivity | undefined;
  private trees: Map<NpcActivity, BehaviourNode> | undefined;

  constructor(
    private readonly agent: NpcAgent,
    private readonly schedule: readonly ScheduleEntry[],
    private readonly phaseHours = 0,
  ) {}

  /** Replace the schedule-driven activity trees (authored NPCs, scripted states). */
  setBehaviourTree(trees: ReadonlyMap<NpcActivity, BehaviourNode>): void {
    this.trees = new Map(trees);
    this.root = undefined;
    this.rootActivity = undefined;
  }

  tick(dt: number, hour: number): NpcBehaviourId {
    const activity = resolveActivity(this.schedule, hour + this.phaseHours);
    this.activity = activity;
    if (!this.root || this.rootActivity !== activity) {
      this.root = this.buildRoot(activity);
      this.rootActivity = activity;
    }
    this.root.tick(this.agent, dt);
    this.behaviour = this.agent.behaviour;
    return this.behaviour;
  }

  get activityLabel(): string { return ACTIVITY_LABELS[this.activity]; }

  reset(): void {
    this.root?.reset();
    this.root = undefined;
    this.rootActivity = undefined;
    this.trees = undefined;
  }

  /**
   * Reaction guards run above the schedule tree, in priority order: a
   * conversation wins over everything, then an obstacle immediately ahead, then
   * the first sighting of the player (startle), then the role's reaction.
   */
  private buildRoot(activity: NpcActivity): BehaviourNode {
    return new ReactiveSelectorNode(`root:${activity}`, [
      new SequenceNode('converse', [new PredicateNode('talking?', (agent) => agent.talking), new TalkNode('talk')]),
      new SequenceNode('detour', [
        new PredicateNode('blocked?', (agent) => !agent.talking && agent.probeAhead(2)),
        new AvoidNode('avoid'),
      ]),
      new SequenceNode('startle', [
        new PredicateNode('spotted?', (agent) => !agent.talking && agent.perception.takeSpot()),
        new ReactNode('react'),
      ]),
      new SequenceNode('shy', [
        new PredicateNode('shy?', (agent) => !agent.talking && this.shy() && this.withinAlert(agent)),
        new FleeNode('flee'),
      ]),
      new SequenceNode('curious', [
        new PredicateNode('curious?', (agent) => !agent.talking && this.curious() && this.withinAlert(agent)),
        new InvestigateNode('investigate'),
        new FollowNode('follow'),
      ]),
      this.activityTree(activity),
    ]);
  }

  private activityTree(activity: NpcActivity): BehaviourNode {
    let trees = this.trees;
    if (!trees) {
      trees = new Map();
      trees.set('sleep', new SequenceNode('sleep', [
        new GoToAnchorNode('go-home', 'home'),
        new LoopNode('rest', new IdleNode('sleep', 30, 70, 'sleep')),
      ]));
      trees.set('work', new SequenceNode('work', [
        new GoToAnchorNode('go-work', 'work'),
        new WaitNode('work-wait', 1.5, 3.5),
        new CycleNode('work-loop', [
          new HoldAnchorNode('hold-work', 'work', 'work', 7, 16),
          new LookAroundNode('work-look', 2, 4),
          new SequenceNode('work-errand', [
            new WanderNode('work-walk', 6, 18, 'walk', 0.85),
            new ReturnToPostNode('work-return', 'work', 3),
          ]),
        ]),
      ]));
      trees.set('leisure', new SequenceNode('leisure', [
        new GoToAnchorNode('go-leisure', anchorForActivity('leisure')),
        new CycleNode('leisure-loop', [
          new SequenceNode('leisure-meal', [new SitNode('sit', 4, 9), new EatNode('eat', 5, 9)]),
          new LookAroundNode('leisure-look', 2.5, 5),
          new WanderNode('leisure-walk', 14, 26, 'walk'),
          new IdleNode('leisure-rest', 4, 9, 'rest'),
        ]),
      ]));
      trees.set('wander', new CycleNode('roam', [
        new WanderNode('roam-walk', 46),
        new WanderNode('roam-stroll', 12, 18, 'walk', 0.8),
        new LookAroundNode('roam-look', 2, 4),
        new IdleNode('roam-pause', 2.5, 5, 'idle'),
      ]));
      this.trees = trees;
    }
    return trees.get(activity) ?? trees.get('wander')!;
  }

  /** Reactions are bounded: outside the role's alert range the schedule resumes. */
  private withinAlert(agent: NpcAgent): boolean {
    if (!agent.perception.alerted) return false;
    return distanceXZ(agent.position, agent.player) <= agent.alertDistance;
  }

  private curious(): boolean { return this.agent.role !== 'worker'; }
  private shy(): boolean { return this.agent.role === 'worker'; }
}
