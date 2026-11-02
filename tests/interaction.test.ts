import { describe, expect, it } from 'vitest';
import { selectTarget, DEFAULT_TARGET_OPTIONS } from '../src/interaction/targeting';
import type { Targetable } from '../src/interaction/targeting';
import { InteractionManager } from '../src/interaction/manager';
import type { InteractionProvider } from '../src/interaction/types';
import { Inventory } from '../src/interaction/inventory';
import { GameEventBus } from '../src/core/events';
import { PropPhysicsWorld } from '../src/physics/prop-physics';
import { WorldQueries } from '../src/world/world-queries';
import { actionsFor, rollContainerContents } from '../src/objects/actions';
import { archetypeOrThrow } from '../src/objects/archetypes';
import type { ObjectArchetype, ObjectState } from '../src/objects/archetypes';
import type { WorldPoint } from '../src/core/coordinates';

const target = (id: string, x: number, y: number, z: number, radius = 0.5, range = 3): Targetable => ({
  id, centre: { x, y, z }, radius, range, label: id,
});

describe('context targeting', () => {
  it('prefers what is centred in the view over a nearer off-axis object', () => {
    const view = { eye: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };
    const centred = target('centred', 0.2, 0, -3.2);
    const nearerSide = target('side', 1.6, 0, -2.2);
    const hit = selectTarget([nearerSide, centred], view);
    expect(hit?.target.id).toBe('centred');
    expect(hit?.mode).toBe('aimed');
  });

  it('falls back to touch range for an object that is not centred', () => {
    const view = { eye: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };
    // Directly behind the player but within proximity radius.
    const behind = target('behind', 0, 0, 1.2, 0.4, 3);
    expect(selectTarget([behind], view)?.mode).toBe('proximity');
  });

  it('rejects targets beyond both their own range and the global cap', () => {
    const view = { eye: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };
    expect(selectTarget([target('far', 0, 0, -12, 0.5, 3)], view)).toBeUndefined();
  });

  it('rejects off-axis targets outside the aim cone and outside reach', () => {
    const view = { eye: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };
    // 5 m to the side at 5 m depth: outside a 16° cone and outside 2.3 m proximity.
    expect(selectTarget([target('steep', 5, 0, -5, 0.4, 8)], view)).toBeUndefined();
  });

  it('accounts for the target radius so large objects are usable from their surface', () => {
    const view = { eye: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };
    // Centre is outside the 3 m range, but the surface is only 2.8 m away.
    const wide = target('wide', 0, 0, -5, 2.2, 3);
    const hit = selectTarget([wide], view, { ...DEFAULT_TARGET_OPTIONS, maxRange: 6.5 });
    expect(hit?.target.id).toBe('wide');
    expect(hit!.distance).toBeCloseTo(2.8, 1);
  });
});

class FakeProvider implements InteractionProvider {
  readonly actionsList: ReturnType<typeof actionsFor>;
  removed = false;
  constructor(
    readonly id: string,
    readonly archetype: ObjectArchetype,
    readonly centre: WorldPoint,
    private stateValue: ObjectState,
    readonly radius = 0.5,
    private readonly onRemove?: (id: string) => void,
  ) {
    this.actionsList = actionsFor(archetype);
  }
  get range(): number { return this.archetype.range; }
  get targetLabel(): string { return this.archetype.label; }
  get persistence() { return this.archetype.persistence; }
  actions() { return this.actionsList; }
  state(): ObjectState { return this.stateValue; }
  setState(patch: Partial<ObjectState>): void { this.stateValue = { ...this.stateValue, ...patch }; }
  remove(): void { this.removed = true; this.onRemove?.(this.id); }
}

function harness() {
  const events = new GameEventBus();
  const inventory = new Inventory(events);
  const physics = new PropPhysicsWorld({ maxBodies: 4 });
  const queries = new WorldQueries('interaction-test');
  const messages: string[] = [];
  const manager = new InteractionManager({
    inventory, physics, queries, events, notify: (message) => messages.push(message),
  });
  const actor = (x: number, z: number, forwardZ = -1) => ({
    id: 'player',
    position: { x, y: 1.6, z },
    forward: { x: 0, y: 0, z: forwardZ },
    yaw: 0,
  });
  return { events, inventory, physics, queries, messages, manager, actor };
}

describe('interaction manager', () => {
  it('opens a gate on a tap and reports the new prompt label', () => {
    const { manager, events, actor } = harness();
    const gate = new FakeProvider('gate-1', archetypeOrThrow('access-gate'), { x: 0, y: 1, z: -2 }, { open: false });
    manager.register(gate);
    const interacted: string[] = [];
    events.on('object:interacted', (event) => interacted.push(event.action));

    let prompt = manager.update(1 / 120, actor(0, 0), { pressed: true, down: true });
    expect(prompt?.targetLabel).toBe('Trail gate');
    expect(gate.state().open).toBe(false);
    for (let i = 0; i < 30; i++) prompt = manager.update(1 / 120, actor(0, 0), { pressed: false, down: true });
    expect(gate.state().open).toBe(true);
    expect(interacted).toEqual(['toggle']);

    const next = manager.update(1 / 120, actor(0, 0), { pressed: false, down: false });
    expect(next?.actionLabel).toBe('Close gate');
  });

  it('requires the full hold before an action fires and reports progress', () => {
    const { manager, actor } = harness();
    const valve = new FakeProvider('valve-1', archetypeOrThrow('service-valve'), { x: 0, y: 0.6, z: -1.6 }, { level: 0 });
    manager.register(valve);
    const step = 1 / 120;
    let progress = 0;
    for (let i = 0; i < 30; i++) {
      const prompt = manager.update(step, actor(0, 0), { pressed: i === 0, down: true });
      progress = prompt?.progress ?? 0;
    }
    expect(valve.state().level).toBe(0);
    expect(progress).toBeGreaterThan(0.3);
    expect(progress).toBeLessThan(1);
    for (let i = 0; i < 60; i++) manager.update(step, actor(0, 0), { pressed: false, down: true });
    expect(valve.state().level).toBe(1);
  });

  it('confirms a valve on a single press when hold-to-confirm is disabled', () => {
    const { manager, actor } = harness();
    const valve = new FakeProvider('valve-access', archetypeOrThrow('service-valve'), { x: 0, y: 0.6, z: -1.6 }, { level: 0 });
    manager.register(valve);
    expect(manager.requiresHold).toBe(true);
    manager.setHoldToConfirm(false);
    expect(manager.requiresHold).toBe(false);

    const prompt = manager.update(1 / 120, actor(0, 0), { pressed: true, down: true });
    expect(prompt?.progress).toBe(1);
    expect(valve.state().level).toBe(1);

    // Re-enabling the accessibility option restores the full hold.
    manager.setHoldToConfirm(true);
    manager.unregister('valve-access');
    const gate = new FakeProvider('gate-access', archetypeOrThrow('access-gate'), { x: 0, y: 1, z: -2 }, { open: false });
    manager.register(gate);
    for (let i = 0; i < 30; i++) manager.update(1 / 120, actor(0, 0), { pressed: i === 0, down: true });
    expect(gate.state().open).toBe(true);
  });

  it('cancels a hold when the key is released', () => {
    const { manager, actor } = harness();
    const valve = new FakeProvider('valve-2', archetypeOrThrow('service-valve'), { x: 0, y: 0.6, z: -1.6 }, { level: 0 });
    manager.register(valve);
    for (let i = 0; i < 30; i++) manager.update(1 / 120, actor(0, 0), { pressed: i === 0, down: true });
    manager.update(1 / 120, actor(0, 0), { pressed: false, down: false });
    // A fresh hold that is far shorter than the required 0.6 s must not fire.
    for (let i = 0; i < 30; i++) manager.update(1 / 120, actor(0, 0), { pressed: false, down: true });
    expect(valve.state().level).toBe(0);
  });

  it('collects a pickup into the inventory and unregisters it', () => {
    const { manager, inventory, events, actor } = harness();
    const pickup = new FakeProvider('tool-1', archetypeOrThrow('tool-roll'), { x: 0, y: 0.2, z: -1.4 }, {}, 0.4,
      (id) => manager.unregister(id));
    manager.register(pickup);
    const collected: number[] = [];
    events.on('item:collected', (event) => collected.push(event.count));

    for (let i = 0; i < 40; i++) manager.update(1 / 120, actor(0, 0), { pressed: i === 0, down: true });
    expect(pickup.removed).toBe(true);
    expect(inventory.count('tool-kit')).toBe(1);
    expect(collected).toEqual([1]);
    expect(manager.providerCount).toBe(0);
    expect(manager.update(1 / 120, actor(0, 0), { pressed: false, down: false })).toBeNull();
  });

  it('does not fire an instant action twice inside its cooldown', () => {
    const { manager, actor } = harness();
    const gate = new FakeProvider('gate-2', archetypeOrThrow('access-gate'), { x: 0, y: 1, z: -2 }, { open: false });
    manager.register(gate);
    for (let i = 0; i < 30; i++) manager.update(1 / 120, actor(0, 0), { pressed: i === 0, down: true });
    expect(gate.state().open).toBe(true);
    // Still inside the action cooldown, and the gate is now mid-animation.
    expect(manager.press(actor(0, 0))).toBe(false);
  });

  it('ignores providers whose conditions are not met', () => {
    const { manager, actor } = harness();
    const container = new FakeProvider('crate-1', archetypeOrThrow('supply-crate'), { x: 0, y: 0.4, z: -1.6 }, { opened: false });
    manager.register(container);
    const prompt = manager.update(1 / 120, actor(0, 0), { pressed: false, down: false });
    expect(prompt?.actionLabel).toBe('Open');
    for (let i = 0; i < 30; i++) manager.update(1 / 120, actor(0, 0), { pressed: i === 0, down: true });
    expect(container.state().opened).toBe(true);
    expect(container.state().contents?.length).toBeGreaterThan(0);
    const second = manager.update(1 / 120, actor(0, 0), { pressed: false, down: false });
    expect(second?.actionLabel).toMatch(/^Take /);
  });

  it('publishes target changes only when the target actually changes', () => {
    const { manager, events, actor } = harness();
    const gate = new FakeProvider('gate-3', archetypeOrThrow('access-gate'), { x: 0, y: 1, z: -2 }, { open: false });
    manager.register(gate);
    const seen: (string | null)[] = [];
    events.on('interaction:targetChanged', ({ id }) => seen.push(id));
    for (let i = 0; i < 5; i++) manager.update(1 / 120, actor(0, 0), { pressed: false, down: false });
    manager.unregister('gate-3');
    manager.update(1 / 120, actor(0, 0), { pressed: false, down: false });
    expect(seen).toEqual(['gate-3', null]);
  });
});

describe('object actions', () => {
  it('seeds container contents deterministically per object id', () => {
    const archetype = archetypeOrThrow('supply-crate');
    expect(rollContainerContents(archetype, 'obj.cache.0.1')).toEqual(rollContainerContents(archetype, 'obj.cache.0.1'));
    const samples = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => rollContainerContents(archetype, `obj.cache.0.${n}`)[0]!.count));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('every archetype offers at least one usable action', () => {
    for (const key of ['access-gate', 'supply-crate', 'tool-roll', 'field-lamp', 'utility-switch', 'signal-lever', 'service-valve', 'rest-bench', 'trail-sign']) {
      const actions = actionsFor(archetypeOrThrow(key));
      expect(actions.length).toBeGreaterThan(0);
      expect(actions[0]!.id.length).toBeGreaterThan(0);
    }
  });

  it('seat actions swap between sit and stand', () => {
    const actions = actionsFor(archetypeOrThrow('rest-bench'));
    const sit = actions.find((action) => action.id === 'sit')!;
    const stand = actions.find((action) => action.id === 'stand')!;
    expect(sit.available?.({ seated: false }, new Inventory())).toBe(true);
    expect(sit.available?.({ seated: true }, new Inventory())).toBe(false);
    expect(stand.available?.({ seated: true }, new Inventory())).toBe(true);
  });
});
