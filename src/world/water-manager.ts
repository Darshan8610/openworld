import { BufferAttribute, BufferGeometry, Group, Mesh, Vector3 } from 'three/webgpu';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import type { FloatingOrigin } from '../core/floating-origin';
import type { WaterSample } from './water-field';
import type { WaterQuery } from './world-query';
import { createWaterSample } from './water-field';
import type { WaterField } from './water-field';
import { createWaterMaterial, waterPhaseAt } from '../rendering/water-material';
import type { WaterMaterial } from '../rendering/water-material';

/** Water surface tile level, chosen from the tile ring around the player. */
export type WaterTileLevel = 0 | 1 | 2;

export interface WaterTile {
  readonly tx: number;
  readonly tz: number;
  level: WaterTileLevel;
  mesh?: Mesh;
  /** Canonical world origin of the tile (mesh position is this minus the origin). */
  readonly x: number;
  readonly z: number;
  /** Distinct water bodies this tile draws (stats + audio + gameplay). */
  bodies: string[];
}

export interface WaterStats {
  tiles: number;
  emptyTiles: number;
  triangles: number;
  budget: number;
  truncated: boolean;
  bodiesNear: number;
  underwater: boolean;
  builds: number;
  buildMs: number;
  enabled: boolean;
}

/**
 * Streams the water surface around the player.
 *
 * Every vertex is sampled from `WaterField`, so the drawn surface *is* the query
 * result: there is no second water representation to fall out of sync, no
 * floating meshes where the query says "dry", and shoreline depth reaches zero
 * exactly where the terrain meets the waterline.
 *
 * Tiles are canonical world-space objects positioned relative to the floating
 * origin; a rebase only shifts meshes, never rebuilds geometry. Geometry is
 * rebuilt only when the player crosses a tile ring (LOD) boundary, and building
 * is time-budgeted per frame so streaming never spikes the render loop.
 */
export class WaterManager {
  readonly group = new Group();
  material: WaterMaterial;
  private readonly tiles = new Map<string, WaterTile>();
  private readonly sample: WaterSample = createWaterSample();
  private readonly lastPosition = new Vector3(Infinity, Infinity, Infinity);
  private quality: QualityName;
  private elapsed: number = CONFIG.water.updateInterval;
  private dirty = true;
  private enabled = true;
  private disposed = false;
  private truncated = false;
  private bodiesNear = 0;
  private underwater = false;
  private clock = 0;
  private builds = 0;
  private buildMs = 0;
  private readonly bodiesSeen = new Set<string>();
  /** Tiles known to contain no water, so the probes are not repeated. */
  private readonly dryTiles = new Set<string>();

  constructor(
    private readonly field: WaterField,
    private readonly origin: FloatingOrigin,
    quality: QualityName,
  ) {
    this.quality = quality;
    this.group.name = 'Phase 9 / water surfaces';
    this.material = createWaterMaterial({ detail: QUALITY[quality].waterDetail });
  }

  get isEnabled(): boolean { return this.enabled; }
  get isUnderwater(): boolean { return this.underwater; }
  get seaState(): number { return this.field.seaState; }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
    if (enabled) this.dirty = true;
  }

  /** Water at a canonical position (delegates to the authoritative field). */
  sampleAt(x: number, z: number, out: WaterSample = createWaterSample()): WaterSample | undefined {
    return this.field.sampleAt(x, z, out);
  }

  /** Water surface elevation including waves, or undefined on dry land. */
  surfaceAt(x: number, z: number, time: number): number | undefined {
    return this.field.displacedSurface(x, z, time);
  }

  /**
   * World-query shaped water answer (canonical metres), used by `WorldQuery` so
   * that every gameplay system asks one authority. Allocates one small record per
   * hit; the physics hot path calls `WaterField.sampleAt` directly instead.
   */
  query(x: number, z: number): WaterQuery | undefined {
    const sample = this.field.sampleAt(x, z, this.scratchSample);
    if (!sample) return undefined;
    return {
      bodyId: sample.bodyId,
      surfaceHeight: sample.surfaceY,
      depth: sample.depth,
      flowX: sample.flowX,
      flowZ: sample.flowZ,
      kind: sample.kind,
      waveAmplitude: sample.waveAmplitude,
      shoreline: sample.shore,
    };
  }

  /**
   * Swimming query for the character controller: the *displaced* surface, so the
   * swimmer rides the waves that are drawn, and the current that pushes them.
   */
  swimQuery = (x: number, z: number): {
    surfaceY: number; flowX: number; flowZ: number; bedY: number;
  } | undefined => {
    const sample = this.field.sampleAt(x, z, this.scratchSample);
    if (!sample) return undefined;
    const surfaceY = sample.surfaceY + this.field.waveOffset(
      x, z, this.clock, sample.waveAmplitude, sample.depth,
    );
    return {
      surfaceY,
      flowX: sample.flowX,
      flowZ: sample.flowZ,
      // The carved bed: swimming down stops here instead of clipping the terrain.
      bedY: sample.surfaceY - sample.depth,
    };
  };

  /**
   * True when a camera at this canonical position is inside a water body. Used
   * for the underwater fog/tint and to keep the audio bus dry.
   */
  isUnderwaterAt(x: number, y: number, z: number, time: number): boolean {
    const sample = this.field.sampleAt(x, z, this.scratchSample);
    if (!sample) return false;
    const surface = sample.surfaceY + this.field.waveOffset(x, z, time, sample.waveAmplitude, sample.depth);
    return y < surface;
  }

  private readonly scratchSample: WaterSample = createWaterSample();

  update(dt: number, position: Vector3, cameraPosition: Vector3, time: number): void {
    if (this.disposed) return;
    this.clock = time;
    this.group.visible = this.enabled;
    this.material.setTime(time);
    this.underwater = this.enabled && this.isUnderwaterAt(cameraPosition.x, cameraPosition.y, cameraPosition.z, time);
    if (!this.enabled) return;
    this.elapsed += dt;
    const moved = this.lastPosition.distanceToSquared(position) > 8 * 8;
    if (!this.dirty && !moved && this.elapsed < CONFIG.water.updateInterval) return;
    this.elapsed = 0;
    this.dirty = false;
    this.lastPosition.copy(position);
    this.stream(position);
  }

  /** Re-anchor tiles after a floating-origin shift (geometry is never rebuilt). */
  rebase(): void {
    for (const tile of this.tiles.values()) {
      if (!tile.mesh) continue;
      tile.mesh.position.set(tile.x - this.origin.absolute.x, 0, tile.z - this.origin.absolute.z);
    }
  }

  setQuality(quality: QualityName): void {
    if (quality === this.quality) return;
    this.quality = quality;
    const detail = QUALITY[quality].waterDetail;
    const previous = this.material;
    this.material = createWaterMaterial({ detail });
    for (const tile of this.tiles.values()) {
      if (!tile.mesh) continue;
      tile.mesh.material = this.material.material;
    }
    previous.dispose();
    this.clear();
    this.dirty = true;
  }

  get stats(): WaterStats {
    let triangles = 0, empty = 0;
    for (const tile of this.tiles.values()) {
      if (!tile.mesh) { empty++; continue; }
      triangles += (tile.mesh.geometry.index?.count ?? 0) / 3;
    }
    return {
      tiles: this.tiles.size - empty,
      emptyTiles: empty,
      triangles,
      budget: QUALITY[this.quality].waterTiles,
      truncated: this.truncated,
      bodiesNear: this.bodiesNear,
      underwater: this.underwater,
      builds: this.builds,
      buildMs: this.buildMs,
      enabled: this.enabled,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.material.dispose();
  }

  private clear(): void {
    for (const tile of this.tiles.values()) {
      if (!tile.mesh) continue;
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
    }
    this.tiles.clear();
  }

  private levelFor(ring: number): WaterTileLevel {
    return ring <= 2 ? 0 : ring <= 5 ? 1 : 2;
  }

  private stream(position: Vector3): void {
    const size = CONFIG.water.tileSize;
    const radius = QUALITY[this.quality].waterRadius;
    const budget = QUALITY[this.quality].waterTiles;
    const ctx = Math.floor(position.x / size), ctz = Math.floor(position.z / size);
    const reach = Math.ceil(radius / size);
    const started = now();
    this.builds = 0;
    this.truncated = false;
    this.bodiesSeen.clear();

    // Nearest-first so the budget always spends on what the player can see.
    const wanted: { tx: number; tz: number; ring: number }[] = [];
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dz));
      const cx = (ctx + dx + 0.5) * size, cz = (ctz + dz + 0.5) * size;
      if (Math.hypot(cx - position.x, cz - position.z) > radius) continue;
      wanted.push({ tx: ctx + dx, tz: ctz + dz, ring });
    }
    wanted.sort((a, b) => a.ring - b.ring);
    const active = new Set<string>();

    // Dry tiles are remembered separately, so an empty continent cannot eat the
    // mesh budget and starve a lake two tiles away. The set is bounded and FIFO.
    const dry = this.dryTiles;
    for (const entry of wanted) {
      const key = `${entry.tx}:${entry.tz}`;
      active.add(key);
      const level = this.levelFor(entry.ring);
      const existing = this.tiles.get(key);
      if (existing) {
        if (existing.level !== level && now() - started < 5) {
          this.build(existing, level);
          this.builds++;
        }
        continue;
      }
      if (this.tiles.size >= budget) { this.truncated = true; continue; }
      if (now() - started > 4) continue;
      if (dry.has(key)) continue;
      const tile: WaterTile = {
        tx: entry.tx, tz: entry.tz, level,
        x: entry.tx * size, z: entry.tz * size,
        bodies: [],
      };
      if (this.build(tile, level)) { this.tiles.set(key, tile); this.builds++; }
      else {
        this.rememberDry(key);
        if (tile.mesh) { this.group.remove(tile.mesh); tile.mesh.geometry.dispose(); }
      }
    }

    for (const [key, tile] of this.tiles) {
      if (active.has(key)) continue;
      if (tile.mesh) { this.group.remove(tile.mesh); tile.mesh.geometry.dispose(); }
      this.tiles.delete(key);
    }
    this.buildMs = now() - started;
    this.bodiesSeen.clear();
    for (const tile of this.tiles.values()) for (const id of tile.bodies) this.bodiesSeen.add(id);
    this.bodiesNear = this.bodiesSeen.size;
  }

  /** Bound the dry-tile memo so it cannot grow without limit. */
  private rememberDry(key: string): void {
    const dry = this.dryTiles;
    dry.add(key);
    if (dry.size <= CONFIG.water.dryTileLimit) return;
    const oldest = dry.values().next();
    if (!oldest.done) dry.delete(oldest.value);
  }

  /**
   * Build (or rebuild) one tile. Returns false when the tile contains no water,
   * which is remembered as a mesh-less tile so the probes are not repeated.
   */
  private build(tile: WaterTile, level: WaterTileLevel): boolean {
    const segments = QUALITY[this.quality].waterSegments[level]!;
    const size = CONFIG.water.tileSize;
    const stride = segments + 1;
    const step = size / segments;
    const count = stride * stride;
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count * 3);
    const amplitudes = new Float32Array(count);
    const depths = new Float32Array(count);
    const wet = new Uint8Array(count);
    let anyWet = 0;
    const bodies: string[] = [];
    const phase = new Vector3();

    for (let iz = 0; iz < stride; iz++) for (let ix = 0; ix < stride; ix++) {
      const index = iz * stride + ix;
      const x = tile.x + ix * step, z = tile.z + iz * step;
      const sample = this.field.sampleAt(x, z, this.sample);
      // Local vertex position keeps f32 precision safe near the origin.
      positions[index * 3] = ix * step - size / 2;
      positions[index * 3 + 2] = iz * step - size / 2;
      if (!sample) {
        // A dry vertex sits on the local water plane, a hair below it, so a quad
        // that spans the bank stays horizontal and the terrain cuts it along the
        // real shoreline. Without a nearby body it is buried under the ground,
        // where it can never be seen.
        wet[index] = 0;
        const near = this.field.surfaceNear(x, z);
        positions[index * 3 + 1] = near === undefined
          ? this.field.groundAt(x, z) - 1
          : near - 0.05;
        continue;
      }
      wet[index] = 1;
      anyWet++;
      if (!bodies.includes(sample.bodyId)) bodies.push(sample.bodyId);
      positions[index * 3 + 1] = sample.surfaceY;
      depths[index] = sample.depth;
      amplitudes[index] = sample.waveAmplitude;
      waterPhaseAt(x, z, phase);
      phases[index * 3] = phase.x;
      phases[index * 3 + 1] = phase.y;
      phases[index * 3 + 2] = phase.z;
    }

    tile.bodies = bodies;
    if (anyWet === 0) {
      if (tile.mesh) { this.group.remove(tile.mesh); tile.mesh.geometry.dispose(); tile.mesh = undefined; }
      tile.level = level;
      return false;
    }

    const indices: number[] = [];
    for (let iz = 0; iz < segments; iz++) for (let ix = 0; ix < segments; ix++) {
      const a = iz * stride + ix, b = a + 1, c = a + stride, d = c + 1;
      // Quads that touch the water at all are kept: their dry corners are already
      // sunk under the bank, so the mesh meets the ground at the real shoreline.
      if (!wet[a] && !wet[b] && !wet[c] && !wet[d]) continue;
      indices.push(a, c, b, b, c, d);
    }

    if (tile.mesh) {
      tile.mesh.geometry.dispose();
      this.group.remove(tile.mesh);
      tile.mesh = undefined;
    }
    if (indices.length === 0) { tile.level = level; return false; }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('waterPhase', new BufferAttribute(phases, 3));
    geometry.setAttribute('waterAmp', new BufferAttribute(amplitudes, 1));
    geometry.setAttribute('waterDepth', new BufferAttribute(depths, 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, this.material.material);
    mesh.name = `water ${tile.tx}:${tile.tz}`;
    mesh.position.set(tile.x - this.origin.absolute.x, 0, tile.z - this.origin.absolute.z);
    this.group.add(mesh);
    tile.mesh = mesh;
    tile.level = level;
    return true;
  }

}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
