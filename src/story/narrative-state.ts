import type { ActId } from './campaign';

/**
 * Narrative state — the story half of a save.
 *
 * Everything here is bounded and validated on the way in: a hostile or corrupt
 * slot degrades to a default narrative (or rejects the field) instead of
 * exhausting memory. Keys are NOT duplicated here — they live in the existing
 * inventory (already persisted); doors and breakers record which world locks
 * the story has resolved.
 */

export const ACT_IDS = ['prologue', 'act1', 'act2', 'act3', 'finale'] as const;
export const STORY_ID_LIMIT = 64;
export const STORY_LIST_LIMIT = 64;

export interface NarrativeState {
  act: ActId;
  /** Cutscenes that have already played this playthrough. */
  cutscenes: string[];
  /** Collected clue ids (documents, cassettes, audio logs). */
  clues: string[];
  /** Door/gate ids the story has unlocked. */
  doors: string[];
  /** Breaker/switch ids the story has engaged. */
  breakers: string[];
}

export function defaultNarrativeState(): NarrativeState {
  return { act: 'prologue', cutscenes: [], clues: [], doors: [], breakers: [] };
}

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= STORY_LIST_LIMIT &&
  value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= STORY_ID_LIMIT);

/**
 * Validate an untrusted story slice. Returns null when the value cannot be
 * trusted at all; partial values are sanitised (unknown ids dropped by the
 * consumer if they don't match registered content).
 */
export function validateNarrativeState(value: unknown): NarrativeState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const act = record.act;
  if (typeof act !== 'string' || !(ACT_IDS as readonly string[]).includes(act)) return null;
  const state: NarrativeState = {
    act: act as ActId,
    cutscenes: isIdList(record.cutscenes) ? [...new Set(record.cutscenes)] : [],
    clues: isIdList(record.clues) ? [...new Set(record.clues)] : [],
    doors: isIdList(record.doors) ? [...new Set(record.doors)] : [],
    breakers: isIdList(record.breakers) ? [...new Set(record.breakers)] : [],
  };
  return state;
}

export class NarrativeTracker {
  private state: NarrativeState = defaultNarrativeState();

  snapshot(): NarrativeState {
    return {
      act: this.state.act,
      cutscenes: [...this.state.cutscenes],
      clues: [...this.state.clues],
      doors: [...this.state.doors],
      breakers: [...this.state.breakers],
    };
  }

  restore(value: unknown): void {
    this.state = validateNarrativeState(value) ?? defaultNarrativeState();
  }

  get act(): ActId { return this.state.act; }
  setAct(act: ActId): void { this.state.act = act; }

  hasCutscene(id: string): boolean { return this.state.cutscenes.includes(id); }
  markCutscene(id: string): void {
    if (id.length === 0 || id.length > STORY_ID_LIMIT || this.hasCutscene(id)) return;
    if (this.state.cutscenes.length >= STORY_LIST_LIMIT) return;
    this.state.cutscenes.push(id);
  }

  private addUnique(list: string[], id: string): boolean {
    if (id.length === 0 || id.length > STORY_ID_LIMIT || list.includes(id)) return false;
    if (list.length >= STORY_LIST_LIMIT) return false;
    list.push(id);
    return true;
  }

  hasClue(id: string): boolean { return this.state.clues.includes(id); }
  addClue(id: string): boolean { return this.addUnique(this.state.clues, id); }

  isDoorOpen(id: string): boolean { return this.state.doors.includes(id); }
  openDoor(id: string): boolean { return this.addUnique(this.state.doors, id); }

  isBreakerOn(id: string): boolean { return this.state.breakers.includes(id); }
  engageBreaker(id: string): boolean { return this.addUnique(this.state.breakers, id); }
}
