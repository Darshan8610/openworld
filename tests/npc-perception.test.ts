import { describe, expect, it } from 'vitest';
import { Perception } from '../src/npc/perception';
import type { WorldQueries } from '../src/world/world-queries';

/** Height field stub: flat by default, or a ridge generated from the callback. */
function stubQueries(height: (x: number, z: number) => number = () => 0): WorldQueries {
  const stub = {
    groundFast(x: number, z: number) {
      return {
        height: height(x, z), nx: 0, ny: 1, nz: 0, slope: 0,
        surface: 'grass' as const, friction: 0.72, restitution: 0.04, onRoad: false, biome: 0,
      };
    },
    height,
  };
  return stub as unknown as WorldQueries;
}

const targetAt = (x: number, z: number) => ({ id: 'player', kind: 'player' as const, position: { x, y: 0, z } });

describe('NPC perception', () => {
  it('sees a target inside the cone and range', () => {
    const perception = new Perception(stubQueries());
    // yaw 0 faces +Z.
    perception.update(0.1, { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 }, [targetAt(0, 12)]);
    expect(perception.seesPlayer).toBe(true);
    expect(perception.playerMemory?.visible).toBe(true);
    expect(perception.alerted).toBe(true);
  });

  it('ignores a target outside the cone unless it is within arm’s reach', () => {
    const perception = new Perception(stubQueries());
    const behind = targetAt(0, -14);
    perception.update(0.1, { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 }, [behind]);
    expect(perception.seesPlayer).toBe(false);

    const close = targetAt(0, -1.2);
    perception.update(0.1, { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 }, [close]);
    expect(perception.seesPlayer).toBe(true);
  });

  it('ignores a target beyond the sight range', () => {
    const perception = new Perception(stubQueries(), { sightRange: 10 });
    perception.update(0.1, { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 }, [targetAt(0, 40)]);
    expect(perception.seesPlayer).toBe(false);
  });

  it('cannot see through a terrain ridge', () => {
    // A wall of rock at z = 6 blocks the line of sight.
    const perception = new Perception(stubQueries((_x, z) => (z > 5 && z < 8 ? 6 : 0)));
    perception.update(0.1, { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 }, [targetAt(0, 12)]);
    expect(perception.seesPlayer).toBe(false);
  });

  it('remembers a lost target, then forgets it as awareness decays', () => {
    const perception = new Perception(stubQueries(), { memorySeconds: 2 });
    perception.update(0.1, { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 }, [targetAt(0, 10)]);
    expect(perception.seesPlayer).toBe(true);

    // Look away: the memory persists but is no longer visible.
    perception.update(0.5, { position: { x: 0, y: 0, z: 0 }, yaw: Math.PI, eyeHeight: 1.6 }, [targetAt(0, 10)]);
    expect(perception.seesPlayer).toBe(false);
    const memory = perception.playerMemory;
    expect(memory).toBeDefined();
    expect(memory!.visible).toBe(false);
    expect(memory!.awareness).toBeGreaterThan(0.2);
    expect(memory!.awareness).toBeLessThan(1);

    // Two seconds of decay clears it entirely.
    for (let i = 0; i < 8; i++) perception.update(0.5, { position: { x: 0, y: 0, z: 0 }, yaw: Math.PI, eyeHeight: 1.6 }, []);
    expect(perception.playerMemory).toBeUndefined();
    expect(perception.alerted).toBe(false);
  });

  it('hears a stimulus inside the hearing radius and remembers where it was', () => {
    const perception = new Perception(stubQueries(), { hearingRadius: 15 });
    expect(perception.hear(4, 0, 4, 20)).toBe(false);
    expect(perception.hear(4, 0, 4, 6)).toBe(true);
    expect(perception.alerted).toBe(true);
    const stimulus = perception.memoriesList().find((memory) => memory.kind === 'stimulus');
    expect(stimulus).toMatchObject({ x: 4, z: 4, visible: false });
    // A second sound refreshes the same memory instead of stacking new ones.
    perception.hear(6, 0, 6, 3);
    expect(perception.memoriesList().filter((memory) => memory.kind === 'stimulus')).toHaveLength(1);
    expect(perception.memoriesList()[0]!.x).toBe(6);
  });

  it('rate-limits startles but reports one sighting exactly once per read', () => {
    const perception = new Perception(stubQueries(), { spotCooldown: 4 });
    const self = { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 };
    const empty: never[] = [];

    perception.update(0.1, self, [targetAt(0, 12)]);
    expect(perception.justSpotted).toBe(true);
    // Reading the flag consumes it: a tick loop cannot startle twice.
    expect(perception.takeSpot()).toBe(true);
    expect(perception.takeSpot()).toBe(false);

    // Losing and instantly re-acquiring the player does not re-trigger it…
    perception.update(0.1, self, empty);
    perception.update(0.1, self, [targetAt(0, 12)]);
    expect(perception.justSpotted).toBe(false);

    // …but a sighting after the cooldown does.
    perception.update(5, self, empty);
    perception.update(0.1, self, [targetAt(0, 12)]);
    expect(perception.takeSpot()).toBe(true);
  });

  it('clears on demand', () => {
    const perception = new Perception(stubQueries());
    perception.update(0.1, { position: { x: 0, y: 0, z: 0 }, yaw: 0, eyeHeight: 1.6 }, [targetAt(0, 8)]);
    perception.clear();
    expect(perception.seesPlayer).toBe(false);
    expect(perception.memoriesList()).toHaveLength(0);
  });
});
