/**
 * Typed, synchronous game event bus.
 *
 * Systems talk through events instead of holding references to each other, so
 * story/mission/audio layers (Phases 11-12) can subscribe without new coupling.
 * Payloads are plain structural data: no Three.js objects, no cyclic imports.
 */
export interface GameEventMap {
  'object:spawned': { id: string; archetype: string; kind: string };
  'object:despawned': { id: string };
  'object:stateChanged': { id: string; archetype: string; state: Readonly<Record<string, unknown>> };
  'object:interacted': { id: string; archetype: string; action: string; label: string; actor: string };
  'interaction:targetChanged': { id: string | null; label: string | null };
  'item:collected': { objectId: string; itemId: string; count: number; total: number };
  'inventory:changed': { items: readonly { itemId: string; count: number }[]; total: number };
  'player:enteredWater': { x: number; y: number; z: number };
  'player:exitedWater': { x: number; y: number; z: number };
  'player:enteredBuilding': { id: string };
  'player:exitedBuilding': { id: string };
  'player:seated': { objectId: string };
  'player:stood': { objectId: string };
  'vehicle:spawned': { id: string; key: string; vehicleClass: string };
  'vehicle:despawned': { id: string };
  'vehicle:entered': { id: string; key: string; seat: string; actor: string };
  'vehicle:exited': { id: string; key: string; seat: string; actor: string; x: number; y: number; z: number };
  'vehicle:damaged': { id: string; key: string; severity: number; health: number; wrecked: boolean };
  'vehicle:recovered': { id: string; key: string };
  'vehicle:viewChanged': { id: string; view: string };
  'world:weatherChanged': { kind: string; label: string; previous: string };
  'world:waterEntered': { bodyId: string; kind: string; x: number; y: number; z: number };
  'world:waterExited': { bodyId: string; x: number; y: number; z: number };
  /** A prop rigid body crossed the waterline (splash already emitted). */
  'world:propEnteredWater': { id: string; bodyId: string; x: number; y: number; z: number; speed: number };
  'world:originRebased': { x: number; y: number; z: number; shifts: number };
  'world:objectsReset': { seed: string };
  'physics:bodySlept': { id: string };
  'physics:bodyWoke': { id: string };
  /** Phase 8 — NPC life simulation. Consumers: UI, audio (12), missions (11). */
  'npc:spawned': { id: string; role: string; level: string };
  'npc:despawned': { id: string; role: string };
  'npc:behaviourChanged': { id: string; behaviour: string; activity: string };
  'npc:detectedPlayer': { id: string; distance: number };
  'npc:playerLost': { id: string };
  'npc:talkStarted': { id: string; label: string };
  'npc:talkEnded': { id: string; reason: 'player' | 'distance' | 'timeout' };
  'npc:topicSelected': { id: string; topic: string; line: string };
  'npc:stateChanged': { id: string; role: string };
  'world:npcReset': { seed: string };
  /** Phase 11 — mission/objective infrastructure. No story content, only events. */
  'world:locationDiscovered': { x: number; z: number; cell: string };
  'mission:started': { id: string };
  'mission:objectiveCompleted': { id: string; missionId: string; label: string };
  'mission:completed': { id: string };
  'mission:flagSet': { name: string; value: boolean | number | string };
  /** Phase 11.3 — the story campaign changed act (weather/time/cutscenes). */
  'story:actChanged': { act: string };
  /** Act II patrol spotted Jack (times = streak count for this playthrough). */
  'story:spotted': { times: number };
}
export type GameEventType = keyof GameEventMap;
type Handler<K extends GameEventType> = (payload: GameEventMap[K]) => void;

interface Entry {
  readonly handler: (payload: never) => void;
  once: boolean;
}
interface HistoryEntry {
  readonly type: GameEventType;
  readonly payload: unknown;
  readonly at: number;
}

export class GameEventBus {
  private readonly handlers = new Map<GameEventType, Set<Entry>>();
  private readonly backlog: HistoryEntry[] = [];
  private readonly historyLimit: number;

  constructor(historyLimit = 64) {
    this.historyLimit = Math.max(0, historyLimit);
  }

  on<K extends GameEventType>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    const entry: Entry = { handler: handler as (payload: never) => void, once: false };
    set.add(entry);
    return () => { set!.delete(entry); };
  }

  once<K extends GameEventType>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    const entry: Entry = { handler: handler as (payload: never) => void, once: true };
    set.add(entry);
    return () => { set!.delete(entry); };
  }

  emit<K extends GameEventType>(type: K, payload: GameEventMap[K]): void {
    if (this.historyLimit > 0) {
      this.backlog.push({ type, payload, at: Date.now() });
      while (this.backlog.length > this.historyLimit) this.backlog.shift();
    }
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    // Copy: a handler may subscribe or unsubscribe while the event is dispatched.
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry);
      try {
        (entry.handler as unknown as Handler<K>)(payload);
      } catch (error) {
        // A broken listener must not take down the simulation step.
        console.error(`[events] handler for "${type}" threw`, error);
      }
    }
  }

  listenerCount(type: GameEventType): number { return this.handlers.get(type)?.size ?? 0; }
  history(): readonly HistoryEntry[] { return this.backlog; }
  clear(): void { this.handlers.clear(); this.backlog.length = 0; }
}
