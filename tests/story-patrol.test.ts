import { describe, expect, it } from 'vitest';
import { ShadowPatrol, type PatrolPlayer } from '../src/story/shadow-patrol';

function player(over: Partial<PatrolPlayer> = {}): PatrolPlayer {
  return { x: 0, z: 0, yaw: 0, lit: false, onFoot: true, crouched: false, sprinting: false, ...over };
}

function makePatrol(over: { los?: boolean } = {}) {
  const spots: number[] = [];
  // Orbit centre at the origin; player placed relative to it.
  const patrol = new ShadowPatrol({ x: 0, z: 0 }, 26, {
    ground: () => 100,
    losBlocked: () => over.los ?? false,
    onSpotted: (times) => spots.push(times),
  });
  patrol.active = true;
  return { patrol, spots };
}

describe('shadow patrol detection model', () => {
  it('stays invisible and passive until the act wakes it', () => {
    const patrol = new ShadowPatrol({ x: 0, z: 0 }, 26, { ground: () => 0, losBlocked: () => false, onSpotted: () => {} });
    expect(patrol.active).toBe(false);
    const before = patrol.position;
    patrol.update(0.5, player({ x: before.x, z: before.z }));
    expect(patrol.position).toEqual(before);
    expect(patrol.timesSpotted).toBe(0);
    patrol.dispose();
  });

  it('spots an upright player inside the sight envelope with clear line of sight', () => {
    const { patrol, spots } = makePatrol();
    // Park the patrol at a known point, player 12 m away.
    patrol.update(0.001, player({ x: 9999, z: 9999, onFoot: false }));
    const here = patrol.position;
    patrol.update(0.001, player({ x: here.x + 12, z: here.z }));
    expect(spots).toEqual([1]);
    expect(patrol.timesSpotted).toBe(1);
    expect(patrol.searching).toBe(true);
    expect(patrol.creditsEvade()).toBe(false);
    patrol.dispose();
  });

  it('crouching collapses the envelope; sprinting and light carry further', () => {
    expect(ShadowPatrol.sightRange({ crouched: true, sprinting: false, lit: false })).toBe(8);
    expect(ShadowPatrol.sightRange({ crouched: false, sprinting: false, lit: false })).toBe(19);
    expect(ShadowPatrol.sightRange({ crouched: false, sprinting: true, lit: false })).toBe(24);
    // A lit flashlight is as loud as a sprint to something hunting in the dark.
    expect(ShadowPatrol.sightRange({ crouched: false, sprinting: false, lit: true })).toBe(24);
    // Crouched with light: still smaller than upright-dark, but not aghost.
    expect(ShadowPatrol.sightRange({ crouched: true, sprinting: false, lit: true })).toBe(13);
    const { patrol, spots } = makePatrol();
    patrol.update(0.001, player({ x: 9999, z: 9999, onFoot: false }));
    const here = patrol.position;
    // 12 m: visible upright, hidden crouched.
    patrol.update(0.001, player({ x: here.x + 12, z: here.z, crouched: true }));
    expect(spots).toEqual([]);
    patrol.update(0.001, player({ x: here.x + 12, z: here.z, crouched: false }));
    expect(spots).toEqual([1]);
    patrol.dispose();
  });

  it('respects line of sight and ignores vehicle occupants', () => {
    const { patrol, spots } = makePatrol({ los: true });
    patrol.update(0.001, player({ x: 9999, z: 9999, onFoot: false }));
    let here = patrol.position;
    patrol.update(0.001, player({ x: here.x + 5, z: here.z }));
    expect(spots).toEqual([]); // wall between them
    patrol.dispose();

    const drive = makePatrol({ los: false });
    drive.patrol.update(0.001, player({ x: 9999, z: 9999, onFoot: false }));
    here = drive.patrol.position;
    drive.patrol.update(0.001, player({ x: here.x + 5, z: here.z, onFoot: false }));
    expect(drive.spots).toEqual([]); // driving is ignored
    drive.patrol.dispose();
  });

  it('loses interest after the search window and lets the evade credit back', () => {
    const { patrol } = makePatrol();
    patrol.update(0.001, player({ x: 9999, z: 9999, onFoot: false }));
    const here = patrol.position;
    patrol.update(0.001, player({ x: here.x + 10, z: here.z }));
    expect(patrol.searching).toBe(true);
    // Break sight for longer than the hunt window.
    for (let i = 0; i < 13; i++) patrol.update(1, player({ x: 0, z: 0, crouched: true }));
    expect(patrol.searching).toBe(false);
    expect(patrol.creditsEvade()).toBe(true);
    expect(patrol.timesSpotted).toBe(1); // history is not erased
    patrol.dispose();
  });

  it('hunts toward the last sighting while searching', () => {
    const { patrol } = makePatrol();
    patrol.update(0.001, player({ x: 9999, z: 9999, onFoot: false }));
    const start = patrol.position;
    const target = { x: start.x + 14, z: start.z };
    patrol.update(0.001, player(target));
    const before = patrol.position;
    // Player breaks sight but stays at the same spot; patrol closes in.
    for (let i = 0; i < 4; i++) {
      patrol.update(0.5, player({ x: 9999, z: 9999, onFoot: false }));
    }
    const closed = Math.hypot(patrol.position.x - target.x, patrol.position.z - target.z);
    const initialGap = Math.hypot(before.x - target.x, before.z - target.z);
    expect(closed).toBeLessThan(initialGap);
    patrol.dispose();
  });

  it('clears the hunt when toggled off and on', () => {
    const { patrol } = makePatrol();
    patrol.update(0.001, player({ x: 9999, z: 9999, onFoot: false }));
    const here = patrol.position;
    patrol.update(0.001, player({ x: here.x + 10, z: here.z }));
    expect(patrol.searching).toBe(true);
    patrol.active = false;
    expect(patrol.searching).toBe(false);
    patrol.active = true;
    expect(patrol.searching).toBe(false);
    patrol.dispose();
  });
});
