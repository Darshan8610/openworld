import { Vector3 } from 'three/webgpu';
import type { CharacterSampler, GroundContact } from '../character/locomotion';
import type { WorldQueries } from '../world/world-queries';

/**
 * Ground sampler for NPCs.
 *
 * The player walks on the *streamed mesh* because that is what is visible under
 * their feet. NPCs use the same source when a tile is resident and fall back to
 * the analytic height field otherwise, so an NPC outside the current LOD ring is
 * still standing on solid ground instead of falling through the world. Normals,
 * biome and surface come from the shared query facade, so NPC footing never
 * disagrees with physics, props or footsteps.
 */
export interface NpcObstacleSource {
  /** True when something solid occupies this XZ (objects, buildings, vehicles). */
  blocked(x: number, z: number): boolean;
}

/** The slice of the terrain manager NPCs need (kept structural for tests). */
export interface NpcTerrainSource {
  heightAt(x: number, z: number): number | undefined;
  biomeAt(x: number, z: number): number;
}

export class NpcGroundSampler implements CharacterSampler {
  private readonly normal = new Vector3(0, 1, 0);

  constructor(
    private readonly queries: WorldQueries,
    private readonly obstacles?: NpcObstacleSource,
    private readonly terrain?: NpcTerrainSource,
  ) {}

  contact(x: number, z: number, out: GroundContact): GroundContact {
    const sample = this.queries.groundFast(x, z);
    const streamed = this.terrain?.heightAt(x, z);
    out.height = streamed ?? sample.height;
    out.biome = this.terrain?.biomeAt(x, z) ?? 0;
    this.normal.set(sample.nx, sample.ny, sample.nz);
    if (this.normal.y < 0.1) this.normal.set(0, 1, 0); else this.normal.normalize();
    out.normal.copy(this.normal);
    return out;
  }

  blocked(x: number, z: number): boolean {
    return this.obstacles?.blocked(x, z) === true;
  }

  /** Ground height for spawn/script placement. */
  height(x: number, z: number): number {
    return this.terrain?.heightAt(x, z) ?? this.queries.height(x, z);
  }
}
