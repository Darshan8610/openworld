import type { GameEventBus } from '../core/events';
import type { WorldQueries } from '../world/world-queries';
import type { PropPhysicsWorld } from '../physics/prop-physics';
import type { Inventory } from './inventory';
import { selectTarget, DEFAULT_TARGET_OPTIONS } from './targeting';
import type { Targetable, TargetOptions, TargetView } from './targeting';
import type {
  ActorView, InteractionAction, InteractionContext, InteractionPrompt, InteractionProvider,
} from './types';
import type { ObjectState } from '../objects/archetypes';

export interface InteractionDependencies {
  readonly inventory: Inventory;
  readonly physics: PropPhysicsWorld;
  readonly queries: WorldQueries;
  readonly events: GameEventBus;
  readonly notify: (message: string) => void;
}

export interface InteractionInput {
  /** Rising edge this fixed step. */
  readonly pressed: boolean;
  /** Held this fixed step. */
  readonly down: boolean;
}

interface ActiveInteraction {
  providerId: string;
  actionId: string;
  elapsed: number;
  executed: boolean;
}

const ACTION_COOLDOWN = 0.15;

/**
 * Context-sensitive interaction: resolves what the player is looking at,
 * selects the available action, runs hold-to-confirm timing, and publishes
 * events. It never knows what an object *is* — that lives in the archetype
 * actions — so NPCs, vehicles and buildings integrate by implementing
 * `InteractionProvider`.
 */
export class InteractionManager {
  private readonly providers = new Map<string, InteractionProvider>();
  private readonly cooldowns = new Map<string, number>();
  private active: ActiveInteraction | undefined;
  private current: { id: string; label: string } | null = null;
  private prompt: InteractionPrompt | null = null;
  private now = 0;
  private actor: ActorView = { id: 'player', position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, yaw: 0 };
  private readonly options: TargetOptions;

  constructor(private readonly deps: InteractionDependencies, options: Partial<TargetOptions> = {}) {
    this.options = { ...DEFAULT_TARGET_OPTIONS, ...options };
  }

  register(provider: InteractionProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
    if (this.active?.providerId === id) this.active = undefined;
  }

  clear(): void {
    this.providers.clear();
    this.active = undefined;
    this.prompt = null;
    this.current = null;
    this.cooldowns.clear();
  }

  get providerCount(): number { return this.providers.size; }

  /** Providers expose `targetLabel`; adapt them to the generic targeting shape. */
  private targetables(): Targetable[] {
    const list: Targetable[] = [];
    for (const provider of this.providers.values()) {
      list.push({ id: provider.id, centre: provider.centre, radius: provider.radius, range: provider.range, label: provider.targetLabel });
    }
    return list;
  }
  get targetId(): string | null { return this.prompt?.objectId ?? null; }
  get currentPrompt(): InteractionPrompt | null { return this.prompt; }
  get activeAction(): string | null { return this.active?.actionId ?? null; }

  /** Advance one fixed simulation step. */
  update(dt: number, actor: ActorView, input: InteractionInput): InteractionPrompt | null {
    this.now += dt;
    this.actor = actor;
    const view: TargetView = { eye: actor.position, forward: actor.forward };
    const hit = selectTarget(this.targetables(), view, this.options);
    const provider = hit?.target ? this.providers.get(hit.target.id) : undefined;
    if (!provider) { this.finishIfIdle(); return null; }

    const state = provider.state();
    const action = this.pickAction(provider, state);
    if (!action) { this.finishIfIdle(); return null; }

    // Target/action changed: restart any hold.
    if (this.active && (this.active.providerId !== provider.id || this.active.actionId !== action.id)) this.active = undefined;
    if (!input.down) this.active = undefined;

    const holdSeconds = action.holdSeconds ?? 0;
    if (input.down && (!this.active || !this.active.executed)) {
      const key = `${provider.id}:${action.id}`;
      const readyAt = this.cooldowns.get(key) ?? 0;
      if (this.now >= readyAt) {
        if (!this.active) this.active = { providerId: provider.id, actionId: action.id, elapsed: 0, executed: false };
        this.active.elapsed += dt;
        const execute = holdSeconds <= 0 ? input.pressed : this.active.elapsed >= holdSeconds;
        if (execute) this.execute(provider, action);
      }
    }

    this.publishTarget(provider.id, provider.targetLabel);
    const progress = this.active && this.active.providerId === provider.id && holdSeconds > 0
      ? Math.min(1, this.active.elapsed / holdSeconds)
      : 0;
    const refreshed = this.providers.get(provider.id);
    if (!refreshed) { this.prompt = null; return null; }
    const refreshedAction = this.pickAction(refreshed, refreshed.state()) ?? action;
    this.prompt = {
      objectId: refreshed.id,
      targetLabel: refreshed.targetLabel,
      actionLabel: labelOf(refreshedAction, refreshed.state()),
      key: refreshedAction.key ?? 'E',
      holdSeconds,
      progress: this.active && this.active.executed ? 1 : progress,
    };
    return this.prompt;
  }

  /** Explicit trigger for a UI button or touch tap. */
  press(actor: ActorView): boolean {
    this.actor = actor;
    const hit = selectTarget(this.targetables(), { eye: actor.position, forward: actor.forward }, this.options);
    const provider = hit ? this.providers.get(hit.target.id) : undefined;
    if (!provider) return false;
    const action = this.pickAction(provider, provider.state());
    if (!action) return false;
    const key = `${provider.id}:${action.id}`;
    if (this.now < (this.cooldowns.get(key) ?? 0)) return false;
    this.execute(provider, action);
    return true;
  }

  private execute(provider: InteractionProvider, action: InteractionAction): void {
    const key = `${provider.id}:${action.id}`;
    this.cooldowns.set(key, this.now + ACTION_COOLDOWN);
    if (this.active) this.active.executed = true;
    const context: InteractionContext = {
      objectId: provider.id,
      archetype: provider.archetype,
      state: provider.state(),
      actor: this.actor,
      now: this.now,
      inventory: this.deps.inventory,
      physics: this.deps.physics,
      queries: this.deps.queries,
      events: this.deps.events,
      setState: (patch) => provider.setState(patch),
      remove: () => provider.remove(),
      notify: this.deps.notify,
    };
    let outcome;
    try {
      outcome = action.run(context);
    } catch (error) {
      console.error(`[interaction] action "${action.id}" on "${provider.id}" failed`, error);
      this.deps.events.emit('object:interacted', {
        id: provider.id, archetype: provider.archetype.key, action: action.id, label: 'failed', actor: this.actor.id,
      });
      return;
    }
    this.deps.events.emit('object:interacted', {
      id: provider.id,
      archetype: provider.archetype.key,
      action: action.id,
      label: outcome?.message ?? labelOf(action, provider.state()),
      actor: this.actor.id,
    });
    if (outcome?.message) this.deps.notify(outcome.message);
    if (!this.providers.has(provider.id)) {
      this.active = undefined;
      this.prompt = null;
    }
  }

  private pickAction(provider: InteractionProvider, state: ObjectState): InteractionAction | undefined {
    return provider.actions().find((action) => !action.available || action.available(state, this.deps.inventory));
  }

  private publishTarget(id: string | null, label: string | null): void {
    if (this.current?.id === id) return;
    this.current = id ? { id, label: label ?? id } : null;
    this.deps.events.emit('interaction:targetChanged', { id, label });
  }

  private finishIfIdle(): void {
    this.active = undefined;
    this.prompt = null;
    this.publishTarget(null, null);
  }

  get stats() {
    return { providers: this.providers.size, targetId: this.targetId, action: this.active?.actionId ?? null, progress: this.prompt?.progress ?? 0 };
  }
}

export function labelOf(action: InteractionAction, state: ObjectState): string {
  return typeof action.label === 'function' ? action.label(state) : action.label;
}
