import { CONFIG } from '../config';
import type { WorldPoint } from '../core/coordinates';
import type { WorldQueries } from '../world/world-queries';

/**
 * Reusable perception for NPCs.
 *
 * Three independent channels, each of which does real work:
 *  - **Sight** — cone + range + a terrain line-of-sight test sampled against the
 *    same height field the ground is built from, so an NPC behind a ridge cannot
 *    see through it.
 *  - **Hearing** — a radius around a stimulus point (a gate banging, a crate
 *    landing, a splash) that marks a memory without revealing the observer.
 *  - **Memory** — awareness decays after `memorySeconds`; an NPC can remember
 *    where something was and investigate it after losing sight.
 *
 * Perception stores canonical world coordinates only, so an origin rebase is
 * invisible to it.
 */

export type PerceptionTargetKind = 'player' | 'npc' | 'stimulus';

export interface PerceptionTarget {
  readonly id: string;
  readonly kind: 'player' | 'npc';
  readonly position: WorldPoint;
}

export interface PerceptionSelf {
  readonly position: WorldPoint;
  /** Body yaw: forward is `(sin yaw, 0, cos yaw)`, matching the rig convention. */
  readonly yaw: number;
  /** Eye height above the feet, metres. */
  readonly eyeHeight: number;
}

export interface PerceptionMemory {
  readonly id: string;
  readonly kind: PerceptionTargetKind;
  x: number;
  y: number;
  z: number;
  /** 0..1; 1 while currently observed. */
  awareness: number;
  /** Seconds since this target was last seen or heard. */
  age: number;
  visible: boolean;
}

export interface PerceptionOptions {
  readonly sightRange: number;
  readonly coneDegrees: number;
  readonly hearingRadius: number;
  readonly memorySeconds: number;
  readonly losSamples: number;
  /** Seconds before a re-acquired player can startle the same NPC again. */
  readonly spotCooldown: number;
}

export const DEFAULT_PERCEPTION: PerceptionOptions = {
  sightRange: CONFIG.npc.perception.sightRange,
  coneDegrees: CONFIG.npc.perception.coneDegrees,
  hearingRadius: CONFIG.npc.perception.hearingRadius,
  memorySeconds: CONFIG.npc.perception.memorySeconds,
  losSamples: CONFIG.npc.perception.losSamples,
  spotCooldown: 4,
};

export class Perception {
  private readonly memories = new Map<string, PerceptionMemory>();
  private readonly options: PerceptionOptions;
  private seeing = false;
  private spotted = false;
  private sinceSpot = Infinity;

  constructor(private readonly queries: WorldQueries, options: Partial<PerceptionOptions> = {}) {
    this.options = { ...DEFAULT_PERCEPTION, ...options };
  }

  /** Currently observed or remembered things, freshest first. */
  memoriesList(): PerceptionMemory[] {
    return [...this.memories.values()].sort((a, b) => b.awareness - a.awareness);
  }

  get seesPlayer(): boolean { return this.seeing; }

  /** True only on the tick the player first became visible (startle trigger). */
  get justSpotted(): boolean { return this.spotted; }

  /**
   * Read and clear the startle flag. Exactly one consumer reacts to a sighting,
   * so a brain that ticks less often than perception still startles once.
   */
  takeSpot(): boolean {
    const spotted = this.spotted;
    this.spotted = false;
    return spotted;
  }

  /** Memory of the player if any, visible or remembered. */
  get playerMemory(): PerceptionMemory | undefined {
    return this.memories.get('player');
  }

  /**
   * A sighting or a sound is enough to raise this: the brain decides what to do
   * with it (investigate, greet, ignore) rather than perception hard-coding a
   * reaction.
   */
  get alerted(): boolean {
    const memory = this.memories.get('player') ?? this.memories.get('stimulus');
    return memory !== undefined && memory.awareness > 0.2;
  }

  update(dt: number, self: PerceptionSelf, targets: readonly PerceptionTarget[]): void {
    const range = this.options.sightRange;
    const halfCone = (this.options.coneDegrees * Math.PI) / 360;
    const eyeY = self.position.y + self.eyeHeight;
    const forwardX = Math.sin(self.yaw), forwardZ = Math.cos(self.yaw);
    const seenThisTick = new Set<string>();
    let seesPlayer = false;
    this.spotted = false;
    this.sinceSpot += dt;

    for (const target of targets) {
      const dx = target.position.x - self.position.x;
      const dz = target.position.z - self.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > range) continue;
      // A target inside arm's reach is noticed even at the cone edge.
      if (distance > 1.6) {
        const alignment = distance > 1e-4 ? (dx * forwardX + dz * forwardZ) / distance : 1;
        if (alignment < Math.cos(halfCone)) continue;
      }
      const targetEye = target.position.y + (target.kind === 'player' ? 1.6 : 1.55);
      if (!this.clearLine(self.position.x, eyeY, self.position.z, target.position.x, targetEye, target.position.z)) continue;
      seenThisTick.add(target.id);
      this.remember(target, 1);
      if (target.kind === 'player') seesPlayer = true;
    }

    // Decay everything not seen this tick; memories fade out rather than snapping.
    const decay = dt / Math.max(0.1, this.options.memorySeconds);
    for (const [id, memory] of [...this.memories]) {
      if (seenThisTick.has(id)) continue;
      memory.age += dt;
      memory.visible = false;
      memory.awareness = Math.max(0, memory.awareness - decay);
      if (memory.awareness <= 0.01) this.memories.delete(id);
    }
    for (const id of seenThisTick) {
      const memory = this.memories.get(id);
      if (!memory) continue;
      memory.age = 0;
      memory.visible = true;
    }
    if (seesPlayer && !this.seeing && this.sinceSpot >= this.options.spotCooldown) {
      this.spotted = true;
      this.sinceSpot = 0;
    }
    this.seeing = seesPlayer;
  }

  /** Register a sound at a world position; only within `hearingRadius`. */
  hear(x: number, y: number, z: number, distance: number): boolean {
    if (distance > this.options.hearingRadius) return false;
    const existing = this.memories.get('stimulus');
    if (existing) {
      existing.x = x; existing.y = y; existing.z = z;
      existing.awareness = Math.min(1, Math.max(existing.awareness, 0.85));
      existing.age = 0;
      return true;
    }
    this.memories.set('stimulus', {
      id: 'stimulus', kind: 'stimulus', x, y, z,
      awareness: 0.85, age: 0, visible: false,
    });
    return true;
  }

  /** Forget everything (respawn, teleport, conversation reset). */
  clear(): void {
    this.memories.clear();
    this.seeing = false;
    this.spotted = false;
    this.sinceSpot = Infinity;
  }

  private remember(target: PerceptionTarget, awareness: number): void {
    const existing = this.memories.get(target.id);
    if (existing) {
      existing.x = target.position.x; existing.y = target.position.y; existing.z = target.position.z;
      existing.awareness = Math.max(existing.awareness, awareness);
      return;
    }
    this.memories.set(target.id, {
      id: target.id, kind: target.kind,
      x: target.position.x, y: target.position.y, z: target.position.z,
      awareness, age: 0, visible: true,
    });
  }

  /**
   * Terrain occlusion test: if the ground rises above the sight line anywhere
   * between eye and target, the sighting is blocked. Uses the same `groundFast`
   * sample as the physics and prop systems so nobody can see through a hill.
   */
  private clearLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const samples = this.options.losSamples;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const lineY = ay + (by - ay) * t;
      if (this.queries.groundFast(x, z).height > lineY + 0.35) return false;
    }
    return true;
  }
}
