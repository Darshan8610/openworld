import type { GameEventBus } from '../core/events';
import type { ObjectiveRuntime } from '../game/objectives';
import type { Discovery } from '../discovery/discovery';
import type { WeatherKind } from '../environment/weather';
import type { ActId } from './campaign';
import { act } from './campaign';
import type { NarrativeTracker } from './narrative-state';
import { STORY_MISSION_DEFS, MISSION_CHAIN, nextMissionId, storyMission, waypointForMission } from './mission-content';

/**
 * Mission Director — the narrative state machine.
 *
 * Wraps the generic ObjectiveRuntime with the authored chain: registers the
 * campaign missions, listens on the existing event bus for objective and
 * mission events, advances strictly forward, mirrors the act into narrative
 * state (saved), applies each act's weather/time preset, and keeps the
 * Discovery Chart waypoint pinned to the active mission target.
 */

export type BannerKind = 'mission' | 'objective' | 'act';

export interface MissionDirectorUi {
  missionBanner(kind: BannerKind, title: string, detail: string): void;
  toast(message: string): void;
}

export interface MissionDirectorDeps {
  readonly objectives: ObjectiveRuntime;
  readonly events: GameEventBus;
  readonly discovery: Discovery;
  readonly narrative: NarrativeTracker;
  readonly ui: MissionDirectorUi;
  readonly weather: { setOverride(kind: WeatherKind | null): void };
  readonly sky: { setHour(hour: number): void; cycling: boolean };
  /** Fired when the act actually changes (cutscenes and props listen). */
  readonly onActChange?: (act: ActId) => void;
}

export class MissionDirector {
  private readonly unsubscribers: (() => void)[] = [];
  private activeMissionId: string | null = null;
  private appliedAct: ActId | null = null;
  private began = false;

  constructor(private readonly deps: MissionDirectorDeps) {}

  /** Register content and wire the bus. Call once after ObjectiveRuntime exists. */
  register(): void {
    const rejected = this.deps.objectives.register(STORY_MISSION_DEFS);
    if (rejected.length > 0) console.warn('[story] rejected mission defs', rejected);
    this.unsubscribers.push(this.deps.events.on('mission:started', ({ id }) => this.onMissionStarted(id)));
    this.unsubscribers.push(this.deps.events.on('mission:objectiveCompleted', ({ missionId, label }) => {
      const mission = storyMission(missionId);
      this.deps.ui.missionBanner('objective', mission?.title ?? 'Objective', label);
    }));
    this.unsubscribers.push(this.deps.events.on('mission:completed', ({ id }) => this.onMissionCompleted(id)));
  }

  /** Begin the campaign (after the opening cutscene, or on a fresh load). */
  begin(): void {
    if (this.began) return;
    this.began = true;
    const first = MISSION_CHAIN[0]!;
    if (this.deps.objectives.state(first) === 'inactive') this.deps.objectives.start(first);
    else this.onMissionStarted(first);
  }

  /** True once `begin()` has run (used to gate the opening cutscene). */
  get started(): boolean { return this.began; }

  get currentMissionId(): string | null { return this.activeMissionId; }

  currentAct(): ActId { return this.deps.narrative.act; }

  /**
   * Reconcile after a save restore: find the first chain mission that is
   * active (or the next one after the last completed), reapply its act
   * preset and waypoint. Returns whether anything was active.
   */
  reconcile(): boolean {
    for (const id of MISSION_CHAIN) {
      const state = this.deps.objectives.state(id);
      if (state === 'active') { this.began = true; this.onMissionStarted(id, true); return true; }
      if (state === 'completed') continue;
      // First not-started mission after completions: resume there.
      const previous = MISSION_CHAIN[MISSION_CHAIN.indexOf(id) - 1];
      if (previous === undefined || this.deps.objectives.state(previous) === 'completed') {
        this.began = true;
        this.deps.objectives.start(id);
        return true;
      }
    }
    return false;
  }

  /** Feed the canonical player position (also done by the game each step). */
  updatePlayer(x: number, z: number): void {
    this.deps.objectives.updatePlayer(x, z);
  }

  setFlag(name: string, value: boolean | number | string): void {
    this.deps.objectives.setFlag(name, value);
  }

  private onMissionStarted(id: string, silent = false): void {
    const mission = storyMission(id);
    if (!mission) return;
    this.activeMissionId = id;
    if (!silent) this.deps.ui.missionBanner('mission', mission.title, mission.brief);
    this.applyAct(mission.act, silent);
    this.applyWaypoint(id);
  }

  private onMissionCompleted(id: string): void {
    const mission = storyMission(id);
    this.deps.ui.missionBanner('act', mission?.title ?? 'Objective complete', 'Complete');
    const next = nextMissionId(id);
    if (next) {
      this.deps.objectives.start(next);
      return;
    }
    // Chain finished: the finale act owns the closing sequence.
    this.activeMissionId = null;
    this.applyAct('finale');
    this.deps.discovery.setWaypoint(null);
    this.deps.ui.missionBanner('act', 'Dawn over Blackwood Valley', 'The transmitter is silent');
  }

  private applyAct(next: ActId, silent = false): void {
    this.deps.narrative.setAct(next);
    if (this.appliedAct === next) return;
    this.appliedAct = next;
    const preset = act(next);
    this.deps.weather.setOverride(preset.weather);
    if (preset.hour !== null) {
      this.deps.sky.setHour(preset.hour);
      this.deps.sky.cycling = true;
      this.deps.ui.toast(`Chapter time · ${formatHour(preset.hour)}`);
    }
    if (!silent) this.deps.ui.missionBanner('act', preset.label, '');
    this.deps.onActChange?.(next);
    this.deps.events.emit('story:actChanged', { act: next });
  }

  private applyWaypoint(id: string): void {
    const point = waypointForMission(id);
    if (!point) return;
    this.deps.discovery.setWaypoint({ x: point.x, z: point.z });
  }

  dispose(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
  }
}

function formatHour(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
