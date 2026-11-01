import { describe, expect, it } from 'vitest';
import {
  CycleNode, EatNode, FollowNode, IdleNode, LookAroundNode, LoopNode,
  PredicateNode, ReturnToPostNode, SelectorNode, SequenceNode, SitNode, WaitNode, WanderNode,
} from '../src/npc/behaviour';
import type { BehaviourNode, NpcAgent } from '../src/npc/behaviour';
import { NpcBrain } from '../src/npc/behaviour';
import { Perception } from '../src/npc/perception';
import { scheduleFor, resolveActivity, scheduleOffset } from '../src/npc/schedule';
import { seededRandom } from '../src/utils/random';
import type { NavigationService } from '../src/npc/navigation';
import type { WorldQueries } from '../src/world/world-queries';
import { NPC_BEHAVIOURS } from '../src/npc/types';
import type { NpcAnchorKind, NpcBehaviourId, NpcRole } from '../src/npc/types';
import type { WorldPoint } from '../src/core/coordinates';

function stubQueries(): WorldQueries {
  const stub = {
    groundFast: () => ({
      height: 0, nx: 0, ny: 1, nz: 0, slope: 0,
      surface: 'grass' as const, friction: 0.72, restitution: 0.04, onRoad: false, biome: 0,
    }),
    height: () => 0,
  };
  return stub as unknown as WorldQueries;
}

class FakeNavigation implements NavigationService {
  searches = 0;
  isWalkable(): boolean { return true; }
  findPath(): WorldPoint[] | null { this.searches += 1; return null; }
  lineOfSight(): boolean { return true; }
  randomWalkablePoint(x: number, z: number, radius: number): WorldPoint {
    return { x: x + radius, y: 0, z };
  }
}

/** A scriptable NPC agent: records intent, never moves unless the test moves it. */
class FakeAgent implements NpcAgent {
  readonly id = 'npc.test';
  readonly role: NpcRole;
  readonly position: WorldPoint = { x: 0, y: 0, z: 0 };
  readonly speed = 1.4;
  readonly alertDistance = 15;
  readonly anchors: Record<NpcAnchorKind, WorldPoint>;
  readonly perception: Perception;
  readonly navigation = new FakeNavigation();
  readonly player: WorldPoint = { x: 0, y: 0, z: 6 };
  readonly random = seededRandom(7);
  now = 0;
  talking = false;
  behaviour: NpcBehaviourId = 'idle';
  stops = 0;
  walks: WorldPoint[] = [];
  faces: WorldPoint[] = [];
  lastSpeed = 0;

  constructor(role: NpcRole = 'wanderer') {
    this.role = role;
    this.anchors = {
      home: { x: 1, y: 0, z: 0 },
      work: { x: 3, y: 0, z: 0 },
      leisure: { x: 5, y: 0, z: 0 },
    };
    this.perception = new Perception(stubQueries(), { sightRange: 30, coneDegrees: 160 });
  }

  setBehaviour(behaviour: NpcBehaviourId): void { this.behaviour = behaviour; }
  walkTo(target: WorldPoint, speed: number): boolean { this.walks.push({ ...target }); this.lastSpeed = speed; return true; }
  stop(): void { this.stops += 1; }
  face(x: number, z: number): void { this.faces.push({ x, y: 0, z }); }
  wanderTarget(radius: number): WorldPoint { return this.navigation.randomWalkablePoint(this.position.x, this.position.z, radius); }
  fleeTarget(distance: number): WorldPoint { return { x: this.position.x - distance, y: 0, z: this.position.z }; }
  blockedAhead = false;
  probeAhead(): boolean { return this.blockedAhead; }

  lookAtPlayer(): void {
    this.perception.update(0.1, {
      position: this.position, yaw: 0, eyeHeight: 1.6,
    }, [{ id: 'player', kind: 'player', position: this.player }]);
  }
}

describe('NPC schedule', () => {
  it('resolves day, night and wrapping windows', () => {
    const settler = scheduleFor('settler');
    expect(resolveActivity(settler, 23)).toBe('sleep');
    expect(resolveActivity(settler, 3)).toBe('sleep');
    expect(resolveActivity(settler, 7)).toBe('leisure');
    expect(resolveActivity(settler, 9)).toBe('work');
    expect(resolveActivity(settler, 18)).toBe('leisure');
    const roamer = scheduleFor('roamer');
    expect(resolveActivity(roamer, 12)).toBe('wander');
    expect(resolveActivity(roamer, 20)).toBe('leisure');
  });

  it('gives every NPC a deterministic phase offset inside half an hour', () => {
    const a = scheduleOffset(1234, 0);
    const b = scheduleOffset(1234, 1);
    expect(a).toBe(scheduleOffset(1234, 0));
    expect(a).not.toBe(b);
    expect(Math.abs(a)).toBeLessThan(0.8);
  });
});

describe('behaviour tree primitives', () => {
  it('runs sequences in order and stops on failure', () => {
    const agent = new FakeAgent();
    const calls: string[] = [];
    const node = (id: string, status: 'success' | 'failure' | 'running'): BehaviourNode => ({
      id, reset: () => undefined, tick: () => { calls.push(id); return status; },
    });
    const sequence = new SequenceNode('s', [node('a', 'success'), node('b', 'failure'), node('c', 'success')]);
    expect(sequence.tick(agent, 0.1)).toBe('failure');
    expect(calls).toEqual(['a', 'b']);
  });

  it('selects the first non-failing child', () => {
    const agent = new FakeAgent();
    const status = (value: 'success' | 'failure' | 'running'): BehaviourNode => ({
      id: value, reset: () => undefined, tick: () => value,
    });
    const selector = new SelectorNode('sel', [status('failure'), status('running'), status('success')]);
    expect(selector.tick(agent, 0.1)).toBe('running');
    expect(new PredicateNode('yes', () => true).tick(agent)).toBe('success');
    expect(new PredicateNode('no', () => false).tick(agent)).toBe('failure');
  });

  it('repeats a child with LoopNode and finishes an idle after its duration', () => {
    const agent = new FakeAgent();
    const idle = new IdleNode('idle', 0.2, 0.2);
    expect(idle.tick(agent, 0.1)).toBe('running');
    expect(idle.tick(agent, 0.15)).toBe('success');
    expect(agent.stops).toBeGreaterThan(0);

    let ticks = 0;
    const child: BehaviourNode = { id: 'c', reset: () => undefined, tick: () => { ticks += 1; return 'success'; } };
    const loop = new LoopNode('loop', child);
    expect(loop.tick(agent, 0.1)).toBe('running');
    expect(loop.tick(agent, 0.1)).toBe('running');
    expect(ticks).toBe(2);
  });
});

describe('NPC brain', () => {
  it('walks to the work anchor and then works during work hours', () => {
    const agent = new FakeAgent('worker');
    const brain = new NpcBrain(agent, scheduleFor('settler'));
    brain.tick(0.1, 10);
    expect(agent.walks.at(-1)).toMatchObject({ x: 3, z: 0 });
    expect(agent.behaviour).toBe('travel');

    // Arriving at the anchor starts a short wait before the work loop.
    agent.position.x = 3;
    brain.tick(0.1, 10);
    expect(agent.behaviour).toBe('wait');
    brain.tick(4, 10);
    expect(agent.behaviour).toBe('work');
    expect(brain.activity).toBe('work');
  });

  it('roams during wander hours and pauses between walks', () => {
    const agent = new FakeAgent('wanderer');
    const brain = new NpcBrain(agent, scheduleFor('roamer'));
    brain.tick(0.1, 12);
    expect(brain.activity).toBe('wander');
    expect(agent.walks.length).toBeGreaterThan(0);
    expect(agent.behaviour).toBe('wander');
  });

  it('stops everything to talk, facing the player', () => {
    const agent = new FakeAgent('watcher');
    const brain = new NpcBrain(agent, scheduleFor('warden'));
    agent.talking = true;
    brain.tick(0.1, 10);
    expect(agent.behaviour).toBe('talk');
    expect(agent.faces.at(-1)).toMatchObject({ x: agent.player.x, z: agent.player.z });

    // Ending the conversation releases the talk branch on the following tick.
    agent.talking = false;
    brain.tick(0.1, 10);
    brain.tick(0.1, 10);
    expect(agent.behaviour).not.toBe('talk');
  });

  it('investigates the player when curious, and backs away when not', () => {
    const curious = new FakeAgent('watcher');
    curious.lookAtPlayer();
    const curiousBrain = new NpcBrain(curious, scheduleFor('warden'));
    curiousBrain.tick(0.1, 10);
    expect(curious.behaviour).toBe('react');
    curiousBrain.tick(1, 10);
    expect(curious.behaviour).toBe('investigate');

    const shy = new FakeAgent('worker');
    shy.lookAtPlayer();
    const shyBrain = new NpcBrain(shy, scheduleFor('settler'));
    shyBrain.tick(1, 10);
    expect(shy.behaviour).toBe('flee');
    expect(shy.walks.at(-1)!.x).toBeLessThan(shy.position.x);
  });

  it('rests at home during sleep hours', () => {
    const agent = new FakeAgent('wanderer');
    agent.position.x = 1;
    const brain = new NpcBrain(agent, scheduleFor('roamer'));
    brain.tick(0.1, 2);
    expect(brain.activity).toBe('sleep');
    brain.tick(0.1, 2);
    expect(['sleep', 'travel']).toContain(agent.behaviour);
  });

  it('accepts an authored behaviour tree without touching the brain', () => {
    const agent = new FakeAgent('wanderer');
    const brain = new NpcBrain(agent, scheduleFor('roamer'));
    const custom: BehaviourNode = {
      id: 'custom', reset: () => undefined,
      tick: (target) => { target.setBehaviour('investigate'); return 'running'; },
    };
    brain.setBehaviourTree(new Map([['wander', custom]]));
    brain.tick(0.1, 12);
    expect(agent.behaviour).toBe('investigate');
  });
});

/** An agent that actually walks to whatever target the tree asks for. */
class MovingAgent extends FakeAgent {
  private goal: WorldPoint | undefined;
  private speedNow = 0;

  override walkTo(target: WorldPoint, speed: number): boolean {
    this.goal = { ...target };
    this.speedNow = speed;
    return super.walkTo(target, speed);
  }

  override stop(): void {
    super.stop();
    this.goal = undefined;
  }

  step(dt: number): void {
    const goal = this.goal;
    if (!goal) return;
    const dx = goal.x - this.position.x, dz = goal.z - this.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.05) return;
    const stepDistance = Math.min(distance, this.speedNow * dt);
    this.position.x += (dx / distance) * stepDistance;
    this.position.z += (dz / distance) * stepDistance;
  }
}

describe('extended behaviour states', () => {
  it('looks around, turning to several headings over its run', () => {
    const agent = new FakeAgent();
    const node = new LookAroundNode('look', 2, 2.5);
    expect(node.tick(agent, 0.5)).toBe('running');
    expect(agent.behaviour).toBe('look');
    const turns = agent.faces.length;
    expect(turns).toBeGreaterThan(0);
    expect(node.tick(agent, 2)).toBe('success');
  });

  it('waits a bounded time before reporting success', () => {
    const agent = new FakeAgent();
    const node = new WaitNode('wait', 3, 4);
    expect(node.tick(agent, 0.5)).toBe('running');
    expect(agent.behaviour).toBe('wait');
    expect(agent.stops).toBeGreaterThan(0);
    expect(node.tick(agent, 1)).toBe('running');
    expect(node.tick(agent, 3)).toBe('success');
  });

  it('sits, then eats, at a rest post', () => {
    const agent = new FakeAgent();
    const sequence = new SequenceNode('meal', [new SitNode('sit', 2, 2), new EatNode('eat', 2, 2)]);
    expect(sequence.tick(agent, 1)).toBe('running');
    expect(agent.behaviour).toBe('sit');
    expect(sequence.tick(agent, 1)).toBe('running');
    expect(agent.behaviour).toBe('eat');
    expect(sequence.tick(agent, 2)).toBe('success');
  });

  it('follows a visible player at a distance band and gives up when they vanish', () => {
    const agent = new FakeAgent('watcher');
    agent.position.x = 0; agent.position.z = 0;
    agent.player.x = 0; agent.player.z = 14;
    agent.lookAtPlayer();
    const follow = new FollowNode('follow', 9);
    expect(follow.tick(agent, 0.2)).toBe('running');
    expect(agent.behaviour).toBe('follow');
    expect(agent.walks.at(-1)).toMatchObject({ x: 0, z: 14 });
    expect(agent.lastSpeed).toBeGreaterThan(agent.speed);

    // Closing to the band makes it stop and watch instead of shoving the player.
    agent.position.z = 11;
    expect(follow.tick(agent, 0.2)).toBe('running');
    expect(agent.stops).toBeGreaterThan(0);

    const blind = new FakeAgent('watcher');
    expect(new FollowNode('follow-blind').tick(blind, 0.2)).toBe('failure');
  });

  it('walks back to its post after a detour', () => {
    const agent = new FakeAgent();
    agent.position.x = 40;
    const node = new ReturnToPostNode('return', 'work');
    expect(node.tick(agent, 0.5)).toBe('running');
    expect(agent.behaviour).toBe('return');
    expect(agent.walks.at(-1)).toMatchObject({ x: 3, z: 0 });
    agent.position.x = 3;
    expect(node.tick(agent, 0.5)).toBe('success');
  });

  it('detours around an obstacle and then hands back to the schedule', () => {
    const agent = new FakeAgent('watcher');
    agent.blockedAhead = true;
    const brain = new NpcBrain(agent, scheduleFor('roamer'));
    brain.tick(0.2, 12);
    expect(agent.behaviour).toBe('avoid');
    expect(agent.walks.length).toBeGreaterThan(0);

    agent.blockedAhead = false;
    brain.tick(1, 12);
    brain.tick(1, 12);
    expect(agent.behaviour).not.toBe('avoid');
  });

  it('runs rather than walks when the player is right on top of it', () => {
    const agent = new FakeAgent('worker');
    agent.player.z = 3;
    agent.lookAtPlayer();
    const brain = new NpcBrain(agent, scheduleFor('settler'));
    const states: NpcBehaviourId[] = [];
    brain.tick(0.1, 10);
    states.push(agent.behaviour);
    for (let i = 0; i < 6; i++) { brain.tick(1, 10); states.push(agent.behaviour); }
    expect(states).toContain('react');
    expect(states).toContain('run');
    expect(agent.lastSpeed).toBeCloseTo(agent.speed * 2, 5);
  });

  it('ignores a player beyond the role alert range instead of reacting forever', () => {
    const agent = new FakeAgent('worker');
    agent.player.z = 22;
    agent.lookAtPlayer();
    const brain = new NpcBrain(agent, scheduleFor('settler'));
    const states: NpcBehaviourId[] = [];
    for (let i = 0; i < 4; i++) { brain.tick(1, 10); states.push(agent.behaviour); }
    expect(states).not.toContain('flee');
    expect(states).not.toContain('run');
  });

  it('never leaves a stale behaviour label behind after a reaction', () => {
    const agent = new FakeAgent('worker');
    agent.player.z = 6;
    agent.lookAtPlayer();
    const brain = new NpcBrain(agent, scheduleFor('settler'));
    const states: NpcBehaviourId[] = [];
    for (let i = 0; i < 12; i++) {
      // Keep the player visible but let them drift out of the alert range.
      agent.player.z += 2;
      agent.lookAtPlayer();
      brain.tick(1, 10);
      states.push(agent.behaviour);
    }
    expect(states).toContain('flee');
    // Once the player is far away the schedule takes over again.
    expect(states.at(-1)).not.toBe('flee');
    expect(states.at(-1)).not.toBe('react');
  });

  it('reaches every documented state across a simulated day', () => {
    const seen = new Set<NpcBehaviourId>();
    const run = (agent: MovingAgent, brain: NpcBrain, hour: number, ticks: number, dt: number): void => {
      for (let i = 0; i < ticks; i++) {
        agent.step(dt);
        brain.tick(dt, hour);
        seen.add(agent.behaviour);
      }
    };

    // A warden's day covers sleep, work, roam and leisure. The player stays out
    // of sight so the schedule tree — not a reaction — drives the states.
    const day = new MovingAgent('watcher');
    day.perception.clear();
    const dayBrain = new NpcBrain(day, scheduleFor('warden'));
    for (const [hour, ticks] of [[2, 160], [7, 220], [10, 200], [13, 220]] as const) {
      run(day, dayBrain, hour, ticks, 0.6);
    }
    dayBrain.reset();

    // Curiosity: startle → investigate → escort, all from real perception.
    const curious = new MovingAgent('watcher');
    curious.player.z = 14;
    curious.lookAtPlayer();
    const curiousBrain = new NpcBrain(curious, scheduleFor('warden'));
    run(curious, curiousBrain, 10, 30, 0.6);

    // A shy worker backs away at range, and runs when the player closes in.
    const shy = new MovingAgent('worker');
    shy.player.z = 24;
    shy.lookAtPlayer();
    const shyBrain = new NpcBrain(shy, scheduleFor('settler'));
    run(shy, shyBrain, 10, 12, 1);

    const cornered = new MovingAgent('worker');
    cornered.player.z = 2.5;
    cornered.lookAtPlayer();
    const corneredBrain = new NpcBrain(cornered, scheduleFor('settler'));
    run(cornered, corneredBrain, 10, 12, 1);

    // Obstacle detour.
    day.blockedAhead = true;
    run(day, dayBrain, 13, 2, 0.3);
    day.blockedAhead = false;

    // Conversation.
    curious.talking = true;
    run(curious, curiousBrain, 10, 2, 0.3);
    curious.talking = false;

    expect([...seen].sort()).toEqual([...NPC_BEHAVIOURS].sort());
  });

  it('cycles through alternating tasks in order', () => {
    const agent = new FakeAgent();
    const calls: string[] = [];
    const node = (id: string, status: 'success' | 'running'): BehaviourNode => ({
      id, reset: () => undefined, tick: () => { calls.push(id); return status; },
    });
    let bTicks = 0;
    const b = (): BehaviourNode => ({
      id: 'b', reset: () => undefined,
      tick: () => { calls.push('b'); bTicks += 1; return bTicks < 2 ? 'running' : 'success'; },
    });
    const cycle = new CycleNode('cycle', [node('a', 'success'), b(), node('c', 'success')]);
    // Success advances the routine (a → b → c → a) without ending the loop.
    for (let i = 0; i < 6; i++) expect(cycle.tick(agent, 0.1)).toBe('running');
    expect(calls).toEqual(['a', 'b', 'b', 'c', 'a', 'b']);
  });

  it('exposes the full documented state vocabulary', () => {
    expect(NPC_BEHAVIOURS).toEqual(expect.arrayContaining([
      'idle', 'walk', 'run', 'look', 'talk', 'work', 'sit', 'eat', 'sleep',
      'follow', 'wait', 'investigate', 'react', 'avoid', 'travel', 'return',
    ]));
    expect(new Set(NPC_BEHAVIOURS).size).toBe(NPC_BEHAVIOURS.length);
    // WanderNode can be asked for any locomotion state it supports.
    const agent = new FakeAgent();
    const node = new WanderNode('walk', 8, 10, 'walk', 0.8);
    node.tick(agent, 0.1);
    expect(agent.behaviour).toBe('walk');
    expect(agent.lastSpeed).toBeLessThan(agent.speed);
  });
});
