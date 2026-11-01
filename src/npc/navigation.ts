import { CONFIG } from '../config';
import type { WorldPoint } from '../core/coordinates';
import type { WorldQueries } from '../world/world-queries';

/**
 * Navigation over the streamed world.
 *
 * The world is infinite, so a baked global navmesh is impossible. Instead the
 * navigation field is *sampled lazily* from the same `WorldQueries` grass, rock,
 * slope and road answers every other system uses: A* expands nodes on demand,
 * caches them, and is bounded per search. That keeps pathfinding exact with
 * respect to the terrain the renderer draws, respects the same slope ceiling as
 * the character controller, and costs nothing in parts of the map nobody visits.
 *
 * Solid authored geometry (objects today, buildings in Phase 7, vehicles later)
 * plugs in through `NavigationBlockers` instead of every navigation consumer
 * deriving its own obstruction rules.
 */

export interface NavigationBlockers {
  /** True when a solid world object occupies this XZ. */
  blocked(x: number, z: number): boolean;
}

export interface NavigationOptions {
  /** Spacing between navigation nodes, metres. */
  readonly nodeSize: number;
  /** Hard cap on node expansions for one search. */
  readonly maxExpansions: number;
  /** Distance at which a waypoint counts as reached. */
  readonly arriveRadius: number;
  /** Walkability slope ceiling (0..1 over 45°). */
  readonly maxSlope: number;
  /** Extra traversal cost on the carriageway, so NPCs drift off the road. */
  readonly roadPenalty: number;
  /** Cached node ceiling; the field must not grow with travel distance. */
  readonly nodeCacheLimit: number;
}

export const DEFAULT_NAVIGATION: NavigationOptions = { ...CONFIG.npc.navigation };

/** The slice of navigation an NPC agent can use (and tests can fake). */
export interface NavigationService {
  readonly searches: number;
  isWalkable(x: number, z: number): boolean;
  /** Waypoints from `from` to `to`, excluding the start, or null when unreachable. */
  findPath(from: WorldPoint, to: WorldPoint): WorldPoint[] | null;
  /** Deterministic-ish random walkable point around (x, z), or undefined. */
  randomWalkablePoint(x: number, z: number, radius: number, random: () => number): WorldPoint | undefined;
  /** True when a straight walk between the two points stays walkable. */
  lineOfSight(from: WorldPoint, to: WorldPoint): boolean;
}

interface NavNode {
  readonly walkable: boolean;
  readonly cost: number;
  readonly height: number;
}

interface OpenEntry {
  readonly key: string;
  readonly f: number;
  readonly ix: number;
  readonly iz: number;
}

/** Small binary min-heap; A* never allocates arrays per search. */
class MinHeap {
  private readonly items: OpenEntry[] = [];

  get size(): number { return this.items.length; }

  push(entry: OpenEntry): void {
    this.items.push(entry);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentEntry = this.items[parent]!;
      if (parentEntry.f <= entry.f) break;
      this.items[index] = parentEntry;
      index = parent;
    }
    this.items[index] = entry;
  }

  pop(): OpenEntry | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (!top || !last || this.items.length === 0) return top;
    let index = 0;
    const length = this.items.length;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      const child = right < length && this.items[right]!.f < this.items[left]!.f ? right : left;
      const childEntry = this.items[child]!;
      if (childEntry.f >= last.f) break;
      this.items[index] = childEntry;
      index = child;
    }
    this.items[index] = last;
    return top;
  }
}

const NEIGHBOURS: readonly [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class NavField implements NavigationService {
  private readonly nodes = new Map<string, NavNode>();
  private readonly options: NavigationOptions;
  private searchCount = 0;

  constructor(
    private readonly queries: WorldQueries,
    options: Partial<NavigationOptions> = {},
    private readonly blockers?: NavigationBlockers,
  ) {
    this.options = { ...DEFAULT_NAVIGATION, ...options };
  }

  get searches(): number { return this.searchCount; }
  get cachedNodes(): number { return this.nodes.size; }

  isWalkable(x: number, z: number): boolean {
    const sample = this.queries.groundFast(x, z);
    if (sample.slope > this.options.maxSlope) return false;
    return this.blockers?.blocked(x, z) !== true;
  }

  findPath(from: WorldPoint, to: WorldPoint): WorldPoint[] | null {
    this.searchCount += 1;
    const size = this.options.nodeSize;
    const start = this.nearestWalkable(from.x, from.z, 2);
    const goal = this.nearestWalkable(to.x, to.z, 1);
    if (!start || !goal) return null;
    // A goal node far from the requested point means the destination itself is
    // unreachable (inside a cliff, a building or the sea) — refuse rather than
    // walking the NPC to a ledge near it and failing there.
    if (Math.hypot(goal.ix * size - to.x, goal.iz * size - to.z) > size * 1.6) return null;
    if (start.ix === goal.ix && start.iz === goal.iz) {
      return this.isWalkable(to.x, to.z) ? [{ x: to.x, y: this.queries.groundFast(to.x, to.z).height, z: to.z }] : [];
    }

    const open = new MinHeap();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>();
    const closed = new Set<string>();
    const startKey = `${start.ix}:${start.iz}`;
    gScore.set(startKey, 0);
    open.push({ key: startKey, ix: start.ix, iz: start.iz, f: this.heuristic(start.ix, start.iz, goal.ix, goal.iz) });

    let expansions = 0;
    let reached = false;

    while (open.size > 0 && expansions < this.options.maxExpansions) {
      const current = open.pop()!;
      if (closed.has(current.key)) continue;
      closed.add(current.key);
      expansions += 1;

      if (current.ix === goal.ix && current.iz === goal.iz) { reached = true; break; }

      const currentCost = gScore.get(current.key) ?? Infinity;
      for (const [dx, dz, step] of NEIGHBOURS) {
        const ix = current.ix + dx, iz = current.iz + dz;
        const key = `${ix}:${iz}`;
        if (closed.has(key)) continue;
        const node = this.nodeAt(ix, iz);
        if (!node.walkable) continue;
        // Diagonal moves may not cut a corner between two blocked nodes.
        if (dx !== 0 && dz !== 0) {
          if (!this.nodeAt(current.ix + dx, current.iz).walkable) continue;
          if (!this.nodeAt(current.ix, current.iz + dz).walkable) continue;
        }
        const tentative = currentCost + step * node.cost;
        if (tentative >= (gScore.get(key) ?? Infinity)) continue;
        gScore.set(key, tentative);
        cameFrom.set(key, current.key);
        open.push({ key, ix, iz, f: tentative + this.heuristic(ix, iz, goal.ix, goal.iz) });
      }
    }

    // No goal means no path: a partial route would march an NPC into a wall.
    if (!reached) return null;
    // Reconstruct the chain, then smooth it against terrain line of sight.
    const chain: WorldPoint[] = [];
    let cursor = `${goal.ix}:${goal.iz}`;
    let guard = 0;
    while (cursor !== startKey && guard++ < 4096) {
      const [ix, iz] = cursor.split(':');
      chain.push({ x: Number(ix) * size, y: 0, z: Number(iz) * size });
      const previous = cameFrom.get(cursor);
      if (!previous) break;
      cursor = previous;
    }
    chain.reverse();
    if (chain.length === 0) return [];
    // Aim at the true destination when it is walkable and close to the goal node.
    const exact: WorldPoint = { x: to.x, y: this.queries.groundFast(to.x, to.z).height, z: to.z };
    if (this.isWalkable(to.x, to.z)) chain.push(exact);
    return this.smooth(chain, from);
  }

  randomWalkablePoint(x: number, z: number, radius: number, random: () => number): WorldPoint | undefined {
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = random() * Math.PI * 2;
      const distance = radius * (0.35 + random() * 0.65);
      const px = x + Math.cos(angle) * distance;
      const pz = z + Math.sin(angle) * distance;
      if (!this.isWalkable(px, pz)) continue;
      return { x: px, y: this.queries.groundFast(px, pz).height, z: pz };
    }
    return undefined;
  }

  /** Sample the field for one quantized node, memoised with a bounded cache. */
  nodeAt(ix: number, iz: number): NavNode {
    const key = `${ix}:${iz}`;
    const cached = this.nodes.get(key);
    if (cached) return cached;
    const x = ix * this.options.nodeSize, z = iz * this.options.nodeSize;
    const sample = this.queries.groundFast(x, z);
    const onRoad = sample.surface === 'asphalt' || sample.surface === 'gravel';
    const node: NavNode = {
      walkable: sample.slope <= this.options.maxSlope && this.blockers?.blocked(x, z) !== true,
      cost: 1 + (onRoad ? this.options.roadPenalty : 0),
      height: sample.height,
    };
    if (this.nodes.size >= this.options.nodeCacheLimit) {
      // Insertion-ordered eviction: the field is a cache, not world data.
      let removed = 0;
      for (const old of this.nodes.keys()) {
        this.nodes.delete(old);
        if (++removed >= Math.floor(this.options.nodeCacheLimit / 4)) break;
      }
    }
    this.nodes.set(key, node);
    return node;
  }

  /** Terrain-following straight-line test used by smoothing and steering fallbacks. */
  lineOfSight(from: WorldPoint, to: WorldPoint): boolean {
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(distance / (this.options.nodeSize * 0.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!this.isWalkable(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) return false;
    }
    return true;
  }

  clear(): void { this.nodes.clear(); }

  private smooth(points: readonly WorldPoint[], from: WorldPoint): WorldPoint[] {
    if (points.length <= 2) return [...points];
    const out: WorldPoint[] = [];
    let anchor = from;
    let index = 0;
    while (index < points.length) {
      let far = index;
      for (let candidate = points.length - 1; candidate > index; candidate--) {
        if (this.lineOfSight(anchor, points[candidate]!)) { far = candidate; break; }
      }
      const point = points[far]!;
      out.push(point);
      anchor = point;
      index = far + 1;
    }
    return out;
  }

  private nearestWalkable(x: number, z: number, maxRing: number): { ix: number; iz: number } | undefined {
    const cx = Math.round(x / this.options.nodeSize), cz = Math.round(z / this.options.nodeSize);
    let best: { ix: number; iz: number; distance: number } | undefined;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const ix = cx + dx, iz = cz + dz;
          if (!this.nodeAt(ix, iz).walkable) continue;
          const distance = Math.hypot(ix * this.options.nodeSize - x, iz * this.options.nodeSize - z);
          if (!best || distance < best.distance) best = { ix, iz, distance };
        }
      }
      if (best) return best;
    }
    return undefined;
  }

  private heuristic(ax: number, az: number, bx: number, bz: number): number {
    const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * this.options.nodeSize;
  }
}
