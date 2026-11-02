import { afterAll, describe, expect, it } from 'vitest';
import { WorldQueries } from '../src/world/world-queries';
import { NPC_CELL_SIZE, planNpcCell, npcCellsAround } from '../src/npc/npc-placement';
import { NPC_DEFINITIONS } from '../src/npc/npc-definitions';
import { NPC_ACTIVITIES, NPC_BEHAVIOURS, NPC_ROLES, isNpcRole } from '../src/npc/types';
import type { PlacedNpc } from '../src/npc/types';
import { buildDialogueContext, compassLabel, composeDialogueLine, DialogueSession, DIALOGUE_TOPICS } from '../src/npc/dialogue';
import { NPC_SAVE_FORMAT, NPC_SAVE_LIMIT, NPC_SAVE_VERSION, NpcStateStore, validateNpcSave } from '../src/persistence/npc-store';

const seed = 'phase8-placement';
const queries = new WorldQueries(seed);
afterAll(() => queries.clearCache());

/** Find a cell that actually contains a planned NPC. */
function populatedCell(target: WorldQueries, seedValue = seed): { cellX: number; cellZ: number; planned: PlacedNpc[] } {
  for (let radius = 0; radius < 6; radius++) {
    for (const cell of npcCellsAround(0, 0, radius)) {
      const planned = planNpcCell(cell.cellX, cell.cellZ, { seed: seedValue, queries: target });
      if (planned.length > 0) return { cellX: cell.cellX, cellZ: cell.cellZ, planned };
    }
  }
  throw new Error('no populated NPC cell found');
}

describe('NPC placement', () => {
  it('is deterministic for a seed and cell', () => {
    const cell = { cellX: 1, cellZ: -2 };
    const first = planNpcCell(cell.cellX, cell.cellZ, { seed, queries });
    const second = planNpcCell(cell.cellX, cell.cellZ, { seed, queries });
    expect(second).toEqual(first);
    const other = planNpcCell(cell.cellX, cell.cellZ, { seed: `${seed}-other`, queries });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it('emits every NPC inside the owning cell, off the carriageway and on walkable ground', () => {
    const { cellX, cellZ, planned } = populatedCell(queries);
    expect(planned.length).toBeGreaterThan(0);
    const left = cellX * NPC_CELL_SIZE, top = cellZ * NPC_CELL_SIZE;
    for (const npc of planned) {
      expect(npc.x).toBeGreaterThanOrEqual(left);
      expect(npc.x).toBeLessThan(left + NPC_CELL_SIZE);
      expect(npc.z).toBeGreaterThanOrEqual(top);
      expect(npc.z).toBeLessThan(top + NPC_CELL_SIZE);
      expect(Math.abs(queries.road(npc.x, npc.z).lateral)).toBeGreaterThan(8.5);
      expect(queries.slope(npc.x, npc.z)).toBeLessThanOrEqual(0.56);
      expect(NPC_ROLES).toContain(npc.role);
      expect(Number.isFinite(npc.x + npc.y + npc.z + npc.yaw)).toBe(true);
      for (const anchor of Object.values(npc.anchors)) {
        expect(Number.isFinite(anchor.x + anchor.y + anchor.z)).toBe(true);
        expect(Math.hypot(anchor.x - npc.x, anchor.z - npc.z)).toBeLessThan(220);
      }
    }
  });

  it('never gives two cells the same NPC id', () => {
    const ids = new Set<string>();
    for (const cell of npcCellsAround(0, 0, 2)) {
      for (const npc of planNpcCell(cell.cellX, cell.cellZ, { seed, queries })) {
        expect(ids.has(npc.id)).toBe(false);
        ids.add(npc.id);
      }
    }
    expect(ids.size).toBeGreaterThan(0);
  });

  it('defines a role catalogue with real behaviour data', () => {
    for (const role of NPC_ROLES) {
      const definition = NPC_DEFINITIONS[role];
      expect(definition.role).toBe(role);
      expect(definition.label.length).toBeGreaterThan(3);
      expect(definition.radii.full).toBeLessThan(definition.radii.reduced);
      expect(definition.radii.reduced).toBeLessThan(definition.radii.background);
      expect(definition.speedScale).toBeGreaterThan(0.5);
    }
    expect(isNpcRole('worker')).toBe(true);
    expect(isNpcRole('dragon')).toBe(false);
    expect(NPC_ACTIVITIES).toContain('work');
    expect(NPC_BEHAVIOURS).toContain('investigate');
  });
});

describe('NPC dialogue hooks', () => {
  it('derives answers from live world data, not authored content', () => {
    const position = { x: 34, y: queries.height(34, 34), z: 34 };
    const context = buildDialogueContext(queries, position, 14.5, 'Trail watcher', 'working');
    expect(context.roadDistance).toBeGreaterThanOrEqual(0);
    expect(context.slopeDegrees).toBeGreaterThanOrEqual(0);
    expect(context.hourLabel).toBe('14:30');
    expect(context.compass.length).toBeGreaterThan(3);

    const conditions = composeDialogueLine('conditions', context);
    expect(conditions.text).toContain(context.surface);
    expect(conditions.closing).toBe(false);
    const activity = composeDialogueLine('activity', context);
    expect(activity.text).toContain('Trail watcher');
    expect(activity.text).toContain('working');
    expect(composeDialogueLine('farewell', context).closing).toBe(true);
  });

  it('labels compass directions with -Z as north', () => {
    expect(compassLabel(0, -10)).toBe('north');
    expect(compassLabel(10, 0)).toBe('east');
    expect(compassLabel(0, 10)).toBe('south');
    expect(compassLabel(-10, 0)).toBe('west');
  });

  it('opens, answers and closes a conversation', () => {
    const session = new DialogueSession('npc.1', 'Trail worker', () =>
      buildDialogueContext(queries, { x: 0, y: 0, z: 0 }, 9, 'Trail worker', 'working'));
    expect(session.open).toBe(true);
    expect(session.topicList).toHaveLength(DIALOGUE_TOPICS.length);
    expect(session.select(9)).toBeNull();
    const line = session.select(0);
    expect(line?.topicId).toBe('conditions');
    expect(session.line?.text).toBe(line!.text);
    const farewell = session.selectById('farewell');
    expect(farewell?.closing).toBe(true);
    expect(session.open).toBe(false);
    expect(session.select(0)).toBeNull();
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const record = {
  role: 'worker' as const,
  x: 12.5, y: 40, z: -30.25, yaw: 1.1,
  behaviour: 'work' as const,
  activity: 'work' as const,
  talked: true,
};

describe('NPC persistence', () => {
  it('round-trips a versioned, seed-keyed envelope', () => {
    const storage = memoryStorage();
    const store = new NpcStateStore(storage);
    const saved = store.save('seed-a', { 'npc.1': record }, 1000);
    expect(saved.status).toBe('ok');
    const loaded = store.load('seed-a');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') throw new Error('unreachable');
    expect(loaded.save.format).toBe(NPC_SAVE_FORMAT);
    expect(loaded.save.version).toBe(NPC_SAVE_VERSION);
    expect(loaded.save.seed).toBe('seed-a');
    expect(loaded.save.savedAt).toBe(1000);
    expect(loaded.save.npcs['npc.1']).toEqual(record);
    expect(store.load('seed-b').status).toBe('empty');
  });

  it('drops malformed rows and keeps valid ones while sanitising fields', () => {
    const save = validateNpcSave({
      format: NPC_SAVE_FORMAT, version: 1, seed: 's', savedAt: 5,
      npcs: {
        good: { role: 'watcher', x: 1, y: 2, z: 3, yaw: 0, behaviour: 'work', activity: 'work', talked: true },
        unknownRole: { role: 'dragon', x: 1, y: 2, z: 3 },
        missingCoords: { role: 'worker', x: 1 },
        oddFields: { role: 'worker', x: 1, y: 2, z: 3, yaw: 'north', behaviour: 'dancing', activity: 'sleeping', talked: 'yes', extra: true },
        hugeY: { role: 'wanderer', x: 0, y: 1e9, z: 0 },
      },
    });
    expect(save.status).toBe('ok');
    if (save.status !== 'ok') throw new Error('unreachable');
    expect(Object.keys(save.save.npcs).sort()).toEqual(['good', 'hugeY', 'oddFields']);
    expect(save.save.npcs.oddFields).toMatchObject({ yaw: 0, behaviour: 'idle', activity: 'wander', talked: false });
    expect(save.save.npcs.hugeY!.y).toBe(9000);
  });

  it('refuses to overwrite a newer format and reports corruption', () => {
    const storage = memoryStorage();
    const store = new NpcStateStore(storage);
    expect(store.save('seed', { 'npc.1': record }).status).toBe('ok');
    const key = [...storage.data.keys()][0]!;
    storage.data.set(key, JSON.stringify({ ...JSON.parse(storage.data.get(key)!), version: NPC_SAVE_VERSION + 1 }));
    const loaded = store.load('seed');
    expect(loaded.status).toBe('invalid');
    expect(loadReason(loaded)).toContain('newer format');
    expect(store.save('seed', { 'npc.1': record }).status).toBe('refused');

    storage.data.set(key, '{not json');
    expect(store.load('seed').status).toBe('invalid');
    // Corrupt JSON is recoverable: the next write replaces it.
    expect(store.save('seed', { 'npc.1': record }).status).toBe('ok');

    storage.data.set(key, JSON.stringify({ format: 'something.else', version: 1 }));
    expect(loadReason(store.load('seed'))).toContain('different format');
    expect(store.save('seed', { 'npc.1': record }).status).toBe('refused');
  });

  it('caps the stored population', () => {
    const npcs: Record<string, typeof record> = {};
    for (let i = 0; i < NPC_SAVE_LIMIT + 40; i++) npcs[`npc.${i}`] = { ...record, x: i };
    const result = validateNpcSave({ format: NPC_SAVE_FORMAT, version: 1, seed: 's', npcs });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(Object.keys(result.save.npcs)).toHaveLength(NPC_SAVE_LIMIT);
  });

  it('reports unavailable storage instead of throwing', () => {
    const store = new NpcStateStore(undefined);
    expect(store.available).toBe(false);
    expect(store.load('seed').status).toBe('empty');
    expect(store.save('seed', {}).status).toBe('failed');
  });
});

function loadReason(result: ReturnType<typeof validateNpcSave>): string {
  return result.status === 'invalid' ? result.reason : '';
}
