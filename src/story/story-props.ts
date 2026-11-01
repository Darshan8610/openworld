import type { InteractionAction, InteractionArchetype, InteractionContext, InteractionOutcome, InteractionProvider } from '../interaction/types';
import type { ObjectState } from '../objects/archetypes';
import type { PersistencePolicy } from '../core/entities';
import type { WorldPoint } from '../core/coordinates';
import type { ItemId } from '../objects/items';
import type { NarrativeTracker } from './narrative-state';
import type { StoryPoint } from './mission-content';

/**
 * Narrative props — the interactive clue/puzzle layer.
 *
 * Documents, cassettes, breakers, key-locked gates, terminals and the
 * capacitor bank are plain InteractionProviders, so aiming, prompts, hold
 * actions, events and persistence all reuse the tested interaction stack.
 * Mission progress arrives through the existing `object:interacted` events
 * (the ids here are the ones the authored objectives match on).
 */

export interface StoryClue {
  readonly title: string;
  readonly body: string;
  readonly kind: 'document' | 'cassette' | 'log';
}

export interface StoryPropSpec {
  /** Stable object id — mission events match on this exact string. */
  readonly id: string;
  readonly label: string;
  readonly point: StoryPoint;
  readonly kind: 'breaker' | 'clue' | 'register' | 'keydoor' | 'terminal' | 'radio' | 'capacitor' | 'keys' | 'door';
  /** Item granted by register/keys pickups. */
  readonly grants?: ItemId;
  /** Item required by keydoor kinds. */
  readonly requires?: ItemId;
  readonly clue?: StoryClue;
  /** Mission flag set when activated. */
  readonly flag?: string;
  /** Narrative door id recorded on open. */
  readonly doorId?: string;
  readonly holdSeconds?: number;
  /** Extra prompt/action label. */
  readonly verb?: string;
}

export interface StoryPropHooks {
  readonly narrative: NarrativeTracker;
  readonly showClue: (clue: StoryClue) => void;
  readonly onFlag: (flag: string) => void;
  /** Fired for 'door' props (Evelyn's Room Four) before/instead of a flag. */
  readonly onDoor?: (id: string) => void;
  readonly ground: (x: number, z: number) => number;
}

const ARCHETYPE = (spec: StoryPropSpec): InteractionArchetype => ({ key: spec.kind, label: spec.label });

class StoryProp implements InteractionProvider {
  readonly id: string;
  readonly archetype: InteractionArchetype;
  private readonly stateValue: ObjectState = {};
  private centreValue: WorldPoint;
  readonly radius = 1.1;
  readonly range = 3.2;
  readonly persistence: PersistencePolicy = 'session';

  constructor(private readonly spec: StoryPropSpec, private readonly hooks: StoryPropHooks) {
    this.id = spec.id;
    this.archetype = ARCHETYPE(spec);
    this.centreValue = { x: spec.point.x, y: hooks.ground(spec.point.x, spec.point.z) + 1.05, z: spec.point.z };
    if (spec.kind === 'keydoor' || spec.kind === 'door') this.stateValue.open = hooks.narrative.isDoorOpen(spec.id);
    if (spec.kind === 'breaker') this.stateValue.on = hooks.narrative.isBreakerOn(spec.id);
    if (spec.kind === 'clue') this.stateValue.visited = hooks.narrative.hasClue(spec.id);
  }

  get targetLabel(): string { return this.spec.label; }
  get centre(): WorldPoint { return this.centreValue; }
  state(): ObjectState { return { ...this.stateValue }; }
  setState(patch: Partial<ObjectState>): void { Object.assign(this.stateValue, patch); }
  remove(): void { /* unregistered by the system */ }

  actions(): readonly InteractionAction[] {
    const spec = this.spec;
    switch (spec.kind) {
      case 'breaker': return [{
        id: 'engage', label: 'Engage breaker', holdSeconds: 0.8,
        run: (context) => this.activate(context, { on: true }, `The ${spec.label.toLowerCase()} hums to life`),
      }];
      case 'clue': return [{
        id: 'read', label: spec.verb ?? (spec.clue?.kind === 'cassette' ? 'Play tape' : spec.clue?.kind === 'log' ? 'Play recording' : 'Read'),
        run: (context) => {
          this.stateValue.visited = true;
          if (spec.clue) this.hooks.showClue(spec.clue);
          if (spec.clue) this.hooks.narrative.addClue(spec.id);
          if (spec.flag) this.hooks.onFlag(spec.flag);
          context.events.emit('mission:flagSet', { name: `clue:${spec.id}`, value: true });
          return { message: spec.clue?.kind === 'document' ? `Read the ${spec.label.toLowerCase()}` : undefined };
        },
      }];
      case 'register': return [{
        id: 'search', label: 'Search the register', holdSeconds: 0.6,
        run: (context) => {
          if (this.stateValue.used) return { message: 'The register is empty' };
          this.stateValue.used = true;
          if (spec.grants) context.inventory.add(spec.grants, 1);
          if (spec.flag) this.hooks.onFlag(spec.flag);
          return { message: spec.grants ? 'A spare set of service ignition keys' : undefined };
        },
      }];
      case 'keys': return [{
        id: 'take', label: spec.verb ?? 'Take the keys',
        run: (context) => {
          if (this.stateValue.collected) return { message: 'Already taken' };
          this.stateValue.collected = true;
          if (spec.grants) context.inventory.add(spec.grants, 1);
          if (spec.flag) this.hooks.onFlag(spec.flag);
          return { message: 'Pocketed the keys' };
        },
      }];
      case 'keydoor': {
        const lockedLabel = `Unlock ${spec.label}`;
        return [{
          id: 'unlock', label: () => (this.stateValue.open ? `${spec.label} (open)` : lockedLabel),
          available: () => !this.stateValue.open,
          run: (context) => this.unlockDoor(context),
        }];
      }
      case 'door': return [{
        id: 'knock', label: spec.verb ?? `Knock on ${spec.label}`,
        run: (context) => {
          this.hooks.onDoor?.(spec.id);
          context.events.emit('mission:flagSet', { name: `door:${spec.id}`, value: true });
          return { message: undefined };
        },
      }];
      case 'terminal': return [{
        id: 'use', label: spec.verb ?? 'Use terminal', holdSeconds: spec.holdSeconds ?? 1.4,
        run: (context) => this.activate(context, { used: true }, 'Terminal accessed'),
      }];
      case 'radio': return [{
        id: 'listen', label: spec.verb ?? 'Monitor the relay', holdSeconds: spec.holdSeconds ?? 1.2,
        run: (_context) => {
          this.stateValue.used = true;
          if (spec.clue) { this.hooks.showClue(spec.clue); this.hooks.narrative.addClue(spec.id); }
          if (spec.flag) this.hooks.onFlag(spec.flag);
          return { message: undefined };
        },
      }];
      case 'capacitor': return [{
        id: 'overload', label: spec.verb ?? 'Overload the capacitor bank', holdSeconds: spec.holdSeconds ?? 3,
        run: (context) => this.activate(context, { on: false, used: true }, 'Capacitors venting — the broadcast is dying'),
      }];
    }
  }

  private unlockDoor(context: InteractionContext): InteractionOutcome | void {
    const spec = this.spec;
    if (spec.requires && !context.inventory.has(spec.requires)) {
      return { message: `Locked — ${labelOf(spec.requires)} required` };
    }
    this.stateValue.open = true;
    if (spec.doorId) this.hooks.narrative.openDoor(spec.doorId);
    if (spec.flag) this.hooks.onFlag(spec.flag);
    return { message: `${spec.label} unlocked` };
  }

  private activate(_context: InteractionContext, patch: ObjectState, message?: string): InteractionOutcome {
    this.setState(patch);
    if (this.spec.doorId) this.hooks.narrative.openDoor(this.spec.doorId);
    if (this.spec.flag) this.hooks.onFlag(this.spec.flag);
    return { message };
  }
}

function labelOf(id: ItemId): string { return id.replace(/-/g, ' '); }

export class StoryProps {
  private readonly providers: StoryProp[] = [];
  constructor(
    private readonly registerProvider: (provider: InteractionProvider) => void,
    private readonly unregisterProvider: (id: string) => void,
    private readonly hooks: StoryPropHooks,
  ) {}

  add(spec: StoryPropSpec): void {
    const provider = new StoryProp(spec, this.hooks);
    this.providers.push(provider);
    this.registerProvider(provider);
  }

  dispose(): void {
    for (const provider of this.providers) this.unregisterProvider(provider.id);
    this.providers.length = 0;
  }
}
