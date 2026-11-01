import type { ItemId } from '../objects/items';

/**
 * Authored story dialogue — branching trees with effects.
 *
 * Mounted on top of the existing conversation UI: the runner produces the
 * line + choice list the Interface dialogue panel renders, and effects write
 * conversation flags into the mission runtime (persisted) plus inventory
 * grants (Evelyn's keycard).
 */

export interface StoryChoice {
  readonly label: string;
  readonly next?: string;
  readonly flag?: string;
  readonly giveItem?: ItemId;
}

export interface StoryNode {
  readonly id: string;
  readonly line: string;
  readonly choices: readonly StoryChoice[];
}

export interface StoryTree {
  readonly id: string;
  readonly speaker: string;
  readonly start: string;
  readonly nodes: Readonly<Record<string, StoryNode>>;
  /** Node shown instead of `start` when this flag is set (e.g. after the gift). */
  readonly revisit?: { readonly flag: string; readonly start: string };
}

/**
 * Evelyn — the survivor barricaded in Room Four. Terrified, pragmatic, and
 * the one living person who hands Jack a way forward.
 */
export const EVELYN_TREE: StoryTree = {
  id: 'evelyn-room4',
  speaker: 'Evelyn',
  start: 'intro',
  revisit: { flag: 'evelyn_keycard', start: 'revisit' },
  nodes: {
    intro: {
      id: 'intro',
      line: 'Don\u2019t come in! Who \u2014 who is out there? ...You\u2019re not one of them. You\u2019re not one of the voices.',
      choices: [
        { label: 'Jack Mercer, journalist. What happened to this town?', next: 'whatHappened' },
        { label: 'The siren. Everyone is gone.', next: 'siren' },
        { label: 'I\u2019ll come back. Stay behind the door.', next: 'leave' },
      ],
    },
    whatHappened: {
      id: 'whatHappened',
      line: 'Blackout first. Then the radio tower started humming \u2014 a note you feel in your teeth. Folks gathered at the Forestry Station for the siren. Something followed them back. It wears their voices.',
      choices: [
        { label: 'Why not open the door?', next: 'door' },
        { label: 'The Station. How do I get in?', next: 'keycard' },
        { label: 'I\u2019ll come back. Stay behind the door.', next: 'leave' },
      ],
    },
    siren: {
      id: 'siren',
      line: 'The all-clear that never cleared anything. I watched the road from this window. People walked toward the Station lights, and after that... the ones who talked on the radio didn\u2019t breathe right.',
      choices: [
        { label: 'I need into the Forestry Station.', next: 'keycard' },
        { label: 'Keep your door shut. I\u2019ll find the others.', next: 'leave' },
      ],
    },
    door: {
      id: 'door',
      line: 'Bolted, and it stays bolted. The manager\u2019s spare keycard is right here \u2014 I took it when they started knocking politely. Politely, with my mother\u2019s cadence.',
      choices: [
        { label: 'Give me the keycard. I\u2019ll check the Station.', next: 'keycard' },
        { label: 'Stay put. I\u2019ll come back.', next: 'leave' },
      ],
    },
    keycard: {
      id: 'keycard',
      line: 'Take it. Forestry gate keycard. If you get through, and whatever\u2019s on that relay is still \u2018talking\u2019 \u2014 don\u2019t answer it. Don\u2019t even say your own name out loud up there.',
      choices: [
        { label: 'Thank you, Evelyn. Lock this door.', next: 'thanks', giveItem: 'forestry-keycard', flag: 'evelyn_keycard' },
      ],
    },
    thanks: {
      id: 'thanks',
      line: 'I already have. ...Jack, was it? The road to the Station floods in this rain. Take the truck behind the pumps if the pickup won\u2019t start.',
      choices: [{ label: 'I\u2019ll be back before dawn.', next: undefined }],
    },
    revisit: {
      id: 'revisit',
      line: 'You\u2019re still breathing. Good. The voices moved toward the tree line an hour ago \u2014 maybe longer. Time doesn\u2019t sit right here.',
      choices: [
        { label: 'Rest. I\u2019ll handle it.', next: undefined },
      ],
    },
    leave: {
      id: 'leave',
      line: '...Wait. If you find my brother out there \u2014 the one who hums before he speaks \u2014 don\u2019t listen to him.',
      choices: [{ label: 'I won\u2019t. Bolt your door.', next: undefined }],
    },
  },
};

export interface DialogueEffects {
  readonly onFlag?: (flag: string) => void;
  readonly onItem?: (item: ItemId) => void;
}

/**
 * One conversation at a time. `choose` applies the choice's effects and
 * returns the next node (undefined = conversation over).
 */
export class StoryDialogueRunner {
  private tree: StoryTree | null = null;
  private node: StoryNode | null = null;

  get active(): boolean { return this.tree !== null && this.node !== null; }
  get speaker(): string | null { return this.tree?.speaker ?? null; }
  get current(): StoryNode | null { return this.node; }

  begin(tree: StoryTree, hasFlag: (flag: string) => boolean): StoryNode {
    this.tree = tree;
    const startId = tree.revisit && hasFlag(tree.revisit.flag) ? tree.revisit.start : tree.start;
    this.node = tree.nodes[startId] ?? tree.nodes[tree.start]!;
    return this.node;
  }

  choose(index: number, effects: DialogueEffects): StoryNode | null {
    const node = this.node;
    if (!node || !this.tree) return null;
    const choice = node.choices[index];
    if (!choice) return null;
    if (choice.flag) effects.onFlag?.(choice.flag);
    if (choice.giveItem) effects.onItem?.(choice.giveItem);
    if (!choice.next) { this.end(); return null; }
    const next = this.tree.nodes[choice.next];
    if (!next) { this.end(); return null; }
    this.node = next;
    return next;
  }

  end(): void {
    this.tree = null;
    this.node = null;
  }
}
