import { CatmullRomCurve3, PerspectiveCamera, Vector3 } from 'three/webgpu';

/**
 * Cinematic camera sequencer.
 *
 * Authored shots interpolate position and look-at along cubic Catmull-Rom
 * splines (a Hermite form — the spec's requested interpolation) with piecewise
 * FOV easing. While a shot plays the game locks character motion and vehicle
 * controls, drops letterbox bars, hides the HUD, shows subtitles and ducks the
 * mix so narration stays clear over rain and engines.
 *
 * Accessibility: prefers-reduced-motion jumps straight to the final frame —
 * the story beat still lands, the swooping camera does not.
 */

export interface CinematicKeyframe {
  /** Seconds from shot start. Must be strictly increasing. */
  readonly at: number;
  readonly position: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  readonly fov: number;
}

export interface CinematicSubtitle {
  readonly at: number;
  readonly duration: number;
  readonly text: string;
  readonly speaker?: string;
}

export interface CinematicShot {
  readonly id: string;
  readonly keyframes: readonly CinematicKeyframe[];
  readonly subtitles?: readonly CinematicSubtitle[];
  readonly letterbox?: boolean;
  /** Master gain multiplier while the shot plays (0..1); 1 = no ducking. */
  readonly duck?: number;
}

export interface CinematicHooks {
  readonly ui: {
    setLetterbox(on: boolean): void;
    setSubtitle(text: string | null, speaker?: string | null): void;
    setHudVisible(visible: boolean): void;
  };
  readonly audio: { setDuck(level: number): void };
  readonly reducedMotion?: boolean;
}

interface RunningShot {
  shot: CinematicShot;
  elapsed: number;
  duration: number;
  positionCurve: CatmullRomCurve3;
  lookCurve: CatmullRomCurve3;
  activeSubtitle: number;
  resolve: (id: string) => void;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class CinematicDirector {
  private running: RunningShot | null = null;
  private hudHidden = false;
  readonly camera = new PerspectiveCamera(55, 16 / 9, 0.1, 20000);

  constructor(private readonly hooks: CinematicHooks) {}

  get active(): boolean { return this.running !== null; }
  get activeShotId(): string | null { return this.running?.shot.id ?? null; }

  /** Begin a shot. Resolves with the shot id when it completes (or is skipped). */
  play(shot: CinematicShot): Promise<string> {
    if (this.running) this.skip();
    if (shot.keyframes.length < 2 || !Number.isFinite(shot.keyframes[shot.keyframes.length - 1]!.at)) {
      return Promise.resolve(shot.id);
    }
    const duration = shot.keyframes[shot.keyframes.length - 1]!.at;
    const positions = shot.keyframes.map((key) => new Vector3(...key.position));
    const looks = shot.keyframes.map((key) => new Vector3(...key.lookAt));
    const running: RunningShot = {
      shot, elapsed: 0, duration,
      positionCurve: new CatmullRomCurve3(positions, false, 'catmullrom', 0.5),
      lookCurve: new CatmullRomCurve3(looks, false, 'catmullrom', 0.5),
      activeSubtitle: -1,
      resolve: () => undefined,
    };
    const promise = new Promise<string>((resolve) => { running.resolve = resolve; });
    this.running = running;
    this.hooks.ui.setLetterbox(shot.letterbox !== false);
    this.hooks.ui.setSubtitle(null, null);
    if (!this.hudHidden) { this.hooks.ui.setHudVisible(false); this.hudHidden = true; }
    this.hooks.audio.setDuck(Math.min(1, Math.max(0, shot.duck ?? 0.55)));
    if (this.hooks.reducedMotion) {
      // Land the beat without the travel.
      this.applyAt(running, duration);
      this.finish(running);
    }
    return promise;
  }

  /** Advance the active shot; called once per rendered frame. */
  update(dt: number): void {
    const running = this.running;
    if (!running) return;
    running.elapsed = Math.min(running.duration, running.elapsed + Math.max(0, dt));
    this.applyAt(running, running.elapsed);
    if (running.elapsed >= running.duration) this.finish(running);
  }

  /** End the active shot immediately (Esc / click-through). */
  skip(): void {
    const running = this.running;
    if (!running) return;
    this.applyAt(running, running.duration);
    this.finish(running);
  }

  private finish(running: RunningShot): void {
    if (this.running !== running) return;
    this.running = null;
    this.hooks.ui.setLetterbox(false);
    this.hooks.ui.setSubtitle(null, null);
    if (this.hudHidden) { this.hooks.ui.setHudVisible(true); this.hudHidden = false; }
    this.hooks.audio.setDuck(1);
    running.resolve(running.shot.id);
  }

  private applyAt(running: RunningShot, time: number): void {
    const { shot } = running;
    const keys = shot.keyframes;
    const last = keys[keys.length - 1]!;
    const clamped = Math.min(Math.max(0, time), last.at);
    // Piecewise map shot-time → curve parameter so keyframe timing is honoured.
    let segment = 0;
    while (segment < keys.length - 2 && keys[segment + 1]!.at < clamped) segment++;
    const a = keys[segment]!, b = keys[segment + 1] ?? last;
    const span = Math.max(1e-6, b.at - a.at);
    const local = smoothstep(Math.min(1, Math.max(0, (clamped - a.at) / span)));
    const u = (segment + local) / Math.max(1, keys.length - 1);
    const position = running.positionCurve.getPoint(u);
    const look = running.lookCurve.getPoint(u);
    const fov = a.fov + (b.fov - a.fov) * local;
    this.camera.position.copy(position);
    this.camera.lookAt(look);
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.updateSubtitle(running, clamped);
  }

  private updateSubtitle(running: RunningShot, time: number): void {
    const subtitles = running.shot.subtitles ?? [];
    let index = -1;
    for (let i = 0; i < subtitles.length; i++) {
      const cue = subtitles[i]!;
      if (time >= cue.at && time < cue.at + cue.duration) { index = i; break; }
    }
    if (index === running.activeSubtitle) return;
    running.activeSubtitle = index;
    if (index < 0) this.hooks.ui.setSubtitle(null, null);
    else {
      const cue = subtitles[index]!;
      this.hooks.ui.setSubtitle(cue.text, cue.speaker ?? null);
    }
  }
}
