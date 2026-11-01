import type { WorldPoint } from '../core/coordinates';
import type { WorldQueries } from '../world/world-queries';

/**
 * Generic conversation hooks.
 *
 * There is deliberately **no story, no quest and no authored dialogue** here.
 * A conversation is an interface: a list of functional topics whose answers are
 * composed from live world data (biome, surface, grade, distance to the road,
 * current activity). Phase 11 can mount a dialogue graph and mission content on
 * top without changing the interaction, event or UI contracts.
 */

export const DIALOGUE_TOPIC_IDS = ['conditions', 'directions', 'activity', 'farewell'] as const;
export type DialogueTopicId = typeof DIALOGUE_TOPIC_IDS[number];

export interface DialogueTopic {
  readonly id: DialogueTopicId;
  readonly label: string;
  readonly kind: 'info' | 'close';
}

export const DIALOGUE_TOPICS: readonly DialogueTopic[] = [
  { id: 'conditions', label: 'Local conditions', kind: 'info' },
  { id: 'directions', label: 'Directions', kind: 'info' },
  { id: 'activity', label: 'What are you doing?', kind: 'info' },
  { id: 'farewell', label: 'End conversation', kind: 'close' },
];

/** Everything an answer may read. All values come from live simulation state. */
export interface DialogueContext {
  readonly biome: string;
  readonly surface: string;
  readonly slopeDegrees: number;
  readonly roadDistance: number;
  readonly compass: string;
  readonly activity: string;
  readonly roleLabel: string;
  readonly hourLabel: string;
}

export interface DialogueLine {
  readonly topicId: DialogueTopicId;
  readonly text: string;
  readonly closing: boolean;
}

/** Build the data snapshot a conversation answers from. */
export function buildDialogueContext(
  queries: WorldQueries,
  position: WorldPoint,
  hour: number,
  roleLabel: string,
  activity: string,
): DialogueContext {
  const ground = queries.ground(position.x, position.z);
  const road = queries.nearestRoadPoint(position.x, position.z);
  const dx = road.x - position.x, dz = road.z - position.z;
  const distance = Math.hypot(dx, dz);
  return {
    biome: biomeLabel(ground.biome),
    surface: ground.surface,
    slopeDegrees: Math.round(Math.atan(ground.slope) * (180 / Math.PI)),
    roadDistance: Math.round(distance),
    compass: compassLabel(dx, dz),
    activity,
    roleLabel,
    hourLabel: `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`,
  };
}

/**
 * Compose a functional answer. These read as observations, not as plot: the
 * text is a rendering of numbers the simulation already computed.
 */
export function composeDialogueLine(topic: DialogueTopicId, context: DialogueContext): DialogueLine {
  switch (topic) {
    case 'conditions':
      return {
        topicId: topic, closing: false,
        text: `${context.biome} · ${context.surface} underfoot · grade ${context.slopeDegrees}°`,
      };
    case 'directions':
      return {
        topicId: topic, closing: false,
        text: `Nearest carriageway ${context.roadDistance} m ${context.compass}.`,
      };
    case 'activity':
      return {
        topicId: topic, closing: false,
        text: `${context.roleLabel} · ${context.activity} · ${context.hourLabel}`,
      };
    case 'farewell':
      return { topicId: topic, closing: true, text: 'Conversation ended.' };
  }
}

export const COMPASS_POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** Compass label for a world-space delta, with -Z as north (matches the HUD). */
export function compassLabel(dx: number, dz: number): string {
  const degrees = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const index = Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
  return COMPASS_POINTS[index]!;
}

const BIOME_LABELS = ['Valley meadows', 'Conifer highlands', 'Golden steppe', 'Alpine tundra', 'Snowline peaks'] as const;

function biomeLabel(biome: number): string {
  return BIOME_LABELS[biome] ?? 'Open country';
}

/**
 * One open conversation. The session owns the topic cursor and the closing rule;
 * the UI owns presentation and the game owns the events.
 */
export class DialogueSession {
  private closed = false;
  private lastLine: DialogueLine | null = null;

  constructor(
    readonly npcId: string,
    readonly npcLabel: string,
    private readonly context: () => DialogueContext,
    private readonly topics: readonly DialogueTopic[] = DIALOGUE_TOPICS,
  ) {}

  get open(): boolean { return !this.closed; }
  get topicList(): readonly DialogueTopic[] { return this.topics; }
  get line(): DialogueLine | null { return this.lastLine; }

  /** Select a topic by index (0-based). Returns null when unavailable or closed. */
  select(index: number): DialogueLine | null {
    if (this.closed) return null;
    const topic = this.topics[index];
    if (!topic) return null;
    const line = composeDialogueLine(topic.id, this.context());
    this.lastLine = line;
    if (line.closing) this.closed = true;
    return line;
  }

  selectById(id: DialogueTopicId): DialogueLine | null {
    const index = this.topics.findIndex((topic) => topic.id === id);
    return index < 0 ? null : this.select(index);
  }

  end(): void { this.closed = true; }
}
