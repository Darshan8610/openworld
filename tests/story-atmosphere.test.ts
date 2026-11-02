import { describe, expect, it } from 'vitest';
import { StoryAtmosphere } from '../src/story/atmosphere';
import { CAMPAIGN, withinBounds } from '../src/story/campaign';

function makeAtmosphere() {
  return new StoryAtmosphere({
    ground: () => 12,
    roadZ: () => -50,
    bounds: CAMPAIGN.bounds,
    diner: { x: CAMPAIGN.landmarks[0]!.x, z: CAMPAIGN.landmarks[0]!.z },
    motel: { x: CAMPAIGN.landmarks[1]!.x, z: CAMPAIGN.landmarks[1]!.z },
  });
}

describe('story atmosphere (night dressing)', () => {
  it('builds wrecks, signs, beacon and coast reflectors inside the zone', () => {
    const atmosphere = makeAtmosphere();
    expect(atmosphere.group.children.length).toBeGreaterThanOrEqual(16);
    // Every dressing anchor stays inside the campaign bounds.
    atmosphere.group.traverse((object) => {
      expect(withinBounds(object.position.x, object.position.z, CAMPAIGN.bounds, 120)).toBe(true);
    });
    atmosphere.dispose();
    expect(atmosphere.group.children.length).toBe(0);
  });

  it('blinks hazards alternately and keeps signs mostly lit', () => {
    const atmosphere = makeAtmosphere();
    // Sample the pure blink envelope across a full hazard cycle.
    const clock = atmosphere as unknown as { clock: number };
    const hazardA = { phase: 0, rate: 1.1, style: 'hazard' as const };
    const hazardB = { phase: 1, rate: 1.1, style: 'hazard' as const };
    let aOn = 0; let bOn = 0; let both = 0;
    for (let t = 0; t < 4; t += 0.05) {
      clock.clock = t;
      const levelA = atmosphere.levelFor(hazardA);
      const levelB = atmosphere.levelFor(hazardB);
      if (levelA > 1) aOn++;
      if (levelB > 1) bOn++;
      if (levelA > 1 && levelB > 1) both++;
    }
    expect(aOn).toBeGreaterThan(20);
    expect(bOn).toBeGreaterThan(20);
    expect(both).toBe(0); // strictly alternating
    // Signs never fully die in a normal window.
    const sign = { phase: 0, rate: 7, style: 'sign' as const };
    for (let t = 0; t < 20; t += 0.25) {
      clock.clock = t;
      expect(atmosphere.levelFor(sign)).toBeGreaterThan(0.2);
    }
    atmosphere.dispose();
  });

  it('update advances the shared clock without throwing on empty groups', () => {
    const atmosphere = makeAtmosphere();
    atmosphere.update(0.016);
    atmosphere.update(0.016);
    atmosphere.update(0); // ignored
    atmosphere.update(-5); // ignored
    atmosphere.dispose();
    atmosphere.update(1); // disposed group is inert
    expect(atmosphere.group.children.length).toBe(0);
  });
});
