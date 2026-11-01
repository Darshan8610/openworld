import { CONFIG } from '../config';
import { distanceToTile, tileSize } from '../world/tiles';
import type { TileCoord } from '../world/tiles';
import type { PhysicsBody, PhysicsWorld } from './physics-world';
import { TERRAIN_COLLIDER_MATERIAL } from './materials';

/**
 * The minimum tile shape the ground streamer needs. `TerrainManager.activeTiles`
 * satisfies it structurally, and tests supply hand-built tiles.
 */
export interface GroundTile {
  readonly coord: TileCoord;
  readonly segments: number;
  readonly mesh: { readonly geometry: { getAttribute(name: string): { array: ArrayLike<number> } }; readonly visible: boolean };
}

export interface GroundTileSource {
  readonly activeTiles: Iterable<GroundTile>;
  readonly revision: number;
}

export interface GroundStreamerOptions {
  radius?: number;
  minLevel?: number;
  maxTiles?: number;
  updateInterval?: number;
  buildsPerUpdate?: number;
}

export interface GroundStreamStats {
  tiles: number;
  vertices: number;
  builds: number;
  lastBuildMs: number;
  radius: number;
  budgetReached: boolean;
}

interface GroundEntry {
  body: PhysicsBody;
  source: GroundTile;
  vertices: number;
}

/**
 * Streams Rapier heightfield colliders that mirror the visible terrain tiles.
 *
 * The heightfield is built from the same worker-generated grid the renderer uses
 * (bilinear between grid samples), so physics ground and visual ground agree
 * along the whole tile. Colliders are fixed bodies in the physics-local frame:
 * floating-origin rebases translate them exactly like every other body, and the
 * grid never has to be rebuilt for an origin shift.
 */
export class PhysicsGroundStreamer {
  private readonly entries = new Map<string, GroundEntry>();
  private readonly physics: PhysicsWorld;
  private readonly source: GroundTileSource;
  private readonly options: Required<GroundStreamerOptions>;
  private readonly candidates: { tile: GroundTile; distance: number; key: string }[] = [];
  private elapsed: number;
  private revision = -1;
  private dirty = true;
  private builds = 0;
  private lastBuildMs = 0;
  private budgetReached = false;

  constructor(physics: PhysicsWorld, source: GroundTileSource, options: GroundStreamerOptions = {}) {
    this.physics = physics;
    this.source = source;
    this.options = {
      radius: options.radius ?? CONFIG.physics.ground.radius,
      minLevel: options.minLevel ?? CONFIG.physics.ground.minLevel,
      maxTiles: options.maxTiles ?? CONFIG.physics.ground.maxTiles,
      updateInterval: options.updateInterval ?? CONFIG.physics.ground.updateInterval,
      buildsPerUpdate: options.buildsPerUpdate ?? 4,
    };
    this.elapsed = this.options.updateInterval;
  }

  update(position: { x: number; y: number; z: number }, dt: number): void {
    this.elapsed += dt;
    const revisionChanged = this.revision !== this.source.revision;
    if (!this.dirty && !revisionChanged && this.elapsed < this.options.updateInterval) return;
    if (revisionChanged) this.revision = this.source.revision;
    this.elapsed = 0;
    this.refresh(position);
  }

  /** Force a rebuild on the next update (seed/quality change). */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Drop bookkeeping without touching the physics world. Used when an external
   * owner destroys every body (seed reset); rebuilding starts from an empty map
   * so no dead body handle is ever queried again.
   */
  forget(): void {
    this.entries.clear();
    this.revision = -1;
    this.dirty = true;
  }

  private refresh(position: { x: number; y: number; z: number }): void {
    this.candidates.length = 0;
    for (const tile of this.source.activeTiles) {
      if (tile.coord.level < this.options.minLevel) continue;
      if (!tile.mesh.visible) continue;
      const distance = distanceToTile(tile.coord, position.x, position.z);
      if (distance > this.options.radius) continue;
      this.candidates.push({ tile, distance, key: `${tile.coord.level}:${tile.coord.x}:${tile.coord.z}` });
    }
    this.candidates.sort((a, b) => a.distance - b.distance);
    const wanted = new Set<string>();
    this.budgetReached = this.candidates.length > this.options.maxTiles;
    for (let i = 0; i < Math.min(this.candidates.length, this.options.maxTiles); i++) {
      wanted.add(this.candidates[i]!.key);
    }
    // Drop colliders for tiles that left the window before building new ones, so
    // the body budget is never exceeded by a rebuild.
    for (const [key, entry] of this.entries) {
      if (wanted.has(key)) continue;
      this.physics.destroy(entry.body);
      this.entries.delete(key);
      this.dirty = true;
    }
    let built = 0;
    const started = now();
    for (const candidate of this.candidates) {
      if (built >= this.options.buildsPerUpdate) break;
      if (built > 0 && now() - started > CONFIG.physics.ground.maxRebuildMsPerFrame) break;
      if (wanted.has(candidate.key) === false) continue;
      const existing = this.entries.get(candidate.key);
      if (existing && existing.source === candidate.tile) continue;
      if (existing) {
        this.physics.destroy(existing.body);
        this.entries.delete(candidate.key);
      }
      const entry = this.build(candidate.tile);
      if (entry) {
        this.entries.set(candidate.key, entry);
        built += 1;
        this.builds += 1;
      }
    }
    this.lastBuildMs = now() - started;
    this.dirty = built > 0 || this.pendingWanted(wanted);
  }

  private pendingWanted(wanted: Set<string>): boolean {
    for (const key of wanted) if (!this.entries.has(key)) return true;
    return false;
  }

  private build(tile: GroundTile): GroundEntry | undefined {
    const segments = tile.segments;
    if (!Number.isFinite(segments) || segments <= 0) return undefined;
    const stride = segments + 1;
    const gridSize = stride * stride;
    const positionAttribute = tile.mesh.geometry.getAttribute('position');
    const array = positionAttribute.array;
    if (array.length < gridSize * 3) return undefined;
    const heights = new Float32Array(gridSize);
    // Terrain grids are z-major (`iz * stride + ix`); Rapier heightfields are
    // x-major (`ix * (nrows + 1) + iz`), so the grid is transposed on the way in.
    // Verified against the rendered mesh in tests/physics-ground.test.ts.
    for (let iz = 0; iz < stride; iz++) {
      for (let ix = 0; ix < stride; ix++) {
        heights[ix * stride + iz] = array[(iz * stride + ix) * 3 + 1]!;
      }
    }
    const size = tileSize(tile.coord.level);
    const centreX = (tile.coord.x + 0.5) * size;
    const centreZ = (tile.coord.z + 0.5) * size;
    const body = this.physics.createBody({
      kind: 'fixed',
      position: { x: centreX, y: 0, z: centreZ },
      entityId: `terrain-ground:${tile.coord.level}:${tile.coord.x}:${tile.coord.z}`,
    });
    if (!body) return undefined;
    const collider = this.physics.addCollider(body, {
      type: 'heightfield',
      nrows: segments,
      ncols: segments,
      heights,
      scale: { x: size, y: 1, z: size },
    }, {
      material: TERRAIN_COLLIDER_MATERIAL,
      layer: 'terrain',
    });
    if (!collider) {
      this.physics.destroy(body);
      return undefined;
    }
    return { body, source: tile, vertices: gridSize };
  }

  get stats(): GroundStreamStats {
    let vertices = 0;
    for (const entry of this.entries.values()) vertices += entry.vertices;
    return {
      tiles: this.entries.size,
      vertices,
      builds: this.builds,
      lastBuildMs: this.lastBuildMs,
      radius: this.options.radius,
      budgetReached: this.budgetReached,
    };
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.physics.destroy(entry.body);
    this.entries.clear();
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
