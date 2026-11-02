import { afterEach, describe, expect, it } from 'vitest';
import { TerrainField, currentTerrainPlateau, setTerrainPlateau } from '../src/world/terrain-field';
import { CAMPAIGN, STORY_PLATEAU } from '../src/story/campaign';

/**
 * The GTA-style flat district grades the whole valley floor to one street
 * level while the Radio Lookout keeps its hill for Act III's climb. The
 * infinite terrain stays intact: without a plateau the field is untouched.
 */
describe('campaign terrain plateau', () => {
  afterEach(() => setTerrainPlateau(null));

  it('starts inactive (sandbox behaviour unchanged)', () => {
    expect(currentTerrainPlateau()).toBeNull();
    const field = new TerrainField(CAMPAIGN.seed);
    const natural = field.height(0, -100);
    expect(natural).toBeGreaterThan(1); // real landform, not flattened
  });

  it('flattens the zone to the street level with a soft skirt', () => {
    setTerrainPlateau(STORY_PLATEAU);
    const field = new TerrainField(CAMPAIGN.seed);
    // Deep inside the zone: one continuous street level.
    for (const [x, z] of [[-400, -50], [-100, -300], [200, 100], [-550, 180]] as const) {
      expect(Math.abs(field.height(x, z) - STORY_PLATEAU.height)).toBeLessThan(1.5);
    }
    // Beyond the skirt the natural landform returns.
    const outside = field.height(CAMPAIGN.bounds.maxX + 400, CAMPAIGN.bounds.maxZ + 400);
    const natural = (() => { setTerrainPlateau(null); const h = field.height(CAMPAIGN.bounds.maxX + 400, CAMPAIGN.bounds.maxZ + 400); setTerrainPlateau(STORY_PLATEAU); return h; })();
    expect(Math.abs(outside - natural)).toBeLessThan(1);
  });

  it('preserves the Radio Lookout hill inside the keep-out', () => {
    setTerrainPlateau(STORY_PLATEAU);
    const field = new TerrainField(CAMPAIGN.seed);
    const tower = CAMPAIGN.landmarks[3]!;
    const towerHeight = field.height(tower.x, tower.z);
    // The lookout sits well above the street level for the switchback climb.
    expect(towerHeight).toBeGreaterThan(STORY_PLATEAU.height + 25);
    // And matches the untouched natural height (keep-out weight = 0).
    setTerrainPlateau(null);
    const naturalTower = field.height(tower.x, tower.z);
    expect(Math.abs(towerHeight - naturalTower)).toBeLessThan(0.5);
  });

  it('keeps water carve and roads consistent on the flat ground', () => {
    setTerrainPlateau(STORY_PLATEAU);
    const field = new TerrainField(CAMPAIGN.seed);
    // Graded height on the plateau equals the street level away from earthworks.
    const h = field.gradedHeight(-300, -400);
    expect(Math.abs(h - STORY_PLATEAU.height)).toBeLessThan(2);
  });
});
