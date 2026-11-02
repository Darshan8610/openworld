import { describe, expect, it } from 'vitest';
import { TerrainField } from '../src/world/terrain-field';
import { BuoyancySolver } from '../src/physics/buoyancy';
import { PropPhysicsWorld } from '../src/physics/prop-physics';
import { boxShape } from '../src/physics/rigid-body';
import type { GroundContact } from '../src/physics/rigid-body';
import { WorldQueries } from '../src/world/world-queries';
import { CharacterMotion } from '../src/character/locomotion';
import { CONFIG } from '../src/config';

/**
 * End-to-end use of the *real* hydrology: no stubbed water field, no synthetic
 * slope. A crate is dropped into the nearest real body and must float on the
 * surface the query reports, and a character walking into that same water must
 * enter swim mode. If the water field, the solver and the character query ever
 * disagree, this fails.
 */

const STEP = 1 / 120;
const field = new TerrainField('phase9-smoke');

/** Nearest body deeper than `minDepth`, found on a deterministic lattice scan. */
function deepWater(minDepth: number): { x: number; z: number; surfaceY: number; depth: number; bodyId: string } {
  for (let ring = 0; ring <= 40; ring++) {
    const radius = ring * 220;
    const steps = ring === 0 ? 1 : Math.max(8, ring * 8);
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      const sample = field.water.sampleAt(x, z);
      if (sample && sample.depth >= minDepth) {
        return { x, z, surfaceY: sample.surfaceY, depth: sample.depth, bodyId: sample.bodyId };
      }
    }
  }
  throw new Error('no deep water found near the origin');
}

const ground = (x: number, z: number, out: GroundContact): GroundContact => {
  out.height = field.height(x, z);
  out.nx = 0; out.ny = 1; out.nz = 0;
  out.surface = 'grass';
  return out;
};

describe('phase 9 on the real world', () => {
  const water = deepWater(2.5);

  it('finds a real body to test against', () => {
    expect(water.depth).toBeGreaterThan(2.5);
    expect(water.bodyId).toMatch(/^(lake|pond|reservoir|wetland|sea|river):/);
    // The bed is below the surface, and the terrain agrees with the sample.
    expect(field.height(water.x, water.z)).toBeLessThan(water.surfaceY);
  });

  it('floats a crate dropped into that body', () => {
    const physics = new PropPhysicsWorld({ maxBodies: 4, fixedStep: STEP });
    const solver = new BuoyancySolver(field.water);
    // Drop from ten metres up: it must enter, splash-report once, and settle.
    const splashPositions: number[] = [];
    solver.onEntry = (entry) => splashPositions.push(entry.y);
    physics.add({
      id: 'crate',
      position: { x: water.x, y: water.surfaceY + 10, z: water.z },
      shape: boxShape(0.45, 0.45, 0.45),
      material: 'wood',
    });
    physics.forceField = (body, dt) => solver.applyToPropBody(body, dt, 0);
    for (let i = 0; i < 120 * 12; i++) physics.step(STEP, ground);
    const crate = physics.get('crate')!;
    const surface = field.water.sampleAt(crate.position.x, crate.position.z)!.surfaceY;
    // Floating on the surface the query reports, not resting on the bed.
    expect(crate.position.y).toBeGreaterThan(surface - 0.8);
    expect(crate.position.y).toBeLessThan(surface + 0.8);
    expect(crate.position.y).toBeGreaterThan(field.height(crate.position.x, crate.position.z) + 0.5);
    // Exactly one waterline crossing was reported, at the surface.
    expect(splashPositions.length).toBe(1);
    expect(Math.abs(splashPositions[0]! - water.surfaceY)).toBeLessThan(2);
  });

  it('swims the character in that water', () => {
    const queries = new WorldQueries('phase9-smoke');
    const motion = new CharacterMotion(CONFIG.character);
    // Standing at the bed in water deeper than the swim threshold.
    const bed = field.height(water.x, water.z);
    motion.place(water.x, bed + 0.1, water.z);
    const swim = (x: number, z: number) => {
      const sample = queries.field.water.sampleAt(x, z);
      if (!sample) return undefined;
      return {
        surfaceY: sample.surfaceY,
        flowX: sample.flowX,
        flowZ: sample.flowZ,
        bedY: sample.surfaceY - sample.depth,
      };
    };
    const dry = { contact: () => undefined };
    let entered = false;
    for (let i = 0; i < 240; i++) {
      const result = motion.step(
        STEP,
        { x: 0, z: 0, speed: 0, sprint: false, crouch: false, jumpHeld: false, jumpPressed: false },
        dry,
        swim,
      );
      if (result.waterEntry) entered = true;
    }
    expect(entered).toBe(true);
    expect(motion.mode).toBe('swim');
    // The swimmer rises toward the surface and stays under it.
    expect(motion.position.y).toBeLessThan(water.surfaceY);
    expect(motion.position.y).toBeGreaterThan(water.surfaceY - Math.min(water.depth, CONFIG.character.swimFeetDepth + 1.5));
  });
});
