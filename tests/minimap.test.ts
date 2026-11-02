import { describe, expect, it } from 'vitest';
import { Discovery } from '../src/discovery/discovery';
import { Minimap } from '../src/ui/minimap';
import { RoadNetwork } from '../src/world/road-network';
import type { WorldQueries } from '../src/world/world-queries';

/** Minimal canvas/ctx/DOM stand-ins: enough to exercise drawing + throttling. */
function fakeDom() {
  const calls = { fillRect: 0, stroke: 0, arc: 0, clearRect: 0 };
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    clearRect: () => { calls.clearRect++; },
    fillRect: () => { calls.fillRect++; },
    beginPath: () => {}, closePath: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, rotate: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => { calls.stroke++; },
    strokeRect: () => {},
    fill: () => {},
    arc: () => { calls.arc++; },
  };
  const canvas = {
    className: '', width: 0, height: 0, title: '',
    style: { display: '' } as { display: string },
    getContext: () => ctx,
  };
  const doc = { createElement: () => canvas };
  const container = { appendChild: () => {} };
  return { calls, canvas, doc, container };
}

const roads = new RoadNetwork('minimap-test', (x) => 100 + Math.sin(x * 0.001) * 5);
const queries = () => ({ field: { roads }, climateAt: () => ({ dominant: 0 }) }) as unknown as WorldQueries;

describe('Phase 11 minimap', () => {
  it('draws with an injected document and throttles redraws', () => {
    const { calls, canvas, doc, container } = fakeDom();
    const discovery = new Discovery();
    const minimap = new Minimap(discovery, queries, container, 144, 500, doc as unknown as Document);
    expect(canvas.className).toBe('minimap');
    expect(canvas.width).toBe(144);

    const player = { x: 0, z: 0, yaw: 0 };
    minimap.update(player, 1000);
    const afterFirst = { ...calls };
    expect(afterFirst.clearRect).toBe(1);

    // Identical state within the 200 ms window: no redraw.
    minimap.update(player, 1100);
    expect(calls.clearRect).toBe(1);
    // Movement beyond the threshold redraws.
    minimap.update({ x: 30, z: 0, yaw: 0 }, 1150);
    expect(calls.clearRect).toBe(2);
    // After the window, even a still player redraws.
    minimap.update({ x: 30, z: 0, yaw: 0 }, 1400);
    expect(calls.clearRect).toBe(3);
  });

  it('draws discovered cells and a waypoint marker', () => {
    const { calls, doc, container } = fakeDom();
    const discovery = new Discovery();
    discovery.visit({ x: 0, z: 0 });
    const minimap = new Minimap(discovery, queries, container, 144, 500, doc as unknown as Document);
    minimap.setWaypoint({ x: 100, z: 100 });
    minimap.update({ x: 0, z: 0, yaw: 1 }, 0);
    // Background + at least one discovered-cell tint + waypoint arc.
    expect(calls.fillRect).toBeGreaterThan(1);
    expect(calls.arc).toBeGreaterThan(0);
    minimap.dispose();
  });

  it('stays hidden and cheap while disabled', () => {
    const { calls, canvas, doc, container } = fakeDom();
    const minimap = new Minimap(new Discovery(), queries, container, 144, 500, doc as unknown as Document);
    minimap.setEnabled(false);
    expect(minimap.isVisible()).toBe(false);
    expect(canvas.style.display).toBe('none');
    minimap.update({ x: 0, z: 0, yaw: 0 }, 0);
    expect(calls.clearRect).toBe(0);
    minimap.setEnabled(true);
    expect(canvas.style.display).toBe('');
    minimap.update({ x: 0, z: 0, yaw: 0 }, 0);
    expect(calls.clearRect).toBe(1);
    minimap.dispose();
  });
});
