import type { QualityName } from '../config';
import type { EntityKind, EntityId } from './entity';

/**
 * Signed event catalogue for the whole game. Systems publish facts here instead
 * of calling each other, so later phases (missions, dialogue, audio, UI) can
 * subscribe without touching the simulation code.
 *
 * Later phases extend this map through declaration merging, e.g.
 * `declare module '../game/events' { interface GameEventMap { 'mission:started': ... } }`
 * — no change to the bus or to existing publishers is required.
 */
export interface GameEventMap {
  /** The first streamed world is compiled and playable. */
  'world:ready': { seed: string; backend: string; physics: boolean };
  'world:seed-changed': { seed: string };
  'world:quality-changed': { quality: QualityName };
  /** Canonical coordinates are unchanged; every render/physics pose translates. */
  'world:origin-shifted': { x: number; y: number; z: number; shifts: number };
  /** One rendered frame of simulation. */
  'world:tick': { fixedSteps: number; dt: number };

  'entity:spawned': { id: EntityId; kind: EntityKind };
  'entity:removed': { id: EntityId; kind: EntityKind };

  'physics:ready': { engine: string; version: string };
  'physics:unavailable': { message: string };
  'physics:collision': { a: number; b: number; started: boolean };
  'physics:budget-exceeded': { limit: 'bodies' | 'colliders'; count: number; cap: number };
}

export type GameEventType = keyof GameEventMap;
export type GameEventHandler<K extends GameEventType> = (payload: GameEventMap[K]) => void;
export interface GameEventRecord<K extends GameEventType = GameEventType> {
  readonly type: K;
  readonly payload: GameEventMap[K];
  readonly at: number;
}

/** Stored handlers are untyped at the boundary; `on`/`once` enforce the payload. */
type StoredHandler = (payload: never) => void;

/**
 * Small typed synchronous bus. Dispatch copies the listener set so a handler may
 * subscribe or unsubscribe while an event is in flight. Handler failures are
 * reported through `onError` and never abort the remaining listeners.
 */
export class EventBus {
  private readonly listeners = new Map<GameEventType, Set<StoredHandler>>();
  private readonly recent: GameEventRecord[] = [];
  onError?: (error: unknown, type: GameEventType) => void;

  constructor(private readonly historyLimit = 64) {}

  on<K extends GameEventType>(type: K, handler: GameEventHandler<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as StoredHandler);
    return () => this.off(type, handler);
  }

  once<K extends GameEventType>(type: K, handler: GameEventHandler<K>): () => void {
    const unsubscribe = this.on(type, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  off<K extends GameEventType>(type: K, handler: GameEventHandler<K>): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(handler as StoredHandler);
    if (set.size === 0) this.listeners.delete(type);
  }

  emit<K extends GameEventType>(type: K, payload: GameEventMap[K]): void {
    this.record(type, payload);
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        (handler as unknown as GameEventHandler<K>)(payload);
      } catch (error) {
        if (this.onError) this.onError(error, type);
        else console.error(`[Wayfarer events] handler for "${type}" failed`, error);
      }
    }
  }

  /** Recent events, oldest first. Bounded so long sessions cannot grow memory. */
  history(limit = this.historyLimit): readonly GameEventRecord[] {
    return limit >= this.recent.length ? [...this.recent] : this.recent.slice(-limit);
  }

  listenerCount(type?: GameEventType): number {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  clear(): void {
    this.listeners.clear();
    this.recent.length = 0;
  }

  private record(type: GameEventType, payload: unknown): void {
    if (this.historyLimit <= 0) return;
    this.recent.push({ type, payload, at: Date.now() } as GameEventRecord);
    if (this.recent.length > this.historyLimit) this.recent.shift();
  }
}
