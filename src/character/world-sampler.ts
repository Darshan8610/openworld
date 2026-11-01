import { Vector3 } from 'three/webgpu';
import type { TerrainManager } from '../world/terrain-manager';
import type { CharacterSampler, GroundContact, WaterQuery } from './locomotion';

/**
 * Ground sampler backed by the existing streamed terrain.
 *
 * Heights come from the same interpolated triangles the renderer draws, so the
 * player walks on visible ground rather than on the smooth analytic field. When
 * terrain for that XZ is not streamed the sample is `undefined` and the motion
 * solver holds position instead of falling through the world.
 */
export class TerrainCharacterSampler implements CharacterSampler {
  constructor(private readonly terrain: TerrainManager) {}

  get ready(): boolean { return this.terrain.ready > 0; }

  contact(x: number, z: number, out: GroundContact): GroundContact | undefined {
    const height = this.terrain.heightAt(x, z);
    if (height === undefined) return undefined;
    out.height = height;
    out.biome = this.terrain.biomeAt(x, z);
    this.normal(x, z, out.normal);
    return out;
  }

  /** Central-difference normal over the streamed mesh; falls back to up. */
  normal(x: number, z: number, target: Vector3): Vector3 {
    const epsilon = 1.5;
    const xp = this.terrain.heightAt(x + epsilon, z);
    const xm = this.terrain.heightAt(x - epsilon, z);
    const zp = this.terrain.heightAt(x, z + epsilon);
    const zm = this.terrain.heightAt(x, z - epsilon);
    if (xp === undefined || xm === undefined || zp === undefined || zm === undefined) return target.set(0, 1, 0);
    return target.set(-(xp - xm) / (2 * epsilon), 1, -(zp - zm) / (2 * epsilon)).normalize();
  }

  /** World-space ground height, for camera collision and spawn placement. */
  groundHeight(x: number, z: number): number | undefined { return this.terrain.heightAt(x, z); }
}

/**
 * No water bodies exist yet: lakes, rivers and oceans arrive in Phase 9, which
 * supplies a `WaterQuery` to the character system. Swimming itself is implemented
 * and unit-tested against a synthetic surface; only the world data is pending.
 * This is a real null provider, not a stub that pretends water exists.
 */
export const NO_WATER: WaterQuery = () => undefined;
