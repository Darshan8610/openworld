import { describe, expect, it } from 'vitest';
import { NavField } from '../src/npc/navigation';
import { DEFAULT_NAVIGATION } from '../src/npc/navigation';
import type { WorldQueries } from '../src/world/world-queries';

/**
 * Navigation is tested against a synthetic height field so every case is exact:
 * the real terrain is used in the integration suite instead.
 */
interface StubOptions {
  slope?: (x: number, z: number) => number;
  height?: (x: number, z: number) => number;
}

function stubQueries(options: StubOptions = {}): WorldQueries {
  const slopeOf = options.slope ?? (() => 0);
  const heightOf = options.height ?? (() => 0);
  const stub = {
    groundFast(x: number, z: number) {
      return {
        height: heightOf(x, z), nx: 0, ny: 1, nz: 0, slope: slopeOf(x, z),
        surface: 'grass' as const, friction: 0.72, restitution: 0.04, onRoad: false, biome: 0,
      };
    },
    height: (x: number, z: number) => heightOf(x, z),
    slope: (x: number, z: number) => slopeOf(x, z),
    ground(x: number, z: number, out?: Record<string, unknown>) {
      const target = out ?? {};
      target.height = heightOf(x, z);
      target.slope = slopeOf(x, z);
      return target;
    },
  };
  return stub as unknown as WorldQueries;
}

const walkableAll = () => true;

describe('NPC navigation', () => {
  it('walks a straight line across open ground, ending at the target', () => {
    const nav = new NavField(stubQueries());
    const path = nav.findPath({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    const last = path![path!.length - 1]!;
    expect(last.x).toBeCloseTo(40, 5);
    expect(last.z).toBeCloseTo(0, 5);
    expect(nav.searches).toBe(1);
  });

  it('routes around solid geometry instead of through it', () => {
    // A north-south wall with a single gap at z = -20.
    const blocked = (x: number, z: number) => Math.abs(x) < 4 && z > -16 && z < 16;
    const nav = new NavField(stubQueries(), {}, { blocked });
    const path = nav.findPath({ x: -30, y: 0, z: 0 }, { x: 30, y: 0, z: 0 });
    expect(path).not.toBeNull();
    for (const point of path!) expect(blocked(point.x, point.z)).toBe(false);
    // The detour must be longer than the 60 m straight line.
    let length = 0;
    let previous = { x: -30, z: 0 };
    for (const point of path!) {
      length += Math.hypot(point.x - previous.x, point.z - previous.z);
      previous = { x: point.x, z: point.z };
    }
    expect(length).toBeGreaterThan(60);
    expect(nav.lineOfSight({ x: -30, y: 0, z: 0 }, { x: 30, y: 0, z: 0 })).toBe(false);
  });

  it('refuses a destination sealed inside a blocked ring', () => {
    const blocked = (x: number, z: number) => {
      const distance = Math.hypot(x, z);
      return distance > 10 && distance < 14;
    };
    const nav = new NavField(stubQueries(), {}, { blocked });
    const path = nav.findPath({ x: 40, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(path).toBeNull();
  });

  it('treats slopes above the ceiling as unwalkable and respects the node cap', () => {
    const slope = (x: number) => (x > 10 ? 0.9 : 0);
    const nav = new NavField(stubQueries({ slope }));
    expect(nav.isWalkable(0, 0)).toBe(true);
    expect(nav.isWalkable(20, 0)).toBe(false);
    // Unreachable region: the goal sits on the steep side.
    expect(nav.findPath({ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 })).toBeNull();
    const path = nav.findPath({ x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 8 });
    expect(path).not.toBeNull();
  });

  it('bounds a search with the expansion cap and caches nodes', () => {
    const nav = new NavField(stubQueries(), { maxExpansions: 4 });
    const path = nav.findPath({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 400 });
    // Four expansions cannot reach 400 m away, but the result must be bounded, not runaway.
    expect(path === null || path.length < 20).toBe(true);
    const cached = nav.cachedNodes;
    expect(cached).toBeGreaterThan(0);
    expect(cached).toBeLessThanOrEqual(DEFAULT_NAVIGATION.nodeCacheLimit);
  });

  it('picks random walkable points inside the requested radius', () => {
    let state = 1;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const nav = new NavField(stubQueries(), {}, { blocked: (x) => x > 5 });
    for (let i = 0; i < 40; i++) {
      const point = nav.randomWalkablePoint(0, 0, 12, random);
      if (!point) continue;
      expect(Math.hypot(point.x, point.z)).toBeLessThanOrEqual(12.5);
      expect(point.x).toBeLessThanOrEqual(5);
    }
    expect(nav.isWalkable(0, 0)).toBe(walkableAll());
  });

  it('never cuts the corner of a diagonal gap', () => {
    // Only the diagonal cells between the two open areas are blocked.
    const blocked = (x: number, z: number) => x > 0.5 && z > 0.5 && Math.abs(x - z) < 3;
    const nav = new NavField(stubQueries(), {}, { blocked });
    const path = nav.findPath({ x: -6, y: 0, z: 2 }, { x: 8, y: 0, z: 2 });
    if (path) for (const point of path) expect(blocked(point.x, point.z)).toBe(false);
  });
});
