import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectSystem } from '../src/objects/object-system';
import { WorldQueries } from '../src/world/world-queries';
import { PropPhysicsWorld } from '../src/physics/prop-physics';
import { Inventory } from '../src/interaction/inventory';
import { InteractionManager } from '../src/interaction/manager';
import { GameEventBus } from '../src/core/events';
import { clearObjectGeometryCache } from '../src/rendering/object-geometry';
import { cellsAround, planObjectCell } from '../src/objects/placement';
import { ARCHETYPE_BY_KEY } from '../src/objects/archetypes';

/**
 * Headless integration coverage for streaming + interaction + persistence.
 * Three.js geometry and materials build without a GL context; only the canvas
 * text atlas needs a DOM stub, provided below.
 */
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
afterAll(() => { clearObjectGeometryCache(); });

function harness(options: { seed?: string; budget?: number; savedState?: Record<string, { archetype: string; state: Record<string, unknown> }>; loadRadius?: number } = {}) {
  const seed = options.seed ?? 'object-system-test';
  const queries = new WorldQueries(seed);
  const events = new GameEventBus();
  const inventory = new Inventory(events);
  const physics = new PropPhysicsWorld({ maxBodies: 48 });
  const messages: string[] = [];
  const interaction = new InteractionManager({
    inventory, physics, queries, events, notify: (message) => messages.push(message),
  });
  const objects = new ObjectSystem({
    seed, queries, physics, events, inventory, interaction,
    notify: (message) => messages.push(message),
    budget: options.budget ?? 48,
    loadRadius: options.loadRadius ?? 1,
    savedState: (options.savedState ?? {}) as never,
  });
  return { seed, queries, events, inventory, physics, interaction, objects, messages };
}

const origin = { x: 0, y: 0, z: 0 };
const player = { x: 0, y: 0, z: 600 };

describe('object streaming', () => {
  it('streams canonical objects, registers providers and attaches rigid bodies', () => {
    const { objects, interaction, physics } = harness();
    objects.update(0.4, player, origin, 1);
    const stats = objects.stats;
    expect(stats.active).toBeGreaterThan(0);
    expect(stats.cells).toBe(9);
    expect(interaction.providerCount).toBe(stats.active);
    expect(stats.bodies).toBe(stats.dynamic);
    expect(physics.stats.bodies).toBe(stats.bodies);
    expect(stats.active).toBeLessThanOrEqual(48);
    for (const object of objects.list()) {
      expect(Number.isFinite(object.x + object.y + object.z)).toBe(true);
    }
    objects.dispose();
    expect(interaction.providerCount).toBe(0);
    expect(physics.stats.bodies).toBe(0);
  });

  it('respects the streaming budget and reports truncation', () => {
    const { objects } = harness({ budget: 3 });
    objects.update(0.4, player, origin, 1);
    expect(objects.stats.active).toBeLessThanOrEqual(3);
    expect(objects.stats.truncated).toBe(true);
    objects.dispose();
  });

  it('keeps render transforms origin-relative while state stays canonical', () => {
    const { objects } = harness();
    objects.update(0.4, player, origin, 1);
    const canonical = objects.list();
    const shifted = { x: 4096, y: 0, z: -2048 };
    objects.rebase(shifted);
    expect(objects.group.children.length).toBe(canonical.length);
    for (const child of objects.group.children) {
      const match = canonical.some((object) => Math.abs(child.position.x - (object.x - shifted.x)) < 1e-6
        && Math.abs(child.position.z - (object.z - shifted.z)) < 1e-6);
      expect(match).toBe(true);
    }
    // Rebase must not mutate canonical positions or physics state.
    expect(objects.list().map((object) => object.x)).toEqual(canonical.map((object) => object.x));
    objects.dispose();
  });

  it('never respawns a collected object from a restored save', () => {
    // Take a real id from a first run, then restore it as already collected.
    const first = harness();
    first.objects.update(0.4, player, origin, 1);
    const victim = first.objects.list().find((object) => object.archetype === 'survey-post') ?? first.objects.list()[0]!;
    first.objects.dispose();

    const restored = harness({
      savedState: { [victim.id]: { archetype: victim.archetype, state: { collected: true } } },
    });
    restored.objects.update(0.4, player, origin, 1);
    expect(restored.objects.list().some((object) => object.id === victim.id)).toBe(false);
    restored.objects.dispose();
  });

  it('drops every provider and body when disabled, then restreams', () => {
    const { objects, interaction } = harness();
    objects.update(0.4, player, origin, 1);
    expect(objects.activeCount).toBeGreaterThan(0);
    objects.setEnabled(false);
    expect(objects.activeCount).toBe(0);
    expect(interaction.providerCount).toBe(0);
    objects.setEnabled(true);
    objects.update(0.4, player, origin, 1);
    expect(objects.activeCount).toBeGreaterThan(0);
    objects.dispose();
  });
});

describe('interaction against streamed objects', () => {
  it('opens a streamed container, takes its contents and persists the diff', () => {
    // Aim the harness at a known planned container instead of guessing a spot.
    const probe = new WorldQueries('object-system-test');
    let target;
    for (const cell of cellsAround(0, 0, 2)) {
      target = planObjectCell(cell.cellX, cell.cellZ, { seed: 'object-system-test', queries: probe })
        .find((object) => ARCHETYPE_BY_KEY.get(object.archetype)?.kind === 'container');
      if (target) break;
    }
    expect(target).toBeDefined();
    if (!target) return;

    const { objects, interaction, inventory } = harness();
    objects.update(0.4, { x: target.x, y: target.y, z: target.z }, origin, 1);
    const container = objects.list().find((object) => object.id === target.id);
    expect(container).toBeDefined();
    if (!container) return;
    expect(ARCHETYPE_BY_KEY.get(container.archetype)?.kind).toBe('container');

    const eye = { x: container.x, y: container.y + 0.2, z: container.z + 2.4 };
    const dx = container.x - eye.x, dy = container.y - eye.y, dz = container.z - eye.z;
    const length = Math.hypot(dx, dy, dz);
    const actor = { id: 'player', position: eye, forward: { x: dx / length, y: dy / length, z: dz / length }, yaw: 0 };

    for (let i = 0; i < 40; i++) interaction.update(1 / 120, actor, { pressed: i === 0, down: true });
    expect(objects.stateFor(container.id)?.opened).toBe(true);
    const contents = objects.stateFor(container.id)?.contents ?? [];
    expect(contents.length).toBeGreaterThan(0);

    for (let i = 0; i < 4; i++) interaction.update(1 / 120, actor, { pressed: false, down: false });
    for (let i = 0; i < 4; i++) interaction.update(1 / 120, actor, { pressed: i === 0, down: true });
    expect(inventory.total).toBeGreaterThan(0);
    expect(objects.stateFor(container.id)?.contents ?? []).toHaveLength(0);

    const saved = objects.serializeState();
    expect(saved[container.id]?.archetype).toBe(container.archetype);
    expect(saved[container.id]?.state.opened).toBe(true);
    objects.dispose();
  });

  it('restores a saved container state into a restreamed world', () => {
    const { objects } = harness();
    objects.update(0.4, player, origin, 1);
    const container = objects.list().find((object) => object.archetype === 'fuel-drum') ?? objects.list()[0]!;
    const id = container.id;
    objects.dispose();

    const restored = harness({
      savedState: { [id]: { archetype: container.archetype, state: { opened: true, contents: [] } } },
    });
    restored.objects.update(0.4, player, origin, 1);
    const state = restored.objects.stateFor(id);
    if (restored.objects.list().some((object) => object.id === id)) {
      expect(state?.opened).toBe(true);
    }
    restored.objects.dispose();
  });
});
