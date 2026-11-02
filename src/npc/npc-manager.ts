import { Group } from 'three/webgpu';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import type { WorldPoint } from '../core/coordinates';
import { SIMULATION_BACKGROUND, SIMULATION_FULL, SIMULATION_DORMANT, SIMULATION_REDUCED } from '../game/entity';
import type { SimulationLevel } from '../game/entity';
import type { GameEventBus } from '../core/events';
import type { InteractionManager } from '../interaction/manager';
import type { WorldQueries } from '../world/world-queries';
import type { WaterQuery } from '../character/locomotion';
import { NavField } from './navigation';
import type { NavigationBlockers, NavigationService } from './navigation';
import { NpcGroundSampler } from './npc-sampler';
import type { NpcTerrainSource } from './npc-sampler';
import { definitionFor } from './npc-definitions';
import { npcCellKey, npcCellsAround, planNpcCell } from './npc-placement';
import { NpcInstance } from './npc-instance';
import { NpcVisualPool } from './npc-visual';
import { ACTIVITY_LABELS } from './schedule';
import { buildDialogueContext, DialogueSession } from './dialogue';
import type { DialogueLine } from './dialogue';
import { NPC_SAVE_LIMIT } from '../persistence/npc-store';
import type { ConversationView, NpcRecord, NpcSnapshot, NpcStats, PersistedNpcs, PlacedNpc } from './types';

export interface NpcManagerOptions {
  readonly seed: string;
  readonly queries: WorldQueries;
  readonly events: GameEventBus;
  readonly interaction: InteractionManager;
  readonly quality: QualityName;
  /** Structural slice of the terrain manager for mesh-accurate footing. */
  readonly terrain?: NpcTerrainSource;
  /** Solid world geometry NPCs must walk around (objects, buildings, vehicles). */
  readonly blockers?: NavigationBlockers;
  /** World clock in hours, 0..24. */
  readonly time: () => number;
  readonly notify: (message: string) => void;
  readonly savedState?: PersistedNpcs;
  readonly water?: WaterQuery;
  readonly budget?: number;
  readonly rigBudget?: number;
}

/**
 * Streaming owner for the NPC population.
 *
 * Responsibilities: deterministic per-cell planning, nearest-first streaming
 * inside a budget, simulation-level assignment with hysteresis, pooled visuals,
 * fixed-step simulation, the bounded pathfinding budget, conversations and the
 * NPC persistence diff. It reads the shared world queries and never writes
 * terrain, vegetation, roads or objects.
 *
 * Ordering (per frame):
 *   `update`  — streaming tick, distance checks, render pose from canonical data
 *   `fixedUpdate` — separation, brain/motion at the assigned fidelity, then A*
 * Both are driven by the game loop that already owns the fixed clock, so NPC
 * simulation never depends on frame rate.
 */
export class NpcManager {
  readonly group = new Group();
  readonly navigation: NavigationService;
  readonly ground: NpcGroundSampler;

  private readonly active = new Map<string, NpcInstance>();
  private readonly planned = new Map<string, PlacedNpc[]>();
  /** Authored (story) NPCs kept alive across streaming, e.g. Evelyn. */
  private readonly authoredPlacements: PlacedNpc[] = [];
  private readonly saved = new Map<string, NpcRecord>();
  private readonly visuals = new NpcVisualPool();
  private readonly behaviourMemory = new Map<string, { behaviour: string; activity: string }>();
  private readonly sightMemory = new Map<string, boolean>();
  private readonly lastPosition: WorldPoint = { x: Infinity, y: Infinity, z: Infinity };
  private readonly renderOrigin: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly options: NpcManagerOptions;

  private elapsed: number = CONFIG.npc.updateInterval;
  private enabled = true;
  private disposed = false;
  private truncated = false;
  private cells = 0;
  private searchTokens = 1;
  private searchCount = 0;
  private budget: number;
  private rigBudget: number;
  private conversation: DialogueSession | null = null;
  private conversationNpc: NpcInstance | null = null;

  constructor(options: NpcManagerOptions) {
    this.options = options;
    this.group.name = 'Phase 8 / NPC population';
    this.budget = options.budget ?? QUALITY[options.quality].npcBudget;
    this.rigBudget = options.rigBudget ?? QUALITY[options.quality].npcRigs;
    this.ground = new NpcGroundSampler(options.queries, options.blockers, options.terrain);
    this.navigation = new NavField(options.queries, {}, options.blockers);
    for (const [id, record] of Object.entries(options.savedState ?? {})) this.saved.set(id, { ...record });
  }

  get isEnabled(): boolean { return this.enabled; }
  get activeCount(): number { return this.active.size; }
  get conversationView(): ConversationView | null {
    const session = this.conversation;
    if (!session) return null;
    return {
      npcId: session.npcId,
      npcLabel: session.npcLabel,
      topics: session.topicList.map((topic) => ({ id: topic.id, label: topic.label })),
      line: session.line?.text ?? null,
    };
  }

  setQuality(quality: QualityName): void {
    this.budget = QUALITY[quality].npcBudget;
    this.rigBudget = QUALITY[quality].npcRigs;
    this.elapsed = CONFIG.npc.updateInterval;
    this.lastPosition.x = Infinity;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.group.visible = enabled;
    if (!enabled) {
      this.endConversation('player');
      for (const id of [...this.active.keys()]) this.destroy(id);
      this.planned.clear();
      this.behaviourMemory.clear();
      this.sightMemory.clear();
    } else {
      this.elapsed = CONFIG.npc.updateInterval;
      this.lastPosition.x = Infinity;
    }
  }

  /* ---- frame update ------------------------------------------------------ */

  update(dt: number, player: WorldPoint, origin: WorldPoint, alpha: number): void {
    if (this.disposed || !this.enabled) return;
    this.renderOrigin.x = origin.x; this.renderOrigin.y = origin.y; this.renderOrigin.z = origin.z;
    this.elapsed += dt;
    const moved = Math.hypot(player.x - this.lastPosition.x, player.z - this.lastPosition.z) > CONFIG.npc.cellSize * 0.4;
    if (this.elapsed >= CONFIG.npc.updateInterval || moved) {
      this.elapsed = 0;
      this.lastPosition.x = player.x; this.lastPosition.y = player.y; this.lastPosition.z = player.z;
      this.stream(player);
    }
    if (this.conversation && this.conversationNpc) {
      if (this.conversationNpc.distanceToPlayer > CONFIG.npc.talkBreakDistance) this.endConversation('distance');
    }
    for (const npc of this.active.values()) npc.render(dt, alpha, this.renderOrigin);
  }

  /** Fixed-step simulation: separation, thinking, then the bounded A* budget. */
  fixedUpdate(dt: number, player: WorldPoint): void {
    if (this.disposed || !this.enabled) return;
    const hour = this.options.time();
    const instances = [...this.active.values()];
    const reducedInterval = 1 / CONFIG.npc.reducedHz;
    this.searchTokens = Math.min(3, this.searchTokens + dt * CONFIG.npc.navigation.searchesPerSecond);

    for (const npc of instances) {
      const neighbours = this.separationFor(npc, instances);
      const seenBefore = this.sightMemory.get(npc.id) ?? false;
      if (npc.level === SIMULATION_FULL) {
        npc.think(dt, hour, player, neighbours.x, neighbours.z);
      } else if (npc.level === SIMULATION_REDUCED) {
        npc.reducedAccumulator = (npc.reducedAccumulator ?? 0) + dt;
        if (npc.reducedAccumulator >= reducedInterval) {
          npc.think(npc.reducedAccumulator, hour, player, neighbours.x, neighbours.z);
          npc.reducedAccumulator = 0;
        }
      } else if (npc.level === SIMULATION_BACKGROUND) {
        npc.reducedAccumulator = (npc.reducedAccumulator ?? 0) + dt;
        if (npc.reducedAccumulator >= 1) {
          npc.idleThink(npc.reducedAccumulator, hour, player);
          npc.reducedAccumulator = 0;
        }
      }
      this.trackReactions(npc, seenBefore);
    }

    // Pathfinding is a shared, rate-limited resource: nearest NPCs first.
    if (this.searchTokens >= 1) {
      const ordered = instances
        .filter((npc) => npc.needsPath)
        .sort((a, b) => a.distanceToPlayer - b.distanceToPlayer);
      for (const npc of ordered) {
        if (this.searchTokens < 1) break;
        this.searchTokens -= 1;
        this.searchCount += 1;
        npc.searchPath();
      }
    }
  }

  /** Reposition every visual immediately after a floating-origin rebase. */
  rebase(origin: WorldPoint): void {
    this.renderOrigin.x = origin.x; this.renderOrigin.y = origin.y; this.renderOrigin.z = origin.z;
    for (const npc of this.active.values()) npc.render(0, 1, this.renderOrigin);
  }

  /* ---- conversations ----------------------------------------------------- */

  /** Open (or close) a conversation from the interaction action. */
  requestTalk(npc: NpcInstance): void {
    if (!this.enabled) return;
    if (this.conversation?.npcId === npc.id) { this.endConversation('player'); return; }
    if (this.conversation) this.endConversation('player');
    npc.setTalking(true);
    this.conversationNpc = npc;
    this.conversation = new DialogueSession(
      npc.id,
      npc.targetLabel,
      () => buildDialogueContext(this.options.queries, npc.position, this.options.time(), npc.targetLabel, ACTIVITY_LABELS[npc.activity]),
    );
    this.options.events.emit('npc:talkStarted', { id: npc.id, label: npc.targetLabel });
    this.options.notify(`${npc.targetLabel} turns towards you — 1–4 reply, Esc steps back`);
  }

  /** Start (or end) a conversation with a streamed NPC by id. */
  talkTo(id: string): boolean {
    const npc = this.active.get(id);
    if (!npc) return false;
    this.requestTalk(npc);
    return true;
  }

  /** Select a reply (0-based) in the open conversation. */
  selectTopic(index: number): DialogueLine | null {
    const session = this.conversation;
    if (!session) return null;
    const line = session.select(index);
    if (!line) return null;
    this.options.events.emit('npc:topicSelected', { id: session.npcId, topic: line.topicId, line: line.text });
    if (line.closing) this.endConversation('player');
    return line;
  }

  endConversation(reason: 'player' | 'distance' | 'timeout'): void {
    const session = this.conversation;
    if (!session) return;
    this.conversationNpc?.setTalking(false);
    this.options.events.emit('npc:talkEnded', { id: session.npcId, reason });
    this.conversation = null;
    this.conversationNpc = null;
  }

  /* ---- persistence ------------------------------------------------------- */

  /** Only changed NPCs plus previously stored records of unstreamed NPCs. */
  serializeState(): PersistedNpcs {
    const out: PersistedNpcs = {};
    for (const [id, record] of this.saved) out[id] = record;
    for (const npc of this.active.values()) {
      if (!npc.isChanged) { delete out[npc.id]; continue; }
      out[npc.id] = npc.toRecord();
    }
    const entries = Object.entries(out);
    if (entries.length <= NPC_SAVE_LIMIT) return out;
    // Deterministic truncation: keep the most recently touched ids.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.slice(0, NPC_SAVE_LIMIT));
  }

  restoreState(records: PersistedNpcs): void {
    this.saved.clear();
    for (const [id, record] of Object.entries(records)) this.saved.set(id, { ...record });
    for (const npc of this.active.values()) {
      const record = this.saved.get(npc.id);
      if (record) npc.applyRecord(record);
    }
    this.elapsed = CONFIG.npc.updateInterval;
    this.lastPosition.x = Infinity;
  }

  reset(seed: string, records: PersistedNpcs = {}): void {
    this.endConversation('player');
    for (const id of [...this.active.keys()]) this.destroy(id);
    this.planned.clear();
    this.behaviourMemory.clear();
    this.sightMemory.clear();
    this.saved.clear();
    for (const [id, record] of Object.entries(records)) this.saved.set(id, { ...record });
    this.elapsed = CONFIG.npc.updateInterval;
    this.lastPosition.x = Infinity;
    this.searchCount = 0;
    this.options.events.emit('world:npcReset', { seed });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endConversation('player');
    for (const id of [...this.active.keys()]) this.destroy(id);
    this.planned.clear();
    this.behaviourMemory.clear();
    this.sightMemory.clear();
    this.visuals.dispose();
    this.saved.clear();
    this.group.removeFromParent();
  }

  /* ---- diagnostics ------------------------------------------------------- */

  nearest(player: WorldPoint): NpcSnapshot | undefined {
    let best: NpcInstance | undefined;
    let bestDistance = Infinity;
    for (const npc of this.active.values()) {
      const distance = Math.hypot(npc.position.x - player.x, npc.position.z - player.z);
      if (distance < bestDistance) { bestDistance = distance; best = npc; }
    }
    return best ? this.snapshot(best, bestDistance) : undefined;
  }

  list(): NpcSnapshot[] {
    return [...this.active.values()].map((npc) => this.snapshot(npc, npc.distanceToPlayer));
  }

  get stats(): NpcStats {
    let full = 0, reduced = 0, background = 0, rigs = 0, talked = 0;
    for (const npc of this.active.values()) {
      if (npc.level === SIMULATION_FULL) full += 1;
      else if (npc.level === SIMULATION_REDUCED) reduced += 1;
      else background += 1;
      if (npc.visual?.rigged) rigs += 1;
      if (npc.talked) talked += 1;
    }
    const nearest = this.nearest(this.lastPosition);
    return {
      active: this.active.size,
      full, reduced, background,
      rigs, rigCapacity: this.rigBudget,
      cells: this.cells,
      truncated: this.truncated,
      talked,
      searches: this.searchCount,
      nearest: nearest ? `${nearest.label} · ${nearest.behaviour}` : null,
    };
  }

  /* ---- internals --------------------------------------------------------- */

  /** Story campaign: pin an authored character (Evelyn) into the stream. */
  addAuthored(placement: PlacedNpc): void {
    if (this.authoredPlacements.some((entry) => entry.id === placement.id)) return;
    this.authoredPlacements.push(placement);
  }

  private stream(player: WorldPoint): void {
    const cells = npcCellsAround(player.x, player.z, CONFIG.npc.loadRadius);
    this.cells = cells.length;
    const wanted: PlacedNpc[] = [];
    let planningBudget = 4;
    for (const cell of cells) {
      const key = npcCellKey(cell.cellX, cell.cellZ);
      let planned = this.planned.get(key);
      if (!planned) {
        if (planningBudget <= 0) continue;
        planningBudget -= 1;
        planned = planNpcCell(cell.cellX, cell.cellZ, { seed: this.options.seed, queries: this.options.queries });
        if (this.planned.size >= 128) {
          const oldest = this.planned.keys().next();
          if (!oldest.done) this.planned.delete(oldest.value);
        }
        this.planned.set(key, planned);
      }
      for (const placement of planned) wanted.push(placement);
    }
    for (const placement of this.authoredPlacements) wanted.push(placement);

    const distanceOf = (placement: PlacedNpc) => Math.hypot(placement.x - player.x, placement.z - player.z);
    wanted.sort((a, b) => distanceOf(a) - distanceOf(b));
    this.truncated = wanted.length > this.budget;

    const keep = new Set<string>();
    for (const placement of wanted) {
      if (keep.size >= this.budget) break;
      if (distanceOf(placement) > CONFIG.npc.streamDistance) continue;
      keep.add(placement.id);
      if (!this.active.has(placement.id)) this.spawn(placement);
    }
    for (const id of [...this.active.keys()]) if (!keep.has(id)) this.destroy(id);

    // Levels and visuals are re-evaluated nearest-first every streaming tick.
    const ordered = [...this.active.values()];
    for (const npc of ordered) npc.measureDistance(player);
    ordered.sort((a, b) => a.distanceToPlayer - b.distanceToPlayer);
    let rigsLeft = this.rigBudget;
    for (const npc of ordered) {
      const distance = npc.distanceToPlayer;
      npc.level = this.levelFor(npc, distance);
      const wantRig = npc.level === SIMULATION_FULL && rigsLeft > 0;
      if (npc.level === SIMULATION_FULL && wantRig) rigsLeft -= 1;
      this.assignVisual(npc, npc.level === SIMULATION_BACKGROUND ? SIMULATION_DORMANT : wantRig ? SIMULATION_FULL : SIMULATION_REDUCED);
    }
  }

  /** Distance bands with hysteresis so an NPC on an edge does not thrash. */
  private levelFor(npc: NpcInstance, distance: number): SimulationLevel {
    const { fullDistance, reducedDistance, levelHysteresis: h } = CONFIG.npc;
    switch (npc.level) {
      case SIMULATION_FULL:
        if (distance <= fullDistance + h) return SIMULATION_FULL;
        if (distance <= reducedDistance + h) return SIMULATION_REDUCED;
        return SIMULATION_BACKGROUND;
      case SIMULATION_REDUCED:
        if (distance <= fullDistance - h * 0.5) return SIMULATION_FULL;
        if (distance <= reducedDistance + h) return SIMULATION_REDUCED;
        return SIMULATION_BACKGROUND;
      case SIMULATION_BACKGROUND:
        if (distance <= fullDistance - h) return SIMULATION_FULL;
        if (distance <= reducedDistance - h * 0.5) return SIMULATION_REDUCED;
        return SIMULATION_BACKGROUND;
      default:
        if (distance <= fullDistance) return SIMULATION_FULL;
        if (distance <= reducedDistance) return SIMULATION_REDUCED;
        return SIMULATION_BACKGROUND;
    }
  }

  /** `visualLevel` is FULL for a rigged body, REDUCED for the proxy, DORMANT for none. */
  private assignVisual(npc: NpcInstance, visualLevel: SimulationLevel): void {
    const current = npc.visual;
    const wantsRig = visualLevel === SIMULATION_FULL;
    const wantsAny = visualLevel !== SIMULATION_DORMANT;
    if (!wantsAny) {
      if (current) { this.visuals.release(current); npc.visual = undefined; }
      return;
    }
    if (current && current.rigged === wantsRig) return;
    if (current) { this.visuals.release(current); npc.visual = undefined; }
    const visual = this.visuals.acquire(npc.definition, wantsRig, npc.id);
    npc.visual = visual;
    this.group.add(visual.root);
  }

  private spawn(placement: PlacedNpc): void {
    const definition = definitionFor(placement.role);
    const npc = new NpcInstance({
      placed: placement,
      definition,
      queries: this.options.queries,
      navigation: this.navigation,
      ground: this.ground,
      water: this.options.water,
      requestTalk: (target) => this.requestTalk(target),
      requestRemove: (target) => this.destroy(target.id),
    });
    const record = this.saved.get(placement.id);
    if (record) npc.applyRecord(record);
    this.active.set(placement.id, npc);
    this.options.interaction.register(npc);
    this.behaviourMemory.set(npc.id, { behaviour: npc.behaviour, activity: npc.activity });
    this.sightMemory.set(npc.id, false);
    this.options.events.emit('npc:spawned', { id: npc.id, role: npc.role, level: 'full' });
  }

  private destroy(id: string): void {
    const npc = this.active.get(id);
    if (!npc) return;
    if (this.conversation?.npcId === id) this.endConversation('player');
    this.active.delete(id);
    this.options.interaction.unregister(id);
    if (npc.visual) this.visuals.release(npc.visual);
    npc.visual = undefined;
    if (npc.isChanged) this.saved.set(id, npc.toRecord());
    else this.saved.delete(id);
    npc.dispose();
    this.behaviourMemory.delete(id);
    this.sightMemory.delete(id);
    this.options.events.emit('npc:despawned', { id, role: npc.role });
  }

  private separationFor(npc: NpcInstance, instances: readonly NpcInstance[]): { x: number; z: number } {
    let x = 0, z = 0;
    for (const other of instances) {
      if (other === npc) continue;
      const dx = npc.position.x - other.position.x;
      const dz = npc.position.z - other.position.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > 1.5 * 1.5 || distanceSq < 1e-6) continue;
      const weight = 1 - Math.sqrt(distanceSq) / 1.5;
      x += (dx / Math.sqrt(distanceSq)) * weight;
      z += (dz / Math.sqrt(distanceSq)) * weight;
    }
    const length = Math.hypot(x, z);
    if (length < 1e-4) return { x: 0, z: 0 };
    return { x: x / length, z: z / length };
  }

  /** Publish behaviour, sighting and state events; never spams per tick. */
  private trackReactions(npc: NpcInstance, seenBefore: boolean): void {
    const memory = this.behaviourMemory.get(npc.id);
    if (!memory || memory.behaviour !== npc.behaviour || memory.activity !== npc.activity) {
      this.behaviourMemory.set(npc.id, { behaviour: npc.behaviour, activity: npc.activity });
      this.options.events.emit('npc:behaviourChanged', {
        id: npc.id, behaviour: npc.behaviour, activity: npc.activity,
      });
    }
    const sees = npc.perception.seesPlayer;
    if (sees !== seenBefore) {
      this.sightMemory.set(npc.id, sees);
      if (sees) this.options.events.emit('npc:detectedPlayer', { id: npc.id, distance: npc.distanceToPlayer });
      else this.options.events.emit('npc:playerLost', { id: npc.id });
    }
  }

  private snapshot(npc: NpcInstance, distance: number): NpcSnapshot {
    return {
      id: npc.id, role: npc.role, label: npc.targetLabel,
      x: npc.position.x, y: npc.position.y, z: npc.position.z,
      yaw: npc.yaw, behaviour: npc.behaviour, activity: npc.activity,
      level: npc.level, animation: npc.animation, speed: npc.walkSpeed,
      distance, talking: npc.talking, talked: npc.talked,
      rigged: npc.visual?.rigged === true,
    };
  }
}
