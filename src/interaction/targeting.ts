import { dotPoint, normalizePoint } from '../core/coordinates';
import type { WorldPoint } from '../core/coordinates';

/** Anything the interaction system can aim at. */
export interface Targetable {
  readonly id: string;
  /** Canonical centre of the object (not its base). */
  readonly centre: WorldPoint;
  readonly radius: number;
  readonly range: number;
  readonly label: string;
}

export interface TargetView {
  readonly eye: WorldPoint;
  /** Normalized look direction. */
  readonly forward: WorldPoint;
}

export interface TargetOptions {
  /** Hard cap regardless of the target's own range. */
  readonly maxRange: number;
  /** Half-angle of the aim cone in radians. */
  readonly coneRadians: number;
  /** Objects this close are usable even when not centred in the view. */
  readonly proximityRadius: number;
}

export const DEFAULT_TARGET_OPTIONS: TargetOptions = {
  maxRange: 6.5,
  coneRadians: (16 * Math.PI) / 180,
  proximityRadius: 2.3,
};

export interface TargetHit {
  readonly target: Targetable;
  /** Distance from the eye to the target surface, in metres. */
  readonly distance: number;
  /** cos(angle between the view direction and the target direction). */
  readonly alignment: number;
  readonly mode: 'aimed' | 'proximity';
}

/**
 * Context-sensitive target selection.
 *
 * Two rules, in priority order: anything inside the aim cone scores by how
 * centred and how close it is; anything within arm's reach is usable even if it
 * is not centred (so you can open a crate beside you). Farthest-first spam is
 * impossible because the score rewards alignment.
 */
export function selectTarget(targets: Iterable<Targetable>, view: TargetView, options: TargetOptions = DEFAULT_TARGET_OPTIONS): TargetHit | undefined {
  const forward = normalizePoint({ x: view.forward.x, y: view.forward.y, z: view.forward.z });
  const minAlignment = Math.cos(options.coneRadians);
  let best: TargetHit | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const target of targets) {
    const dx = target.centre.x - view.eye.x;
    const dy = target.centre.y - view.eye.y;
    const dz = target.centre.z - view.eye.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > options.maxRange + target.radius) continue;
    const surfaceDistance = Math.max(0, distance - target.radius);
    if (surfaceDistance > Math.min(target.range, options.maxRange)) continue;

    const alignment = distance > 1e-4 ? dotPoint({ x: dx / distance, y: dy / distance, z: dz / distance }, forward) : 1;
    let hit: TargetHit | undefined;
    let score: number;
    if (alignment >= minAlignment) {
      score = alignment * 2 - surfaceDistance * 0.12;
      hit = { target, distance: surfaceDistance, alignment, mode: 'aimed' };
    } else if (surfaceDistance <= options.proximityRadius) {
      score = 0.45 - surfaceDistance * 0.1;
      hit = { target, distance: surfaceDistance, alignment, mode: 'proximity' };
    } else {
      continue;
    }
    if (score > bestScore) { bestScore = score; best = hit; }
  }
  return best;
}
