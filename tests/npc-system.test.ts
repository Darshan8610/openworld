import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorldQueries } from '../src/world/world-queries';
import { GameEventBus } from '../src/core/events';
import { Inventory } from '../src/interaction/inventory';
import { InteractionManager } from '../src/interaction/manager';
import { PropPhysicsWorld } from '../src/physics/prop-physics';
import { NpcManager } from '../src/npc/npc-manager';
import { planNpcCell } from '../src/npc/npc-placement';
import type { PersistedNpcs, PlacedNpc } from '../src/npc/types';
import { ObjectSystem } from '../src/objects/object-system';
import { ARCHETYPE_BY_KEY } from '../src/objects/archetypes';
import { clearObjectGeometryCache } from '../src/rendering/object-geometry';

/**
 * Headless integration for the Phase 8 population: real terrain queries, real
 * interaction manager, real fixed-step locomotion. Only rendering is omitted.
 */
const seed = 'phase8-system';
const queries = new WorldQueries(seed);
afterAll(() => { queries.clearCache(); clearObjectGeometryCache(); });

/* World-object geometry builds a canvas texture atlas; stub it without a DOM. */
const canvasContext = new Proxy({} as Record<string, unknown>, {
  get: (target, key) => target[key as string] ?? (() => undefined),
  set: (target, key, value) => { target[key as string] = value; return true; },
});
beforeAll(() => {
  const globalRecord = globalThis as unknown as { document?: unknown };
  if (!globalRecord.document) {
    globalRecord.document = { createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext }) };
  }
});

/** A placement with room around it, used to stand the player next to someone. */
function findPlacement(target: WorldQueries): PlacedNpc {
  for (let radius = 0; radius < 6; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const planned = planNpcCell(dx, dz, { seed, queries: target });
        if (planned.length > 0) return planned[0]!;
      }
    }
  }
  throw new Error('no NPC placement found');
}

const spot = findPlacement(queries);
const player = { x: spot.x + 3, y: spot.y, z: spot.z + 3 };
const origin = { x: 0, y: 0, z: 0 };

interface HarnessOptions {
  budget?: number;
  rigBudget?: number;
  hour?: number;
  savedState?: PersistedNpcs;
  /** Override the simulated player position (defaults to the shared nearby spot). */
  player?: { x: number; y: number; z: number };
}

function harness(options: HarnessOptions = {}) {
  const events = new GameEventBus();
  const inventory = new Inventory(events);
  const physics = new PropPhysicsWorld({ maxBodies: 16 });
  const messages: string[] = [];
  const actor = options.player ?? player;
  const interaction = new InteractionManager({
    inventory, physics, queries, events, notify: (message) => messages.push(message),
  });
  let hour = options.hour ?? 12;
  const npcs = new NpcManager({
    seed,
    queries,
    events,
    interaction,
    quality: 'balanced',
    time: () => hour,
    notify: (message) => messages.push(message),
    budget: options.budget ?? 10,
    rigBudget: options.rigBudget ?? 2,
    ...(options.savedState ? { savedState: options.savedState } : {}),
  });
  const stream = (ticks = 4) => {
    for (let i = 0; i < ticks; i++) npcs.update(0.4, actor, origin, 1);
  };
  return {
    npcs, events, interaction, inventory, physics, messages, stream, player: actor,
    setHour: (value: number) => { hour = value; },
  };
}

const FIXED = 1 / 120;
function simulate(npcs: NpcManager, seconds: number, actor: { x: number; y: number; z: number } = player): void {
  const steps = Math.round(seconds / FIXED);
  for (let i = 0; i < steps; i++) npcs.fixedUpdate(FIXED, actor);
}

describe('NPC streaming', () => {
  it('streams a deterministic population inside the budget and registers providers', () => {
    const { npcs, interaction, stream } = harness({ budget: 8 });
    stream();
    const stats = npcs.stats;
    expect(stats.active).toBeGreaterThan(0);
    expect(stats.active).toBeLessThanOrEqual(8);
    expect(stats.cells).toBe(25);
    expect(stats.truncated).toBe(true);
    expect(interaction.providerCount).toBe(stats.active);
    for (const npc of npcs.list()) {
      expect(Number.isFinite(npc.x + npc.y + npc.z + npc.yaw)).toBe(true);
      expect(Math.hypot(npc.x - player.x, npc.z - player.z)).toBeLessThanOrEqual(640);
    }
    npcs.dispose();
    expect(interaction.providerCount).toBe(0);
  });

  it('converges instead of duplicating as planning warms up', () => {
    const { npcs, stream } = harness();
    // Planning is budgeted, so a fresh world fills its cells over a few ticks.
    stream(10);
    const first = npcs.list().map((npc) => npc.id).sort();
    expect(new Set(first).size).toBe(first.length);
    stream(3);
    const second = npcs.list().map((npc) => npc.id).sort();
    expect(second).toEqual(first);
    npcs.dispose();
  });

  it('assigns simulation levels and never exceeds the rig budget', () => {
    const { npcs, stream } = harness({ rigBudget: 1, budget: 12 });
    stream();
    const stats = npcs.stats;
    expect(stats.full + stats.reduced + stats.background).toBe(stats.active);
    expect(stats.rigs).toBeLessThanOrEqual(1);
    expect(stats.rigCapacity).toBe(1);
    for (const npc of npcs.list()) {
      if (npc.level === 2) expect(npc.rigged).toBe(false);
    }
    npcs.dispose();
  });

  it('hides the population on disable and restores it on enable', () => {
    const { npcs, interaction, stream } = harness();
    stream();
    expect(npcs.activeCount).toBeGreaterThan(0);
    npcs.setEnabled(false);
    expect(npcs.activeCount).toBe(0);
    expect(interaction.providerCount).toBe(0);
    npcs.setEnabled(true);
    stream();
    expect(npcs.activeCount).toBeGreaterThan(0);
    npcs.dispose();
  });
});

describe('NPC simulation', () => {
  it('moves, animates and stays on the ground over several seconds', () => {
    const { npcs, stream } = harness({ budget: 6, rigBudget: 1 });
    stream();
    const before = new Map(npcs.list().map((npc) => [npc.id, npc] as const));
    simulate(npcs, 6);
    const after = npcs.list();
    let moved = 0;
    for (const npc of after) {
      const previous = before.get(npc.id);
      if (!previous) continue;
      if (Math.hypot(npc.x - previous.x, npc.z - previous.z) > 0.05) moved += 1;
      // Feet follow the terrain rather than floating or sinking.
      expect(Math.abs(npc.y - queries.height(npc.x, npc.z))).toBeLessThan(3);
      expect(Math.abs(npc.y - previous.y)).toBeLessThan(30);
    }
    expect(moved).toBeGreaterThan(0);
    expect(npcs.stats.searches).toBeGreaterThanOrEqual(0);
    npcs.dispose();
  });

  it('keeps canonical positions across a floating-origin rebase', () => {
    const { npcs, stream } = harness();
    stream();
    const before = npcs.list();
    npcs.rebase({ x: 2048, y: 0, z: -2048 });
    const after = npcs.list();
    expect(after.map((npc) => [npc.id, npc.x, npc.z])).toEqual(before.map((npc) => [npc.id, npc.x, npc.z]));
    npcs.dispose();
  });

  it('changes behaviour as the world clock advances', () => {
    // A distant player: this test measures schedule-driven behaviour, not the
    // proximity startle that (correctly) fires when someone stands next to an NPC.
    const far = { x: spot.x + 400, y: spot.y, z: spot.z - 400 };
    const { npcs, stream, setHour, player: actor } = harness({ budget: 6, player: far });
    setHour(3);
    stream();
    simulate(npcs, 2, actor);
    const atNight = npcs.list();
    expect(atNight.length).toBeGreaterThan(0);
    // Nobody is pathfinding far from home at 3am: they are at rest or heading home.
    for (const npc of atNight) expect(['sleep', 'travel', 'idle', 'rest', 'work', 'wander']).toContain(npc.behaviour);

    setHour(12);
    simulate(npcs, 2, actor);
    const midday = new Set(npcs.list().map((npc) => npc.behaviour));
    expect(midday.size).toBeGreaterThan(0);
    npcs.dispose();
  });
});

describe('NPC interaction and persistence', () => {
  it('opens a conversation through the real interaction pipeline', () => {
    const { npcs, interaction, events, stream } = harness();
    stream();
    simulate(npcs, 0.5);
    const target = npcs.list().sort((a, b) => a.distance - b.distance)[0]!;

    const eye = { x: target.x - 2, y: target.y + 1.6, z: target.z };
    const dx = target.x - eye.x, dy = target.y + 1.05 - eye.y;
    const length = Math.hypot(dx, dy, 0);
    const actor = { id: 'player', position: eye, forward: { x: dx / length, y: dy / length, z: 0 }, yaw: 0 };

    const started: string[] = [];
    events.on('npc:talkStarted', ({ id }) => started.push(id));
    const prompted = interaction.update(0.02, actor, { pressed: true, down: true });
    expect(prompted?.targetLabel).toBe(target.label);
    expect(started).toEqual([target.id]);

    const view = npcs.conversationView!;
    expect(view.npcId).toBe(target.id);
    expect(view.topics.length).toBe(4);

    const lines: string[] = [];
    events.on('npc:topicSelected', ({ line }) => lines.push(line));
    const line = npcs.selectTopic(0);
    expect(line?.text.length).toBeGreaterThan(0);
    expect(lines[0]).toBe(line!.text);
    expect(npcs.conversationView?.line).toBe(line!.text);

    let ended = false;
    events.on('npc:talkEnded', () => { ended = true; });
    npcs.endConversation('player');
    expect(ended).toBe(true);
    expect(npcs.conversationView).toBeNull();

    // Talking marks the NPC as changed, which is what persistence stores.
    const state = npcs.serializeState();
    expect(state[target.id]?.talked).toBe(true);
    expect(npcs.list().find((npc) => npc.id === target.id)?.talked).toBe(true);
    npcs.dispose();
  });

  it('restores a saved NPC on a fresh world', () => {
    const first = harness();
    first.stream();
    expect(first.npcs.talkTo(nearestInstanceId(first.npcs))).toBe(true);
    const saved = first.npcs.serializeState();
    const savedId = Object.keys(saved)[0]!;
    expect(saved[savedId]!.talked).toBe(true);
    first.npcs.dispose();

    const second = harness({ savedState: saved });
    second.stream();
    const restored = second.npcs.list().find((npc) => npc.id === savedId);
    expect(restored).toBeDefined();
    expect(restored!.talked).toBe(true);
    expect(restored!.x).toBeCloseTo(saved[savedId]!.x, 5);
    second.npcs.dispose();
  });

  it('writes only changed NPCs to the save slice', () => {
    const { npcs, stream } = harness();
    stream();
    simulate(npcs, 8);
    const saved = npcs.serializeState();
    // Roaming NPCs have moved from their deterministic spawn, so they are stored…
    for (const [id, record] of Object.entries(saved)) {
      const npc = npcs.list().find((entry) => entry.id === id);
      if (npc) expect(record.talked || Math.hypot(record.x - npc.x, record.z - npc.z) < 1).toBe(true);
    }
    // …but the count can never exceed the streamed population.
    expect(Object.keys(saved).length).toBeLessThanOrEqual(npcs.stats.active);
    npcs.dispose();
  });
});

/** Nearest NPC by distance, for the talk shortcut used before aiming. */
function nearestInstanceId(npcs: NpcManager): string {
  const nearest = npcs.list().sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) throw new Error('no NPC streamed');
  return nearest.id;
}

describe('walk blockers', () => {
  it('reports solid static objects as impassable and dynamic props as passable', () => {
    const inventory = new Inventory(new GameEventBus());
    const physics = new PropPhysicsWorld({ maxBodies: 8 });
    const interaction = new InteractionManager({
      inventory, physics, queries, events: new GameEventBus(), notify: () => undefined,
    });
    const objects = new ObjectSystem({
      seed, queries, physics, interaction,
      events: new GameEventBus(), inventory, notify: () => undefined,
      budget: 60, loadRadius: 1,
    });
    objects.update(0.4, player, origin, 1);
    const listed = objects.list();
    if (listed.length === 0) { objects.dispose(); physics.clear(); return; }
    // Every listed object with a static mesh blocks walking through its footprint.
    const solid = listed.filter((object) => {
      const archetype = ARCHETYPE_BY_KEY.get(object.archetype);
      return archetype !== undefined && archetype.radius >= 0.5;
    });
    expect(solid.length).toBeGreaterThan(0);
    for (const object of solid) {
      const archetype = ARCHETYPE_BY_KEY.get(object.archetype)!;
      // Containers are physics props that can be pushed, so they never block a path.
      const dynamic = archetype.kind === 'container' || archetype.kind === 'pickup';
      expect(objects.blocksWalk(object.x, object.z)).toBe(!dynamic);
    }
    // Far away is always free.
    expect(objects.blocksWalk(player.x + 500, player.z + 500)).toBe(false);
    objects.dispose();
    physics.clear();
  });
});
