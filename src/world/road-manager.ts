import { Group, Mesh, BufferGeometry, BufferAttribute, InstancedMesh, InstancedBufferAttribute, MeshStandardNodeMaterial, DynamicDrawUsage, DoubleSide, Object3D, Color, Vector3, Sphere } from 'three/webgpu';
import type { CanvasTexture } from 'three/webgpu';
import { attribute, cameraPosition, distance, float, positionLocal, smoothstep, uniform, vec3, mix, texture } from 'three/tsl';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import type { FloatingOrigin } from '../core/floating-origin';
import type { TerrainManager, TerrainTile } from './terrain-manager';
import { createRoadMaterial } from '../rendering/road-material';
import { createPropGeometry, createSignTexture } from '../rendering/prop-geometry';
import type { SignKind } from '../rendering/prop-geometry';
import { PROP_KINDS, PROP_STRIDE } from './road-geometry';
import { RoadNetwork, createRoadSample } from './road-network';
import { tileSize, distanceToTile } from './tiles';

interface PropBatch {
  mesh: InstancedMesh;
  material: MeshStandardNodeMaterial;
  roots: InstancedBufferAttribute;
  capacity: number;
  sign?: CanvasTexture;
}
interface PropCandidate { data: Float32Array; index: number; x: number; z: number; d: number }
const SIGN_TEXTURES: Record<number, SignKind> = { 2: 'route', 3: 'direction', 5: 'kiosk' };

/**
 * Phase 3 road presentation: worker-built carriageways are attached to the same
 * streamed tiles as the terrain, while roadside furniture is packed into seven
 * bounded, nearest-first instance batches. Everything is origin-invariant.
 */
export class RoadManager {
  readonly group = new Group();
  network: RoadNetwork;
  private readonly roadMaterial = createRoadMaterial();
  private readonly roadMeshes = new Map<string, { mesh: Mesh; source: TerrainTile }>();
  private batches: PropBatch[] = [];
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly lastPosition = new Vector3(Infinity, Infinity, Infinity);
  private readonly sample = createRoadSample();
  private elapsed: number = CONFIG.roads.updateInterval;
  private revision = -1;
  private dirty = true;
  private enabled = true;
  private disposed = false;
  private counts = Array<number>(PROP_KINDS.length).fill(0);
  private truncated = false;

  constructor(private readonly terrain: TerrainManager, private readonly origin: FloatingOrigin, public quality: QualityName, seed: string) {
    this.group.name = 'Phase 3 / scenic roads & world props';
    this.network = new RoadNetwork(seed, () => 0);
    this.allocateProps();
  }

  private allocateProps(): void {
    const preset = QUALITY[this.quality];
    PROP_KINDS.forEach((kind, index) => {
      const capacity = preset.propBudgets[index]!;
      const geometry = createPropGeometry(kind, preset.geometryDetail);
      const roots = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
      geometry.setAttribute('propRoot', roots);
      const radius = uniform(preset.propDistance);
      const root = attribute('propRoot', 'vec3');
      const fade = float(1).sub(smoothstep(radius.mul(0.82), radius, distance(cameraPosition.xz, root.xz)));
      const material = new MeshStandardNodeMaterial({
        vertexColors: true, side: DoubleSide,
        roughness: kind === 'guardrail' ? 0.42 : kind === 'reflector' ? 0.6 : 0.82,
        metalness: kind === 'guardrail' ? 0.75 : kind === 'reflector' ? 0.2 : 0,
      });
      material.name = `Road prop / ${kind}`;
      let sign: CanvasTexture | undefined;
      const signKind = SIGN_TEXTURES[index];
      if (signKind) {
        sign = createSignTexture(signKind);
        material.colorNode = mix(vec3(1), texture(sign).rgb, attribute('propFace', 'float'));
      }
      material.positionNode = root.add(positionLocal.sub(root).mul(fade));
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = `road-prop:${kind}`;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.setColorAt(0, new Color(1, 1, 1));
      mesh.instanceColor!.setUsage(DynamicDrawUsage);
      mesh.castShadow = kind !== 'reflector';
      mesh.receiveShadow = true;
      mesh.boundingSphere = new Sphere(new Vector3(), preset.propDistance + CONFIG.origin.rebaseDistance * 2 + 2500);
      this.group.add(mesh);
      this.batches.push({ mesh, material, roots, capacity, sign });
    });
  }

  update(position: Vector3, dt: number): void {
    if (this.disposed) return;
    this.group.visible = this.enabled;
    this.roadMaterial.setOrigin(this.origin.absolute.x, this.origin.absolute.z);
    if (!this.enabled) return;
    this.elapsed += dt;
    if (this.elapsed < CONFIG.roads.updateInterval) return;
    const moved = this.lastPosition.distanceToSquared(position) > CONFIG.vegetation.moveThreshold ** 2;
    if (!this.dirty && !moved && this.revision === this.terrain.revision) return;
    this.elapsed = 0; this.dirty = false; this.revision = this.terrain.revision;
    this.lastPosition.copy(position);
    this.syncRoadMeshes();
    this.rebuildProps(position);
  }

  private syncRoadMeshes(): void {
    const active = new Set<string>();
    for (const tile of this.terrain.activeTiles) {
      const key = `${tile.coord.level}:${tile.coord.x}:${tile.coord.z}`;
      active.add(key);
      const existing = this.roadMeshes.get(key);
      if (existing && existing.source === tile) { existing.mesh.visible = tile.mesh.visible; continue; }
      if (existing) { this.group.remove(existing.mesh); existing.mesh.geometry.dispose(); this.roadMeshes.delete(key); }
      if (tile.road.positions.length === 0) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(tile.road.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(tile.road.normals, 3));
      geometry.setAttribute('uv', new BufferAttribute(tile.road.uvs, 2));
      geometry.setAttribute('color', new BufferAttribute(tile.road.colors, 3));
      geometry.setAttribute('roadSurface', new BufferAttribute(tile.road.surface, 1));
      geometry.setIndex(new BufferAttribute(tile.road.indices, 1));
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, this.roadMaterial.material);
      const size = tileSize(tile.coord.level);
      mesh.position.set(tile.coord.x * size - this.origin.absolute.x, -this.origin.absolute.y, tile.coord.z * size - this.origin.absolute.z);
      mesh.name = `road ${key}`;
      mesh.receiveShadow = true;
      mesh.visible = tile.mesh.visible;
      this.group.add(mesh);
      this.roadMeshes.set(key, { mesh, source: tile });
    }
    for (const [key, entry] of this.roadMeshes) if (!active.has(key)) {
      this.group.remove(entry.mesh); entry.mesh.geometry.dispose(); this.roadMeshes.delete(key);
    }
  }

  private rebuildProps(position: Vector3): void {
    const preset = QUALITY[this.quality];
    const candidates: PropCandidate[][] = Array.from({ length: PROP_KINDS.length }, () => []);
    for (const tile of this.terrain.activeTiles) {
      const data = tile.road.props;
      if (data.length === 0 || distanceToTile(tile.coord, position.x, position.z) > preset.propDistance) continue;
      const size = tileSize(tile.coord.level), worldX = tile.coord.x * size, worldZ = tile.coord.z * size;
      for (let i = 0; i < data.length / PROP_STRIDE; i++) {
        const o = i * PROP_STRIDE;
        const x = worldX + data[o]!, z = worldZ + data[o + 2]!;
        const d = Math.hypot(x - position.x, z - position.z);
        if (d > preset.propDistance) continue;
        candidates[data[o + 4]!]!.push({ data, index: i, x, z, d });
      }
    }
    this.counts.fill(0); this.truncated = false;
    for (let kind = 0; kind < PROP_KINDS.length; kind++) {
      const list = candidates[kind]!, batch = this.batches[kind]!;
      list.sort((a, b) => a.d - b.d);
      const limit = Math.min(list.length, batch.capacity);
      if (list.length > batch.capacity) this.truncated = true;
      for (let n = 0; n < limit; n++) {
        const c = list[n]!, o = c.index * PROP_STRIDE;
        const localX = c.x - this.origin.absolute.x, localY = c.data[o + 1]! - this.origin.absolute.y, localZ = c.z - this.origin.absolute.z;
        this.dummy.position.set(localX, localY, localZ);
        this.dummy.rotation.set(0, c.data[o + 3]!, 0);
        this.dummy.scale.setScalar(c.data[o + 5]!);
        this.dummy.updateMatrix();
        batch.mesh.setMatrixAt(n, this.dummy.matrix);
        const shade = 0.9 + c.data[o + 6]! * 0.15;
        this.color.setRGB(shade, shade, shade);
        batch.mesh.setColorAt(n, this.color);
        batch.roots.setXYZ(n, localX, localY, localZ);
      }
      batch.mesh.count = limit; this.counts[kind] = limit;
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.instanceColor!.needsUpdate = true;
      batch.roots.needsUpdate = true;
    }
  }

  routeAt(position: Vector3) {
    this.network.sample(position.x, position.z, this.sample);
    return { ...this.network.routeInfo(this.sample.corridor, this.sample.station), corridor: this.sample.corridor, station: this.sample.station, lateral: this.sample.lateral };
  }
  point(corridor: number, station: number, lateral = 0) { return this.network.point(corridor, station, lateral); }

  setEnabled(enabled: boolean): void { this.enabled = enabled; this.group.visible = enabled; if (enabled) this.dirty = true; }
  get roadsEnabled(): boolean { return this.enabled; }
  rebase(delta: Vector3): void { for (const entry of this.roadMeshes.values()) entry.mesh.position.sub(delta); this.dirty = true; this.elapsed = CONFIG.roads.updateInterval; }
  reset(seed: string): void {
    this.network = new RoadNetwork(seed, () => 0);
    for (const entry of this.roadMeshes.values()) { this.group.remove(entry.mesh); entry.mesh.geometry.dispose(); }
    this.roadMeshes.clear();
    this.counts.fill(0);
    for (const batch of this.batches) batch.mesh.count = 0;
    this.revision = -1; this.dirty = true; this.lastPosition.set(Infinity, Infinity, Infinity);
  }
  setQuality(quality: QualityName): void {
    if (quality === this.quality) return;
    this.clearProps(); this.quality = quality; this.allocateProps();
    this.dirty = true; this.revision = -1; this.lastPosition.set(Infinity, Infinity, Infinity);
  }
  get stats() {
    let roadTriangles = 0;
    for (const entry of this.roadMeshes.values()) if (entry.mesh.visible) roadTriangles += entry.mesh.geometry.index!.count / 3;
    return {
      roadTiles: this.roadMeshes.size, roadTriangles, roadsEnabled: this.enabled,
      props: this.enabled ? this.counts.reduce((a, b) => a + b, 0) : 0,
      propBatches: this.enabled ? this.counts.filter((c) => c > 0).length : 0,
      propCapacity: this.batches.reduce((sum, b) => sum + b.capacity, 0),
      propTruncated: this.truncated,
      propKinds: Object.fromEntries(PROP_KINDS.map((kind, i) => [kind, this.enabled ? this.counts[i]! : 0])),
    };
  }
  private clearProps(): void {
    for (const batch of this.batches) {
      this.group.remove(batch.mesh); batch.mesh.geometry.dispose(); batch.material.dispose(); batch.sign?.dispose(); batch.mesh.dispose();
    }
    this.batches = [];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.roadMeshes.values()) { this.group.remove(entry.mesh); entry.mesh.geometry.dispose(); }
    this.roadMeshes.clear(); this.clearProps(); this.roadMaterial.dispose();
  }
}
