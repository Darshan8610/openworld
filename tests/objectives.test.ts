import { describe, expect, it } from 'vitest';
import { GameEventBus } from '../src/core/events';
import { ObjectiveRuntime, MISSION_LIMIT, OBJECTIVES_PER_MISSION } from '../src/game/objectives';
import type { MissionDef } from '../src/game/objectives';

const setup = () => {
  const events = new GameEventBus();
  const runtime = new ObjectiveRuntime(events);
  const log: string[] = [];
  events.on('mission:started', ({ id }) => log.push(`start:${id}`));
  events.on('mission:objectiveCompleted', ({ id, missionId }) => log.push(`obj:${missionId}:${id}`));
  events.on('mission:completed', ({ id }) => log.push(`done:${id}`));
  events.on('mission:flagSet', ({ name }) => log.push(`flag:${name}`));
  return { events, runtime, log };
};

const interact = (id: string) => ({ id, archetype: 'cache', action: 'open', label: 'Cache', actor: 'player' });
const enterVehicle = (id: string) => ({ id, key: id, seat: 'driver', actor: 'player' });

const eventMission = (): MissionDef => ({
  id: 'm1', title: 'Test mission',
  objectives: [
    { id: 'o1', kind: 'event', label: 'Interact twice', event: 'object:interacted', count: 2 },
    { id: 'o2', kind: 'flag', label: 'Gate open', flag: 'gate.open', flagValue: true },
    { id: 'o3', kind: 'reach', label: 'Reach the point', point: { x: 100, z: 0, radius: 10 } },
  ],
});

describe('Phase 11 mission/objective/flag runtime', () => {
  it('counts matching bus events and completes objectives and missions', () => {
    const { runtime, events, log } = setup();
    expect(runtime.register([eventMission()])).toEqual([]);
    expect(runtime.start('m1')).toBe(true);
    expect(runtime.state('m1')).toBe('active');
    events.emit('object:interacted', interact('cache-1'));
    expect(runtime.snapshotMission('m1')?.objectives[0]).toMatchObject({ progress: 1, required: 2, done: false });
    events.emit('object:interacted', interact('cache-2'));
    events.emit('object:interacted', interact('cache-3')); // over-counting must be capped
    expect(runtime.snapshotMission('m1')?.objectives[0]).toMatchObject({ progress: 2, done: true });
    // A non-matching payload never advances the counter.
    events.emit('vehicle:entered', enterVehicle('jeep'));
    expect(log).toContain('start:m1');
    expect(log).toContain('obj:m1:o1');
  });

  it('ignores payloads that fail the objective match filter', () => {
    const { runtime, events } = setup();
    runtime.register([{
      id: 'm', title: '', objectives: [{ id: 'o', kind: 'event', label: '', event: 'vehicle:entered', match: { id: 'bus' } }],
    }]);
    runtime.start('m');
    events.emit('vehicle:entered', enterVehicle('jeep'));
    expect(runtime.snapshotMission('m')?.objectives[0]?.progress).toBe(0);
    events.emit('vehicle:entered', enterVehicle('bus'));
    expect(runtime.snapshotMission('m')?.objectives[0]?.progress).toBe(1);
  });

  it('evaluates flag and reach objectives and emits completion', () => {
    const { runtime, events, log } = setup();
    runtime.register([eventMission()]);
    runtime.start('m1');
    runtime.setFlag('gate.open', true);
    expect(runtime.getFlag('gate.open')).toBe(true);
    runtime.updatePlayer(105, 0);
    expect(log).toContain('obj:m1:o2');
    expect(log).toContain('obj:m1:o3');
    events.emit('object:interacted', interact('a'));
    events.emit('object:interacted', interact('b'));
    expect(log).toContain('done:m1');
    expect(runtime.state('m1')).toBe('completed');
    expect(runtime.start('m1')).toBe(false); // no restarts
  });

  it('is story-independent: rejects malformed definitions and unknown ids', () => {
    const { runtime, events } = setup();
    const rejected = runtime.register([
      { id: '', title: 'x', objectives: [{ id: 'o', kind: 'event', label: '', event: 'object:interacted' }] },
      { id: 'ok-but-no-objectives', title: 'x', objectives: [] },
      { id: 'bad-event', title: 'x', objectives: [{ id: 'o', kind: 'event', label: '', event: 'bogus:event' as never }] },
      { id: 'bad-reach', title: 'x', objectives: [{ id: 'o', kind: 'reach', label: '', point: { x: NaN, z: 0, radius: 5 } }] },
      eventMission(),
    ]);
    expect(rejected).toEqual(['', 'ok-but-no-objectives', 'bad-event', 'bad-reach']);
    expect(runtime.has('m1')).toBe(true);
    expect(runtime.start('nope')).toBe(false);
    expect(events); // bus untouched by rejections
  });

  it('bounds registration', () => {
    const { runtime } = setup();
    const defs: MissionDef[] = [];
    for (let i = 0; i < MISSION_LIMIT + 5; i++) {
      defs.push({ id: `m${i}`, title: '', objectives: [{ id: 'o', kind: 'flag', label: '', flag: 'f', flagValue: 1 }] });
    }
    expect(runtime.register(defs).length).toBe(5);
    const many: MissionDef = {
      id: 'fat', title: '',
      objectives: Array.from({ length: OBJECTIVES_PER_MISSION + 1 }, (_, i) => ({ id: `o${i}`, kind: 'flag' as const, label: '', flag: 'f', flagValue: 1 })),
    };
    expect(runtime.register([many])).toEqual(['fat']);
  });

  it('roundtrips snapshot/restore and drops unknown or hostile progress', () => {
    const { runtime, events } = setup();
    runtime.register([eventMission()]);
    runtime.start('m1');
    runtime.setFlag('gate.open', true);
    events.emit('object:interacted', interact('a'));
    const saved = runtime.snapshot();
    expect(saved.started).toEqual(['m1']);
    expect(saved.counts['m1:o1']).toBe(1);

    const fresh = new ObjectiveRuntime(events);
    fresh.register([eventMission()]);
    fresh.restore(saved);
    expect(fresh.state('m1')).toBe('active');
    expect(fresh.getFlag('gate.open')).toBe(true);
    // The flag objective re-evaluates on restore; the counted one carries over.
    expect(fresh.snapshotMission('m1')?.objectives[1]?.done).toBe(true);
    expect(fresh.snapshotMission('m1')?.objectives[0]?.progress).toBe(1);

    // Hostile progress is stripped, not trusted.
    fresh.restore({
      flags: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, i])),
      started: ['m1', 'ghost', ...Array.from({ length: 100 }, (_, i) => `x${i}`)],
      completed: ['ghost'],
      counts: { 'm1:o1': -5, 'm1:o2': 1e300 },
    });
    const after = fresh.snapshot();
    expect(Object.keys(after.flags).length).toBeLessThanOrEqual(256);
    expect(after.started).toEqual(['m1']);
    expect(after.completed).toEqual([]);
    expect(after.counts['m1:o1'] ?? 0).toBe(0);
    expect(Number.isFinite(after.counts['m1:o2'])).toBe(true);
    fresh.dispose();
    runtime.dispose();
  });
});
