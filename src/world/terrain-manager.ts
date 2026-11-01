import { Group, BufferGeometry, BufferAttribute, Mesh, Box3, Vector3, Sphere } from 'three/webgpu';
import type { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import { createTerrainMaterial } from '../rendering/terrain-material';
import { TerrainPool } from './terrain-pool';
import { selectTiles, tileSize, tileKey, rootKey, distanceToTile, makeTile } from './tiles';
import type { TileCoord, TileResult } from './tiles';
import type { FloatingOrigin } from '../core/floating-origin';
import { clamp } from '../utils/math';

export interface TerrainTile {
  coord: TileCoord;
  mesh: Mesh;
  surface: MeshStandardNodeMaterial;
  diagnostic: MeshBasicNodeMaterial;
  biomeMaterial: MeshBasicNodeMaterial;
  vegetation: Float32Array;
  segments: number;
  used: number;
  bounds: Box3;
}
interface RootGeneration { tiles: Map<string, TileCoord>; complete: boolean }

/**
 * Quadtree LOD with atomic root replacements. Old terrain remains visible until
 * every replacement leaf is ready, so movement never exposes an unloaded hole.
 */
export class TerrainManager {
  readonly group = new Group();
  readonly material = createTerrainMaterial();
  private pool: TerrainPool;
  private readonly cache = new Map<string, TerrainTile>();
  private readonly visible = new Map<string, TerrainTile>();
  private readonly roots = new Map<string, RootGeneration>();
  private readonly inflight = new Set<string>();
  private epoch = 0;
  private elapsed: number = CONFIG.terrain.updateInterval;
  private frame = 0;
  private debugEnabled = false;
  private debugMode: 'off' | 'lod' | 'biome' = 'off';
  revision = 0;
  private disposed = false;
  wanted = 0;
  ready = 0;
  generated = 0;
  lastError: Error | undefined;

  constructor(
    private readonly origin: FloatingOrigin,
    public seed: string,
    public quality: QualityName,
    private readonly onError: (error: Error) => void,
  ) {
    this.group.name = 'Streamed terrain';
    this.pool = new TerrainPool(QUALITY[quality].workers, onError);
  }

  private createTile(result: TileResult): TerrainTile {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(result.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(result.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(result.colors, 3));
    geometry.setAttribute('surface', new BufferAttribute(result.surface, 3));
    geometry.setIndex(new BufferAttribute(result.indices, 1));
    const size = tileSize(result.coord.level);
    const center = new Vector3(
      (result.coord.x + 0.5) * size - this.origin.absolute.x,
      -this.origin.absolute.y,
      (result.coord.z + 0.5) * size - this.origin.absolute.z,
    );
    const midY = (result.minHeight + result.maxHeight) / 2;
    const half = new Vector3(size / 2, (result.maxHeight - result.minHeight) / 2, size / 2);
    geometry.boundingBox = new Box3(new Vector3(-size / 2, result.minHeight, -size / 2), new Vector3(size / 2, result.maxHeight, size / 2));
    geometry.boundingSphere = new Sphere(new Vector3(0, midY, 0), half.length());
    const surface = this.material.createTileMaterial(result.coord.level, false);
    const diagnostic = this.material.createTileMaterial(result.coord.level, true);
    const biomeMaterial = this.material.createTileMaterial(result.coord.level, 'biome');
    const mesh = new Mesh(geometry, this.debugMode === 'biome' ? biomeMaterial : this.debugEnabled ? diagnostic : surface);
    mesh.name = `terrain ${result.key}`;
    mesh.position.copy(center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { coord: result.coord, mesh, surface, diagnostic, biomeMaterial, vegetation: result.vegetation, segments: result.segments, used: this.frame, bounds: new Box3() };
  }

  update(position: Vector3, dt: number): void {
    if (this.disposed) return;
    this.frame++;
    this.lastPosition.copy(position);
    this.elapsed += dt;
    if (this.elapsed >= CONFIG.terrain.updateInterval) {
      this.elapsed = 0;
      this.refreshDesired(position);
    }
    this.material.setOrigin(this.origin.absolute.x, this.origin.absolute.z);
    for (const tile of this.visible.values()) {
      const size = tileSize(tile.coord.level);
      const distance = distanceToTile(tile.coord, position.x, position.z);
      // Children enter fully morphed to their parent, then gradually gain detail.
      // Exact shared border heights + vertical skirts hide LOD T-junctions.
      tile.mesh.visible = distance < QUALITY[this.quality].viewDistance + size * 0.8;
      tile.used = this.frame;
      // Three frustum-culls the explicit geometry.boundingSphere set above.
    }
    this.evict();
  }

  private refreshDesired(position: Vector3): void {
    const desired = selectTiles(position.x, position.z, QUALITY[this.quality].rootRadius);
    const groups = new Map<string, TileCoord[]>();
    this.wanted = desired.length;
    this.ready = 0;
    for (const coord of desired) {
      const root = rootKey(coord);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(coord);
      if (this.cache.has(tileKey(coord))) this.ready++;
    }
    this.roots.clear();
    for (const [root, tiles] of groups) {
      const keys = new Set(tiles.map(tileKey));
      const alreadyVisible = [...this.visible.entries()].filter(([, tile]) => rootKey(tile.coord) === root);
      const complete = alreadyVisible.length === keys.size && alreadyVisible.every(([key]) => keys.has(key));
      this.roots.set(root, { tiles: new Map(tiles.map((t) => [tileKey(t), t])), complete });
    }
    const requests = desired.filter((t) => !this.cache.has(tileKey(t)) && !this.inflight.has(tileKey(t)));
    requests.sort((a, b) => {
      const priority = (t: TileCoord) => distanceToTile(t, position.x, position.z) - t.level * 180;
      return priority(a) - priority(b);
    });
    for (const coord of requests) this.request(coord, position);
    this.commitRoots();
  }

  private request(coord: TileCoord, position: Vector3): void {
    const key = tileKey(coord), epoch = this.epoch;
    this.inflight.add(key);
    this.pool.request({
      type: 'generate', epoch, seed: this.seed,
      ...coord, segments: QUALITY[this.quality].segments,
    }, distanceToTile(coord, position.x, position.z) - coord.level * 180).then((response) => {
      this.inflight.delete(key);
      if (this.disposed || epoch !== this.epoch) return;
      if (response.type === 'error') throw new Error(response.message);
      const tile = this.createTile(response);
      this.cache.set(key, tile);
      this.generated++;
      this.commitRoots();
    }).catch((error: unknown) => {
      this.inflight.delete(key);
      if (!this.disposed && epoch === this.epoch && error instanceof Error && error.message !== 'Cancelled') {
        this.lastError = error;
        // Retry once on a subsequent selection pass rather than dropping the tile forever.
      }
    });
  }

  private commitRoots(): void {
    for (const [root, generation] of this.roots) {
      if (generation.complete) continue;
      const tiles = [...generation.tiles.values()];
      if (!tiles.every((t) => this.cache.has(tileKey(t)))) continue;
      for (const [key, tile] of this.visible) if (rootKey(tile.coord) === root) this.removeVisible(key);
      for (const coord of tiles) {
        const key = tileKey(coord), tile = this.cache.get(key)!;
        this.visible.set(key, tile);
        this.group.add(tile.mesh);
      }
      generation.complete = true;
      this.revision++;
    }
    // Retire roots well outside the new window; fog conceals the outer boundary.
    for (const [key, tile] of this.visible) {
      if (!this.roots.has(rootKey(tile.coord))) {
        const rootBounds = makeTile(tile.coord.rootX, tile.coord.rootZ, 0);
        if (distanceToTile(rootBounds, this.lastPosition.x, this.lastPosition.z) > QUALITY[this.quality].viewDistance) this.removeVisible(key);
      }
    }
  }

  private readonly lastPosition = new Vector3();


  /** Visible source records for the vegetation packer; ownership stays here. */
  get activeTiles(): IterableIterator<TerrainTile> { return this.visible.values(); }

  private removeVisible(key: string): void {
    const tile = this.visible.get(key);
    if (tile) this.group.remove(tile.mesh);
    this.visible.delete(key);
    this.revision++;
  }

  private evict(): void {
    if (this.cache.size <= CONFIG.terrain.cacheLimit) return;
    const candidates = [...this.cache.entries()]
      .filter(([key]) => !this.visible.has(key) && !this.inflight.has(key) && ![...this.roots.values()].some((r) => !r.complete && r.tiles.has(key)))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key, tile] of candidates) {
      this.group.remove(tile.mesh);
      this.disposeTile(tile);
      this.cache.delete(key);
      if (this.cache.size <= CONFIG.terrain.cacheLimit * 0.9) break;
    }
  }

  /** Finest visible tile lookup; bounded by the streaming window, no noise on RAF. */
  heightAt(x: number, z: number): number | undefined {
    let best: TerrainTile | undefined;
    for (const tile of this.visible.values()) {
      const size = tileSize(tile.coord.level);
      if (x >= tile.coord.x * size && x <= (tile.coord.x + 1) * size && z >= tile.coord.z * size && z <= (tile.coord.z + 1) * size) {
        if (!best || tile.coord.level > best.coord.level) best = tile;
      }
    }
    if (!best) return undefined;
    const size = tileSize(best.coord.level), n = best.segments;
    const fx = clamp((x / size - best.coord.x) * n, 0, n - 0.00001);
    const fz = clamp((z / size - best.coord.z) * n, 0, n - 0.00001);
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
    const positions = best.mesh.geometry.getAttribute('position').array;
    const h = (a: number, b: number) => positions[(b * (n + 1) + a) * 3 + 1]!;
    return u + v <= 1 ? h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * u + (h(ix, iz + 1) - h(ix, iz)) * v
      : h(ix + 1, iz + 1) + (h(ix, iz + 1) - h(ix + 1, iz + 1)) * (1 - u) + (h(ix + 1, iz) - h(ix + 1, iz + 1)) * (1 - v);
  }

  /** HUD lookup from uploaded worker data; no climate noise on the main thread. */
  biomeAt(x: number, z: number): number {
    let best: TerrainTile | undefined;
    for (const tile of this.visible.values()) {
      const size = tileSize(tile.coord.level);
      if (x >= tile.coord.x * size && x <= (tile.coord.x + 1) * size && z >= tile.coord.z * size && z <= (tile.coord.z + 1) * size) {
        if (!best || tile.coord.level > best.coord.level) best = tile;
      }
    }
    if (!best) return 0;
    const n = best.segments, size = tileSize(best.coord.level);
    const ix = Math.round(clamp((x / size - best.coord.x) * n, 0, n));
    const iz = Math.round(clamp((z / size - best.coord.z) * n, 0, n));
    return best.mesh.geometry.getAttribute('surface').array[(iz * (n + 1) + ix) * 3 + 2]!;
  }

  rebase(delta: Vector3): void { for (const tile of this.cache.values()) tile.mesh.position.sub(delta); }

  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
    this.debugMode = enabled ? 'lod' : 'off';
    this.applyMaterial();
  }
  setBiomeDebug(enabled: boolean): void {
    this.debugMode = enabled ? 'biome' : 'off';
    this.debugEnabled = false;
    this.applyMaterial();
  }
  get biomeDebug(): boolean { return this.debugMode === 'biome'; }
  private applyMaterial(): void {
    for (const tile of this.cache.values()) tile.mesh.material = this.debugMode === 'biome' ? tile.biomeMaterial : this.debugEnabled ? tile.diagnostic : tile.surface;
  }
  get debug(): boolean { return this.debugEnabled; }
  setWireframe(enabled: boolean): void {
    this.material.setWireframe(enabled);
    for (const tile of this.cache.values()) { tile.surface.wireframe = enabled; tile.diagnostic.wireframe = enabled; tile.biomeMaterial.wireframe = enabled; }
  }

  reset(seed: string, quality: QualityName): void {
    this.epoch++;
    this.seed = seed;
    if (QUALITY[quality].workers !== QUALITY[this.quality].workers) {
      this.pool.dispose();
      this.pool = new TerrainPool(QUALITY[quality].workers, this.onError);
    } else this.pool.cancelPending();
    this.quality = quality;
    this.inflight.clear();
    for (const tile of this.cache.values()) { this.group.remove(tile.mesh); this.disposeTile(tile); }
    this.cache.clear(); this.visible.clear(); this.roots.clear();
    this.wanted = 0; this.ready = 0; this.elapsed = CONFIG.terrain.updateInterval;
    this.lastError = undefined;
    this.revision++;
  }

  get stats() {
    let triangles = 0;
    for (const tile of this.visible.values()) if (tile.mesh.visible) triangles += tile.mesh.geometry.index!.count / 3;
    return { cached: this.cache.size, visible: this.visible.size, pending: this.pool.pending, triangles, generated: this.generated };
  }

  dispose(): void {
    this.disposed = true;
    this.pool.dispose();
    for (const tile of this.cache.values()) { this.group.remove(tile.mesh); this.disposeTile(tile); }
    this.cache.clear(); this.visible.clear(); this.roots.clear();
    this.material.dispose();
  }

  private disposeTile(tile: TerrainTile): void {
    tile.mesh.geometry.dispose(); tile.surface.dispose(); tile.diagnostic.dispose(); tile.biomeMaterial.dispose();
  }
}
