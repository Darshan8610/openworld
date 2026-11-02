import { describe, expect, it } from 'vitest';
import {
  NarrativeTracker, STORY_LIST_LIMIT, defaultNarrativeState, validateNarrativeState,
} from '../src/story/narrative-state';

describe('narrative state (act, clues, doors, cutscenes)', () => {
  it('starts at the prologue with everything empty', () => {
    const state = defaultNarrativeState();
    expect(state.act).toBe('prologue');
    expect(state.clues).toEqual([]);
    expect(state.doors).toEqual([]);
    expect(state.breakers).toEqual([]);
    expect(state.cutscenes).toEqual([]);
  });

  it('records acts, clues, doors, breakers and cutscenes idempotently', () => {
    const tracker = new NarrativeTracker();
    tracker.setAct('act2');
    tracker.addClue('story:cassette');
    tracker.addClue('story:cassette'); // duplicate must not grow the list
    tracker.openDoor('story:motel-room4');
    tracker.engageBreaker('story:breaker-diner');
    tracker.markCutscene('opening');
    const snapshot = tracker.snapshot();
    expect(snapshot.act).toBe('act2');
    expect(snapshot.clues).toEqual(['story:cassette']);
    expect(snapshot.doors).toEqual(['story:motel-room4']);
    expect(snapshot.breakers).toEqual(['story:breaker-diner']);
    expect(snapshot.cutscenes).toEqual(['opening']);
    expect(tracker.isDoorOpen('story:motel-room4')).toBe(true);
    expect(tracker.isBreakerOn('story:breaker-diner')).toBe(true);
  });

  it('validates hostile shapes without throwing', () => {
    expect(validateNarrativeState(null)).toBeNull();
    expect(validateNarrativeState('evil')).toBeNull();
    expect(validateNarrativeState({ act: 'act9' })).toBeNull();
    // Bad lists degrade to empty (never a crash); the act must still be valid.
    const partial = validateNarrativeState({ ...defaultNarrativeState(), act: 'act1', clues: 'nope', junk: true });
    expect(partial).not.toBeNull();
    expect(partial!.act).toBe('act1');
    expect(partial!.clues).toEqual([]);
    // One bad entry drops the whole list (isIdList is all-or-nothing).
    const weird = validateNarrativeState({
      act: 'act1', cutscenes: [1, null, 'ok'], clues: ['a', ''], doors: 'no', junk: true,
    });
    expect(weird).not.toBeNull();
    expect(weird!.act).toBe('act1');
    expect(weird!.cutscenes).toEqual([]);
    expect(weird!.clues).toEqual([]);
    expect(weird!.doors).toEqual([]);
  });

  it('caps every list at STORY_LIST_LIMIT', () => {
    const tracker = new NarrativeTracker();
    for (let i = 0; i < STORY_LIST_LIMIT + 20; i++) tracker.addClue(`clue-${i}`);
    const snapshot = tracker.snapshot();
    expect(snapshot.clues).toHaveLength(STORY_LIST_LIMIT);
    expect(snapshot.clues[0]).toBe('clue-0');
  });

  it('restores from a validated snapshot and falls back to defaults', () => {
    const tracker = new NarrativeTracker();
    const snapshot = { ...defaultNarrativeState(), act: 'act3' as const, clues: ['story:audio-log-1'] };
    tracker.restore(JSON.parse(JSON.stringify(snapshot)));
    expect(tracker.snapshot().act).toBe('act3');
    tracker.restore({ act: 'nonsense', clues: 42 });
    expect(tracker.snapshot()).toEqual(defaultNarrativeState());
  });
});
