import { describe, expect, it } from 'vitest';
import { StoryCity } from '../src/story/city';
import { CAMPAIGN } from '../src/story/campaign';

function makeCity() {
  return new StoryCity({
    bounds: CAMPAIGN.bounds,
    ground: () => STORY_LEVEL,
    landmarks: CAMPAIGN.landmarks,
    arrival: CAMPAIGN.arrival,
    plateau: { height: STORY_LEVEL },
  });
}

const STORY_LEVEL = 46;

function instanceTotal(city: StoryCity): number {
  let total = 0;
  city.group.traverse((object) => {
    const mesh = object as { isInstancedMesh?: boolean; count?: number };
    if (mesh.isInstancedMesh) total += mesh.count ?? 0;
  });
  return total;
}

describe('Blackwood city district', () => {
  it('builds a full instanced street grid on the plateau', () => {
    const city = makeCity();
    // Streets, dashes, sidewalks, poles, lamps, buildings, neon — several
    // instanced meshes, all from primitives (no external assets).
    expect(city.group.children.length).toBeGreaterThanOrEqual(6);
    expect(instanceTotal(city)).toBeGreaterThan(200);
    city.dispose();
    expect(city.group.children.length).toBe(0);
    expect(instanceTotal(city)).toBe(0);
  });

  it('is deterministic: two builds produce identical layouts', () => {
    const a = makeCity();
    const b = makeCity();
    expect(a.group.children.length).toBe(b.group.children.length);
    expect(instanceTotal(a)).toBe(instanceTotal(b));
    a.dispose();
    b.dispose();
  });

  it('keeps the authored landmarks and arrival clear of city geometry', () => {
    // Landmark clearance is enforced at layout time: with the four plots and
    // the arrival excluded, the cell count stays stable whether or not they
    // are present — verify the exclusion directly by rebuilding without them.
    const full = makeCity();
    const stripped = new StoryCity({
      bounds: CAMPAIGN.bounds,
      ground: () => STORY_LEVEL,
      landmarks: [],
      arrival: { x: 99999, z: 99999 },
      plateau: { height: STORY_LEVEL },
    });
    // Removing clearance opens cells: the full city must place fewer things.
    expect(instanceTotal(full)).toBeLessThan(instanceTotal(stripped));
    full.dispose();
    stripped.dispose();
  });

  it('never paves the lookout hill (ground above the street level)', () => {
    const hill = new StoryCity({
      bounds: CAMPAIGN.bounds,
      ground: (x, z) => (Math.hypot(x - 176, z + 505) < 170 ? 95 : STORY_LEVEL),
      landmarks: CAMPAIGN.landmarks,
      arrival: CAMPAIGN.arrival,
      plateau: { height: STORY_LEVEL },
    });
    const flat = makeCity();
    // The hill suppresses streets/sidewalks there: fewer instances overall.
    expect(instanceTotal(hill)).toBeLessThan(instanceTotal(flat));
    hill.dispose();
    flat.dispose();
  });
});
