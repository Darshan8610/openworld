import type { GameEventBus, GameEventType } from '../core/events';

/**
 * Phase 11 — mission / objective / flag runtime.
 *
 * Pure infrastructure: no story, no authored content, no dialogue. A mission is
 * data supplied by a later narrative layer; this runtime only tracks which
 * objectives are complete and emits typed events other systems can observe.
 *
 * Three objective kinds cover the generic cases:
 *  - `event` — count matching bus events (object interactions, water entry,
 *    conversations, vehicle use, …) optionally filtered by payload fields;
 *  - `flag`  — a named flag reaches a value;
 *  - `reach` — the player passes within `radius` of a canonical point
 *    (positions are fed in from the fixed step via `updatePlayer`).
 *
 * Everything is bounded: mission count, objectives per mission, flag count and
 * string sizes are validated on both registration and restore, so a corrupt or
 * hostile save cannot grow memory without limit.
 */

export type ObjectiveKind = 'event' | 'flag' | 'reach';

export interface ObjectiveDef {
  /** Unique inside its mission. */
  readonly id: string;
  readonly kind: ObjectiveKind;
  /** Generic label supplied by data — never authored here. */
  readonly label: string;
  /** kind 'event': which bus event to count. */
  readonly event?: GameEventType;
  /** kind 'event': every key must match the payload exactly. */
  readonly match?: Readonly<Record<string, string | number | boolean>>;
  /** kind 'event': required matches, default 1. */
  readonly count?: number;
  /** kind 'flag': flag name and required value. */
  readonly flag?: string;
  readonly flagValue?: boolean | number | string;
  /** kind 'reach': canonical target and radius in metres. */
  readonly point?: { readonly x: number; readonly z: number; readonly radius: number };
}

export interface MissionDef {
  readonly id: string;
  /** Generic title supplied by data. */
  readonly title: string;
  readonly objectives: readonly ObjectiveDef[];
}

export type MissionState = 'inactive' | 'active' | 'completed';

export interface MissionProgress {
  flags: Record<string, boolean | number | string>;
  started: string[];
  completed: string[];
  /** `${missionId}:${objectiveId}` → matches so far. */
  counts: Record<string, number>;
}

export interface MissionSnapshot {
  readonly id: string;
  readonly state: MissionState;
  readonly objectives: readonly { id: string; label: string; done: boolean; progress: number; required: number }[];
}

export const MISSION_LIMIT = 64;
export const OBJECTIVES_PER_MISSION = 32;
export const FLAG_LIMIT = 256;
export const FLAG_NAME_MAX = 64;

const EVENTS_WORTH_COUNTING: readonly GameEventType[] = [
  'object:interacted',
  'item:collected',
  'player:enteredWater',
  'player:exitedWater',
  'player:enteredBuilding',
  'player:exitedBuilding',
  'player:seated',
  'player:stood',
  'vehicle:entered',
  'vehicle:exited',
  'vehicle:damaged',
  'npc:talkStarted',
  'npc:talkEnded',
  'world:weatherChanged',
  'world:locationDiscovered',
];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function required(def: ObjectiveDef): number {
  return def.kind === 'event' ? Math.max(1, Math.floor(def.count ?? 1)) : 1;
}

export class ObjectiveRuntime {
  private readonly missions = new Map<string, MissionDef>();
  private readonly unsubscribers: (() => void)[] = [];
  private progress: MissionProgress = { flags: {}, started: [], completed: [], counts: {} };
  private readonly player = { x: 0, z: 0 };

  constructor(private readonly events: GameEventBus) {
    // One subscription per interesting event type, evaluated against every
    // active mission. Bounded by EVENTS_WORTH_COUNTING, not by mission count.
    for (const type of EVENTS_WORTH_COUNTING) {
      this.unsubscribers.push(events.on(type, (payload) => this.onBusEvent(type, payload as Record<string, unknown>)));
    }
  }

  /** Register mission definitions. Returns the ids that were rejected. */
  register(defs: readonly MissionDef[]): string[] {
    const rejected: string[] = [];
    for (const def of defs) {
      const valid =
        typeof def.id === 'string' && def.id.length > 0 && def.id.length <= 128 &&
        typeof def.title === 'string' && def.title.length <= 256 &&
        Array.isArray(def.objectives) &&
        def.objectives.length > 0 && def.objectives.length <= OBJECTIVES_PER_MISSION &&
        this.missions.size < MISSION_LIMIT &&
        !this.missions.has(def.id) &&
        def.objectives.every((o) => this.validObjective(o));
      if (!valid) { rejected.push(String(def.id).slice(0, 128)); continue; }
      this.missions.set(def.id, def);
    }
    return rejected;
  }

  private validObjective(o: ObjectiveDef): boolean {
    if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 128) return false;
    if (typeof o.label !== 'string' || o.label.length > 256) return false;
    if (o.kind === 'event') {
      if (!o.event || !EVENTS_WORTH_COUNTING.includes(o.event)) return false;
      if (o.match !== undefined && (!isRecord(o.match) || Object.keys(o.match).length > 8)) return false;
      return true;
    }
    if (o.kind === 'flag') {
      return typeof o.flag === 'string' && o.flag.length > 0 && o.flag.length <= FLAG_NAME_MAX &&
        (typeof o.flagValue === 'boolean' || typeof o.flagValue === 'number' || typeof o.flagValue === 'string');
    }
    if (o.kind === 'reach') {
      return !!o.point && Number.isFinite(o.point.x) && Number.isFinite(o.point.z) &&
        Number.isFinite(o.point.radius) && o.point.radius > 0 && o.point.radius <= 1e6;
    }
    return false;
  }

  has(missionId: string): boolean { return this.missions.has(missionId); }

  state(missionId: string): MissionState {
    if (this.progress.completed.includes(missionId)) return 'completed';
    if (this.progress.started.includes(missionId)) return 'active';
    return 'inactive';
  }

  start(missionId: string): boolean {
    const def = this.missions.get(missionId);
    if (!def || this.state(missionId) !== 'inactive') return false;
    this.progress.started.push(missionId);
    for (const objective of def.objectives) this.countOf(missionId, objective.id); // materialise counters
    this.events.emit('mission:started', { id: missionId });
    this.evaluateFlags();
    this.evaluateReaches();
    return true;
  }

  setFlag(name: string, value: boolean | number | string): void {
    if (typeof name !== 'string' || name.length === 0 || name.length > FLAG_NAME_MAX) return;
    const allowed = typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
    if (!allowed) return;
    const existing = Object.keys(this.progress.flags).length;
    if (!(name in this.progress.flags) && existing >= FLAG_LIMIT) return;
    this.progress.flags[name] = value;
    this.events.emit('mission:flagSet', { name, value });
    this.evaluateFlags();
  }

  getFlag(name: string): boolean | number | string | undefined { return this.progress.flags[name]; }

  /** Feed the player's canonical position for `reach` objectives (fixed step). */
  updatePlayer(x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this.player.x = x;
    this.player.z = z;
    this.evaluateReaches();
  }

  private countOf(missionId: string, objectiveId: string): number {
    return this.progress.counts[`${missionId}:${objectiveId}`] ?? 0;
  }

  private setCount(missionId: string, objectiveId: string, value: number): void {
    this.progress.counts[`${missionId}:${objectiveId}`] = value;
  }

  private onBusEvent(type: GameEventType, payload: Record<string, unknown>): void {
    for (const missionId of this.progress.started) {
      if (this.progress.completed.includes(missionId)) continue;
      const def = this.missions.get(missionId);
      if (!def) continue;
      for (const objective of def.objectives) {
        if (objective.kind !== 'event' || objective.event !== type) continue;
        if (objective.match && !Object.entries(objective.match).every(([k, v]) => payload[k] === v)) continue;
        const need = required(objective);
        const have = this.countOf(missionId, objective.id);
        if (have >= need) continue;
        const next = have + 1;
        this.setCount(missionId, objective.id, next);
        if (next >= need) this.completeObjective(def, objective);
      }
    }
  }

  private evaluateFlags(): void {
    for (const missionId of this.progress.started) {
      if (this.progress.completed.includes(missionId)) continue;
      const def = this.missions.get(missionId);
      if (!def) continue;
      for (const objective of def.objectives) {
        if (objective.kind !== 'flag' || this.countOf(missionId, objective.id) > 0) continue;
        if (this.progress.flags[objective.flag!] === objective.flagValue) {
          this.setCount(missionId, objective.id, 1);
          this.completeObjective(def, objective);
        }
      }
    }
  }

  private evaluateReaches(): void {
    for (const missionId of this.progress.started) {
      if (this.progress.completed.includes(missionId)) continue;
      const def = this.missions.get(missionId);
      if (!def) continue;
      for (const objective of def.objectives) {
        if (objective.kind !== 'reach' || this.countOf(missionId, objective.id) > 0) continue;
        const point = objective.point!;
        if (Math.hypot(this.player.x - point.x, this.player.z - point.z) <= point.radius) {
          this.setCount(missionId, objective.id, 1);
          this.completeObjective(def, objective);
        }
      }
    }
  }

  private completeObjective(def: MissionDef, objective: ObjectiveDef): void {
    this.events.emit('mission:objectiveCompleted', { id: objective.id, missionId: def.id, label: objective.label });
    const allDone = def.objectives.every((o) => this.countOf(def.id, o.id) >= required(o));
    if (allDone && !this.progress.completed.includes(def.id)) {
      this.progress.completed.push(def.id);
      this.events.emit('mission:completed', { id: def.id });
    }
  }

  /** UI-facing state for one mission. */
  snapshotMission(missionId: string): MissionSnapshot | undefined {
    const def = this.missions.get(missionId);
    if (!def) return undefined;
    return {
      id: def.id,
      state: this.state(missionId),
      objectives: def.objectives.map((o) => {
        const need = required(o);
        const have = Math.min(need, this.countOf(missionId, o.id));
        return { id: o.id, label: o.label, done: have >= need, progress: have, required: need };
      }),
    };
  }

  /** Registered mission ids, in registration order. */
  list(): string[] { return [...this.missions.keys()]; }

  snapshot(): MissionProgress {
    return {
      flags: { ...this.progress.flags },
      started: [...this.progress.started],
      completed: [...this.progress.completed],
      counts: { ...this.progress.counts },
    };
  }

  /**
   * Restore progress for already-registered missions. Unknown ids, malformed
   * structures and out-of-bounds sizes are dropped rather than trusted; the
   * mission definitions themselves are content, not save data.
   */
  restore(progress: MissionProgress): void {
    const clean: MissionProgress = { flags: {}, started: [], completed: [], counts: {} };
    if (isRecord(progress.flags)) {
      for (const [name, value] of Object.entries(progress.flags)) {
        if (name.length <= FLAG_NAME_MAX && (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') &&
            Object.keys(clean.flags).length < FLAG_LIMIT) clean.flags[name] = value;
      }
    }
    const ids = (v: unknown): string[] =>
      Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === 'string' && id.length <= 128))].slice(0, MISSION_LIMIT) : [];
    clean.started = ids(progress.started).filter((id) => this.missions.has(id));
    clean.completed = ids(progress.completed).filter((id) => this.missions.has(id));
    if (isRecord(progress.counts)) {
      for (const [key, value] of Object.entries(progress.counts)) {
        if (typeof key === 'string' && key.length <= 260 && typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
            Object.keys(clean.counts).length <= MISSION_LIMIT * OBJECTIVES_PER_MISSION) {
          clean.counts[key] = Math.floor(value);
        }
      }
    }
    this.progress = clean;
    this.evaluateFlags();
    this.evaluateReaches();
  }

  dispose(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.missions.clear();
  }
}
