import type { GameEventBus } from '../core/events';
import type { ObjectiveRuntime } from '../game/objectives';
import type { Discovery } from '../discovery/discovery';
import type { Inventory } from '../interaction/inventory';
import type { InteractionProvider } from '../interaction/types';
import type { WeatherKind } from '../environment/weather';
import type { ConversationView } from '../npc/types';
import type { ActId } from './campaign';
import type { BannerKind, MissionDirector } from './mission-director';
import type { NarrativeState } from './narrative-state';
import { CampaignBounds } from './bounds';
import { CinematicDirector, type CinematicShot } from './cinematic';
import { MissionDirector as Director } from './mission-director';
import { NarrativeTracker, validateNarrativeState } from './narrative-state';
import { StoryProps } from './story-props';
import { STORY_PROPS } from './content';
import { EVELYN_TREE, StoryDialogueRunner } from './dialogue';
import { buildFinaleShot, buildOpeningShot, buildRelayShot, buildRevelationShot } from './opening';

/** What the story layer needs from the interface — structural, no UI imports. */
export interface StoryUi {
  missionBanner(kind: BannerKind, title: string, detail: string): void;
  toast(message: string): void;
  setLetterbox(on: boolean): void;
  setSubtitle(text: string | null, speaker?: string | null): void;
  setHudVisible(visible: boolean): void;
  showClue(clue: { title: string; body: string; kind: string }): void;
  setCredits(on: boolean): void;
  setDialogue(view: ConversationView | null): void;
}

export interface StoryDeps {
  readonly objectives: ObjectiveRuntime;
  readonly events: GameEventBus;
  readonly discovery: Discovery;
  readonly inventory: Inventory;
  readonly registerProvider: (provider: InteractionProvider) => void;
  readonly unregisterProvider: (id: string) => void;
  readonly weather: { setOverride(kind: WeatherKind | null): void };
  readonly sky: { setHour(hour: number): void; cycling: boolean };
  readonly ui: StoryUi;
  readonly ground: (x: number, z: number) => number;
  readonly roadZ: (x: number) => number;
  readonly reducedMotion: boolean;
  /** Place Jack at the stranded arrival (called after the opening shot). */
  readonly spawnArrival: () => void;
  /** Duck the master mix for cutscenes (1 = full volume). */
  readonly duck: (level: number) => void;
}

/**
 * Echoes of Blackwood Valley — narrative facade.
 *
 * Owns the mission director, cinematic sequencer, bounds, narrative props and
 * the Evelyn dialogue; subscribes to the existing event bus; persists a small
 * narrative save slice. The engine underneath keeps working unchanged.
 */
export class StoryGame {
  readonly narrative = new NarrativeTracker();
  readonly bounds = new CampaignBounds();
  readonly cinematic: CinematicDirector;
  readonly director: MissionDirector;
  readonly dialogue = new StoryDialogueRunner();
  private readonly props: StoryProps;
  private readonly unsubscribers: (() => void)[] = [];
  private openingDone = false;
  private creditsShown = false;

  constructor(private readonly deps: StoryDeps) {
    this.cinematic = new CinematicDirector({
      ui: {
        setLetterbox: (on) => deps.ui.setLetterbox(on),
        setSubtitle: (text, speaker) => deps.ui.setSubtitle(text, speaker),
        setHudVisible: (visible) => deps.ui.setHudVisible(visible),
      },
      audio: { setDuck: (level) => this.duck(level) },
      reducedMotion: deps.reducedMotion,
    });
    this.director = new Director({
      objectives: deps.objectives,
      events: deps.events,
      discovery: deps.discovery,
      narrative: this.narrative,
      ui: { missionBanner: (kind, title, detail) => deps.ui.missionBanner(kind, title, detail), toast: (m) => deps.ui.toast(m) },
      weather: deps.weather,
      sky: deps.sky,
      onActChange: (act) => this.onAct(act),
    });
    this.director.register();
    this.props = new StoryProps(deps.registerProvider, deps.unregisterProvider, {
      narrative: this.narrative,
      showClue: (clue) => deps.ui.showClue(clue),
      onFlag: (flag) => this.director.setFlag(flag, true),
      onDoor: (id) => this.onStoryDoor(id),
      ground: deps.ground,
    });
    for (const spec of STORY_PROPS) this.props.add(spec);
    this.wireEvents();
  }

  // ---- lifecycle ------------------------------------------------------------

  /** First time the world reports ready: open with the stranded arrival. */
  onWorldReady(): void {
    if (this.openingDone) return;
    this.openingDone = true;
    if (this.director.started || this.narrative.hasCutscene('opening')) {
      // Restored progress: no opening replay; resume the chain.
      if (!this.director.started) this.director.begin();
      return;
    }
    const shot = buildOpeningShot(this.deps.roadZ, this.deps.ground);
    void this.playShot(shot, 'opening').then(() => {
      this.narrative.markCutscene('opening');
      this.deps.spawnArrival();
      this.director.begin();
    });
  }

  /** Advance cinematics once per rendered frame. */
  update(dt: number): void {
    this.cinematic.update(dt);
  }

  /** Clamp hook target (the game applies the actual clamp each fixed step). */
  get boundsActive(): boolean { return !this.cinematic.active; }

  saveState(): NarrativeState { return this.narrative.snapshot(); }

  restoreState(value: unknown): boolean {
    const valid = validateNarrativeState(value) !== null;
    this.narrative.restore(value);
    this.openingDone = true; // a save always means the opening already played
    if (this.director.reconcile()) this.openingDone = true;
    return valid;
  }

  /**
   * Player death: drop dead-end mission state, walk back in at the arrival and
   * pin the current beat so a reload cannot strand progress.
   */
  reconcilePlayerDied(): void {
    this.deps.spawnArrival();
    this.deps.ui.toast('The valley pushes you back to the road — the beat you were on still holds.');
    this.deps.ui.setHudVisible(true);
  }

  /** Duck the mix under Evelyn conversations (and restore on close). */
  setDialogueDuck(on: boolean): void {
    this.deps.duck(on ? 0.35 : 1);
  }

  get isDialogueActive(): boolean { return this.dialogue.active; }

  dialogueStarted(): ConversationView | null {
    const node = this.dialogue.current;
    if (!node || !this.dialogue.active) return null;
    return {
      npcId: 'evelyn',
      npcLabel: this.dialogue.speaker ?? 'Evelyn',
      topics: node.choices.map((choice, index) => ({ id: String(index), label: choice.label })),
      line: node.line,
    };
  }

  chooseDialogueTopic(index: number): boolean {
    if (!this.dialogue.active) return false;
    const node = this.dialogue.choose(index, {
      onFlag: (flag) => this.director.setFlag(flag, true),
      onItem: (item) => this.deps.inventory.add(item, 1),
    });
    const view = node ? this.dialogueStarted() : null;
    this.deps.ui.setDialogue(view);
    if (!node) this.deps.events.emit('npc:talkEnded', { id: 'evelyn', reason: 'player' });
    return true;
  }

  endDialogue(): boolean {
    if (!this.dialogue.active) return false;
    this.dialogue.end();
    this.deps.ui.setDialogue(null);
    return true;
  }

  /** Esc/click-through during a shot. */
  skipCinematic(): void {
    if (this.cinematic.active) this.cinematic.skip();
  }

  dispose(): void {
    this.director.dispose();
    this.props.dispose();
    this.bounds.dispose();
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
  }

  // ---- internals ------------------------------------------------------------

  private async playShot(shot: CinematicShot, cutsceneId?: string): Promise<string> {
    if (cutsceneId) this.narrative.markCutscene(cutsceneId);
    return this.cinematic.play(shot);
  }

  private wireEvents(): void {
    const { events } = this.deps;
    this.unsubscribers.push(events.on('object:interacted', ({ id }) => {
      if (id === 'story:door-room4') this.openEvelynDialogue();
    }));
    this.unsubscribers.push(events.on('mission:completed', ({ id }) => {
      if (id === 'a2_radio') void this.playShot(buildRelayShot(this.deps.ground));
      else if (id === 'a3_cabin') void this.playShot(buildRevelationShot(this.deps.ground));
    }));
  }

  private onStoryDoor(id: string): void {
    if (id === 'story:door-room4') this.openEvelynDialogue();
  }

  private openEvelynDialogue(): void {
    if (this.dialogue.active) return;
    const node = this.dialogue.begin(EVELYN_TREE, (flag) => this.deps.objectives.getFlag(flag) === true);
    this.deps.events.emit('npc:talkStarted', { id: 'evelyn', label: 'Evelyn' });
    this.deps.ui.setDialogue({
      npcId: 'evelyn',
      npcLabel: 'Evelyn',
      topics: node.choices.map((choice, index) => ({ id: String(index), label: choice.label })),
      line: node.line,
    });
  }

  private onAct(act: ActId): void {
    if (act === 'finale' && !this.creditsShown) {
      this.creditsShown = true;
      void this.playShot(buildFinaleShot(this.deps.ground)).then(() => {
        this.deps.ui.setCredits(true);
      });
    }
  }

  private duck(level: number): void {
    this.deps.duck(level);
  }
}
