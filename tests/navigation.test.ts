import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../src/world/road-network';
import { describeRoute, nearestOnRoad, planRoute, snapToRoad } from '../src/discovery/navigation';

const roads = new RoadNetwork('nav-test', (x, z) => 100 + Math.sin(x * 0.001) * 5 + Math.cos(z * 0.001) * 5);

describe('Phase 11 navigation over the analytic corridor network', () => {
  it('plans a real corridor route when both endpoints share a corridor', () => {
    // Two points near corridor 0's centreline: on the line and 40 m off it.
    const onA = roads.point(0, 500);
    const onB = roads.point(0, 1500);
    const from = { x: onA.x, z: onA.z + 40 };
    const to = { x: onB.x, z: onB.z - 30 };
    const plan = planRoute(roads, from, to);
    expect(plan.kind).toBe('corridor');
    if (plan.kind !== 'corridor') return;
    expect(plan.corridor).toBe(0);
    expect(Math.abs(plan.fromStation - 500)).toBeLessThan(50);
    expect(Math.abs(plan.toStation - 1500)).toBeLessThan(50);
    // Distance = along-corridor travel + both lateral access walks.
    expect(plan.distanceM).toBeGreaterThan(900);
    expect(plan.distanceM).toBeLessThan(1300);
    expect(plan.points.length).toBeGreaterThan(2);
    // Every route point lies on the corridor centreline it claims to follow.
    for (const p of plan.points) {
      const sample = roads.sample(p.x, p.z);
      expect(sample.corridor).toBe(0);
      expect(Math.abs(sample.lateral)).toBeLessThan(1);
    }
  });

  it('falls back to an explicitly direct line across corridors', () => {
    // Corridors are 2048 m apart; endpoints on different corridors never share one.
    const a = roads.point(0, 0);
    const b = roads.point(1, 0); // one full corridor spacing away in Z
    const plan = planRoute(roads, { x: a.x, z: a.z }, { x: b.x, z: b.z }, { snapRadius: 50 });
    expect(plan.kind).toBe('direct');
    if (plan.kind !== 'direct') return;
    expect(plan.distanceM).toBeCloseTo(Math.hypot(b.x - a.x, b.z - a.z), 6);
    expect(describeRoute(plan)).toContain('not a road route');
  });

  it('never fabricates a route beyond the snap radius', () => {
    const on = roads.point(0, 0);
    // 180 m off the centreline: >120 m from every corridor plane at this x
    // (corridors repeat every 2048 m), so nothing may snap.
    const far = { x: on.x, z: on.z + 180 };
    expect(nearestOnRoad(roads, far, 120)).toBeUndefined();
    const plan = planRoute(roads, far, { x: on.x + 10, z: on.z }, { snapRadius: 120 });
    expect(plan.kind).toBe('direct');
  });

  it('snaps points onto the centreline within the radius', () => {
    const on = roads.point(0, 2000);
    const off = { x: on.x, z: on.z + 60 };
    const snapped = snapToRoad(roads, off, 120);
    expect(snapped).not.toBeUndefined();
    const sample = roads.sample(snapped!.x, snapped!.z);
    expect(Math.abs(sample.lateral)).toBeLessThan(1);
    expect(snapToRoad(roads, { x: on.x, z: on.z + 500 }, 120)).toBeUndefined();
  });

  it('describes corridor routes honestly with distance and lateral access', () => {
    const a = roads.point(0, 0);
    const plan = planRoute(roads, { x: a.x, z: a.z + 10 }, { x: a.x + 400, z: roads.center(0, a.x + 400) });
    expect(plan.kind).toBe('corridor');
    const text = describeRoute(plan);
    expect(text).toContain('corridor 0');
    expect(text).toContain('lateral access');
    expect(text).toMatch(/\d+ m/);
  });
});
