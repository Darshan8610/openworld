import type { NpcActivity, NpcAnchorKind, NpcScheduleId } from './types';

/**
 * Data-driven daily schedules.
 *
 * A schedule is a list of `[from, to)` hour windows and the activity they assign;
 * windows that wrap midnight are written as `from > to`. Roles differ only in
 * data, so authored NPCs (later phases) can define their own schedule without
 * touching code. Per-NPC phase offsets come from the seed, so a group of workers
 * does not move in lockstep.
 *
 * These are generic simulation rhythms (sleep, work, leisure, roam), not events,
 * quests or story beats.
 */
export interface ScheduleEntry {
  /** Start hour, inclusive, 0..24. */
  readonly from: number;
  /** End hour, exclusive, 0..24; may be smaller than `from` for overnight. */
  readonly to: number;
  readonly activity: NpcActivity;
}

export const DEFAULT_SCHEDULES: Readonly<Record<NpcScheduleId, readonly ScheduleEntry[]>> = {
  settler: [
    { from: 22, to: 6, activity: 'sleep' },
    { from: 6, to: 8, activity: 'leisure' },
    { from: 8, to: 12, activity: 'work' },
    { from: 12, to: 13, activity: 'leisure' },
    { from: 13, to: 17, activity: 'work' },
    { from: 17, to: 22, activity: 'leisure' },
  ],
  warden: [
    { from: 23, to: 5, activity: 'sleep' },
    { from: 5, to: 9, activity: 'work' },
    { from: 9, to: 12, activity: 'wander' },
    { from: 12, to: 14, activity: 'leisure' },
    { from: 14, to: 18, activity: 'work' },
    { from: 18, to: 21, activity: 'wander' },
    { from: 21, to: 23, activity: 'leisure' },
  ],
  roamer: [
    { from: 0, to: 7, activity: 'sleep' },
    { from: 7, to: 19, activity: 'wander' },
    { from: 19, to: 22, activity: 'leisure' },
    { from: 22, to: 24, activity: 'sleep' },
  ],
};

export function scheduleFor(id: NpcScheduleId): readonly ScheduleEntry[] {
  return DEFAULT_SCHEDULES[id];
}

/** Resolve the activity a schedule assigns at `hour` (0..24). */
export function resolveActivity(schedule: readonly ScheduleEntry[], hour: number): NpcActivity {
  const wrapped = ((hour % 24) + 24) % 24;
  for (const entry of schedule) {
    const inside = entry.from <= entry.to
      ? wrapped >= entry.from && wrapped < entry.to
      : wrapped >= entry.from || wrapped < entry.to;
    if (inside) return entry.activity;
  }
  // A schedule with a gap falls back to roaming rather than freezing in place.
  return 'wander';
}

/** Deterministic per-NPC schedule phase in hours, so a crowd is not synchronized. */
export function scheduleOffset(seedHash: number, slot: number): number {
  const mixed = (seedHash ^ Math.imul(slot + 1, 0x9e3779b1)) >>> 0;
  return ((mixed % 1000) / 1000 - 0.5) * 1.5;
}

/** Where the schedule sends an NPC for this activity. */
export function anchorForActivity(activity: NpcActivity): NpcAnchorKind {
  switch (activity) {
    case 'sleep': return 'home';
    case 'work': return 'work';
    case 'leisure': return 'leisure';
    case 'wander': return 'leisure';
  }
}

export const ACTIVITY_LABELS: Readonly<Record<NpcActivity, string>> = {
  sleep: 'resting',
  work: 'working',
  leisure: 'taking a break',
  wander: 'on the move',
};
