import { describe, expect, it } from 'vitest';
import { STORY_PROPS } from '../src/story/content';
import { STORY_MISSION_DEFS } from '../src/story/mission-content';
import { EVELYN_TREE, StoryDialogueRunner } from '../src/story/dialogue';
import { ITEM_DEFINITIONS } from '../src/objects/items';
import { validateGameSave } from '../src/persistence/game-save';
import { OBJECT_SAVE_FORMAT } from '../src/persistence/object-store';
import { CAMPAIGN } from '../src/story/campaign';

/**
 * Content contract: the ids the missions listen for must exist as authored
 * props (or dialogue/vehicle events), and the save slice must round-trip.
 */
describe('story content ↔ mission contract', () => {
  const propIds = new Set(STORY_PROPS.map((prop) => prop.id));

  it('exposes exactly the fourteen authored props with unique ids', () => {
    expect(STORY_PROPS).toHaveLength(14);
    expect(propIds.size).toBe(STORY_PROPS.length);
    for (const prop of STORY_PROPS) {
      expect(prop.id.startsWith('story:')).toBe(true);
      expect(prop.label.length).toBeGreaterThan(0);
      expect(Number.isFinite(prop.point.x)).toBe(true);
      expect(Number.isFinite(prop.point.z)).toBe(true);
      if (prop.clue) {
        expect(prop.clue.title.length).toBeGreaterThan(0);
        expect(prop.clue.body.length).toBeGreaterThan(30);
      }
      if (prop.grants) expect(ITEM_DEFINITIONS[prop.grants]).toBeTruthy();
      if (prop.requires) expect(ITEM_DEFINITIONS[prop.requires]).toBeTruthy();
    }
  });

  it('matches every object:interacted mission objective against a real prop id', () => {
    const referenced = new Set<string>();
    for (const def of STORY_MISSION_DEFS) {
      for (const objective of def.objectives) {
        if (objective.kind !== 'event' || objective.event !== 'object:interacted') continue;
        const matchId = objective.match?.id;
        if (typeof matchId === 'string') referenced.add(matchId);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) expect(propIds.has(id), `missing prop for ${id}`).toBe(true);
  });

  it('supplies every flag objective from a prop, dialogue or authored vehicle beat', () => {
    const propFlags = new Set(STORY_PROPS.map((prop) => prop.flag).filter(Boolean));
    // evelyn_keycard arrives through Evelyn's dialogue tree; evaded_patrol is
    // granted by StoryGame when the Act II terminal is reached unseen.
    propFlags.add('evelyn_keycard');
    propFlags.add('evaded_patrol');
    for (const def of STORY_MISSION_DEFS) {
      for (const objective of def.objectives) {
        if (objective.kind !== 'flag') continue;
        expect(propFlags.has(objective.flag), `no source for flag ${objective.flag}`).toBe(true);
      }
    }
    // Vehicle beats target the authored truck catalogue key.
    const truckObjective = STORY_MISSION_DEFS
      .flatMap((def) => def.objectives)
      .find((objective) => objective.kind === 'event' && objective.event === 'vehicle:entered' && objective.id === 'truck');
    expect(truckObjective).toBeTruthy();
  });

  it('ships the story inventory items in the item catalogue', () => {
    expect(ITEM_DEFINITIONS['service-keys'].label).toContain('ignition');
    expect(ITEM_DEFINITIONS['forestry-keycard'].category).toBe('collectible');
    expect(ITEM_DEFINITIONS['truck-keys'].maxStack).toBe(1);
  });
});

describe('Evelyn dialogue tree', () => {
  function run(hasFlag: (flag: string) => boolean) {
    const runner = new StoryDialogueRunner();
    const flags: string[] = [];
    const items: string[] = [];
    const node = runner.begin(EVELYN_TREE, hasFlag);
    const choose = (index: number) => runner.choose(index, {
      onFlag: (flag) => flags.push(flag),
      onItem: (item) => items.push(item),
    });
    return { runner, node, choose, flags, items };
  }

  it('opens on the intro and walks the keycard branch end-to-end', () => {
    const { node, choose, flags, items } = run(() => false);
    expect(node.id).toBe('intro');
    expect(choose(0)?.id).toBe('whatHappened');
    expect(choose(1)?.id).toBe('keycard'); // "How do I get in?"
    const after = choose(0); // hand over the keycard
    expect(after?.id).toBe('thanks');
    expect(items).toEqual(['forestry-keycard']);
    expect(flags).toEqual(['evelyn_keycard']);
    expect(choose(0)).toBeNull(); // "I'll be back before dawn." ends it
  });

  it('routes revisits to the short node once the keycard flag is set', () => {
    const { node, choose } = run((flag) => flag === 'evelyn_keycard');
    expect(node.id).toBe('revisit');
    expect(choose(0)).toBeNull();
  });

  it('rejects out-of-range choices without corrupting state', () => {
    const { node, choose } = run(() => false);
    expect(choose(9)).toBeNull();
    expect(run(() => false).node.id).toBe('intro');
    expect(node.id).toBe('intro');
  });
});

describe('save snapshot story slice', () => {
  const objects = {
    format: OBJECT_SAVE_FORMAT, version: 1, seed: CAMPAIGN.seed, savedAt: 1,
    objects: {}, inventory: [],
  };
  const base = {
    format: 'wayfarer.game', version: 2, savedAt: Date.now(), seed: CAMPAIGN.seed,
    player: { x: CAMPAIGN.arrival.x, z: CAMPAIGN.arrival.z, yaw: 0.5 },
    hour: 21.25, cycling: false, weather: 'fog',
    objectives: { flags: {}, started: ['p_power'], completed: ['p_shelter'], counts: {} },
    discovery: { cells: [], waypoint: null },
    objects,
  };

  it('round-trips a valid story slice', () => {
    const story = {
      act: 'act2', cutscenes: ['opening'], clues: ['story:cassette'],
      doors: ['story:motel-room4'], breakers: ['story:breaker'],
    };
    const save = validateGameSave({ ...base, story });
    expect(save.story).toEqual(story);
  });

  it('accepts saves without a story block (sandbox sessions, older slots)', () => {
    const save = validateGameSave(base);
    expect(save.story).toBeUndefined();
  });

  it('drops an invalid story slice instead of failing the whole load', () => {
    const save = validateGameSave({ ...base, story: { act: 'act9', clues: 42 } });
    expect(save.story).toBeUndefined();
    const partial = validateGameSave({
      ...base,
      story: { act: 'act3', cutscenes: [null, 'revelation'], clues: ['story:audio-log-1'], doors: 'nope' },
    });
    expect(partial.story?.act).toBe('act3');
    expect(partial.story?.cutscenes).toEqual([]);
    expect(partial.story?.clues).toEqual(['story:audio-log-1']);
    expect(partial.story?.doors).toEqual([]);
  });
});
