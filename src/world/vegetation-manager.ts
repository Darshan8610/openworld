import { Group, InstancedMesh, InstancedBufferAttribute, MeshStandardNodeMaterial, DynamicDrawUsage, DoubleSide, FrontSide, Object3D, Color, Vector3, Vector2, Sphere } from 'three/webgpu';
import type { DataTexture } from 'three/webgpu';
import { attribute, cameraPosition, distance, float, positionLocal, smoothstep, uniform, vec3, mix, texture } from 'three/tsl';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import type { FloatingOrigin } from '../core/floating-origin';
import type { TerrainManager } from './terrain-manager';
import { createPlantGeometry } from '../rendering/vegetation-geometry';
import { createFoliageTexture } from '../rendering/foliage-textures';
import { PLANT_KINDS, PLANT_STRIDE, readPlant } from './vegetation-field';
import type { PlantPlacement } from './vegetation-field';
import { tileSize, distanceToTile } from './tiles';
import { mod } from '../utils/math';

interface Batch {
  mesh: InstancedMesh;
  material: MeshStandardNodeMaterial;
  roots: InstancedBufferAttribute;
  meta: InstancedBufferAttribute;
  capacity: number;
  foliage?: DataTexture;
}
interface Candidate { data: Float32Array; index: number; x: number; z: number; d: number }

const FLEXIBILITY = [0.12, 0.16, 0.1, 0.26, 0] as const;

/**
 * Five reusable global instance batches. Workers own canonical placement; this
 * class packs the nearest accepted records into bounded GPU buffers. Range fade
 * and wind run in the vertex shader. Wind phase is derived from canonical world
 * coordinates modulo the origin wrap, so rebasing never restarts a plant's sway.
 */
export class VegetationManager {
  readonly group = new Group();
  private batches: Batch[] = [];
  private readonly time = uniform(0);
  private readonly wind = uniform(CONFIG.vegetation.wind as number);
  private readonly windDirection = uniform(new Vector2(0.82, 0.57));
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly plant: PlantPlacement = { x: 0, y: 0, z: 0, scale: 1, yaw: 0, kind: 0, brightness: 1, random: 0 };
  private readonly lastPosition = new Vector3(Infinity, Infinity, Infinity);
  private elapsed: number = CONFIG.vegetation.updateInterval;
  private revision = -1;
  private dirty = true;
  private enabled = true;
  private disposed = false;
  private counts = [0, 0, 0, 0, 0];
  private truncated = false;
  windEnabled = true;

  constructor(private readonly terrain: TerrainManager, private readonly origin: FloatingOrigin, public quality: QualityName) {
    this.group.name = 'Streamed vegetation / five instance batches';
    this.allocate();
  }

  private allocate(): void {
    const preset = QUALITY[this.quality];
    PLANT_KINDS.forEach((kind, index) => {
      const capacity = preset.instanceBudgets[index]!;
      const geometry = createPlantGeometry(kind, this.quality === 'low' ? 'low' : 'full');
      const roots = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
      const meta = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
      geometry.setAttribute('plantRoot', roots);
      geometry.setAttribute('plantMeta', meta);
      const radius = uniform(kind === 'grass' ? preset.grassDistance : kind === 'shrub' ? preset.vegetationDistance * 0.65 : preset.vegetationDistance);
      const root = attribute('plantRoot', 'vec3');
      const info = attribute('plantMeta', 'vec2');
      const leaf = attribute('leaf', 'float');
      const flex = attribute('plantFlex', 'float');
      const edgeStart = kind === 'grass' || kind === 'shrub' ? 0.78 : 0.94;
      const fade = float(1).sub(smoothstep(radius.mul(edgeStart), radius, distance(cameraPosition.xz, root.xz)));
      const phase = this.time.mul(1.25).add(info.x);
      const gust = phase.sin().add(phase.mul(2.17).add(info.x.mul(0.6)).sin().mul(0.38));
      const sway = vec3(this.windDirection.x, 0, this.windDirection.y).mul(gust).mul(flex).mul(info.y).mul(this.wind);
      const material = new MeshStandardNodeMaterial({
        roughness: kind === 'rock' ? 0.88 : 0.9,
        metalness: 0,
        vertexColors: true,
        side: kind === 'grass' || kind === 'shrub' || kind === 'pine' || kind === 'aspen' ? DoubleSide : FrontSide,
      });
      material.name = `Instanced ${kind} / layered foliage + wind`;
      let foliage: DataTexture | undefined;
      if (kind === 'pine' || kind === 'aspen' || kind === 'shrub') {
        foliage = createFoliageTexture(kind);
        const spray = texture(foliage);
        material.colorNode = mix(vec3(1), spray.rgb, leaf);
        material.opacityNode = mix(float(1), spray.a, leaf);
        material.alphaTest = 0.42;
        material.alphaToCoverage = true;
      }
      material.positionNode = root.add(positionLocal.sub(root).mul(fade)).add(sway.mul(fade));
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = `vegetation:${kind}`;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.setColorAt(0, new Color(1, 1, 1));
      mesh.instanceColor!.setUsage(DynamicDrawUsage);
      mesh.castShadow = kind === 'pine' || kind === 'aspen' || kind === 'rock';
      mesh.receiveShadow = true;
      mesh.boundingSphere = new Sphere(new Vector3(), preset.vegetationDistance + CONFIG.origin.rebaseDistance * 2 + 2500);
      this.group.add(mesh);
      this.batches.push({ mesh, material, roots, meta, capacity, foliage });
    });
  }

  update(position: Vector3, dt: number): void {
    if (this.disposed) return;
    this.time.value += dt;
    this.wind.value = this.windEnabled ? CONFIG.vegetation.wind : 0;
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    this.elapsed += dt;
    if (this.elapsed < CONFIG.vegetation.updateInterval) return;
    const moved = this.lastPosition.distanceToSquared(position) > CONFIG.vegetation.moveThreshold ** 2;
    if (!this.dirty && !moved && this.revision === this.terrain.revision) return;
    this.elapsed = 0;
    this.dirty = false;
    this.revision = this.terrain.revision;
    this.lastPosition.copy(position);
    this.rebuild(position);
  }

  private rebuild(position: Vector3): void {
    const preset = QUALITY[this.quality];
    const candidates: Candidate[][] = [[], [], [], [], []];
    const maxRange = preset.vegetationDistance;
    for (const tile of this.terrain.activeTiles) {
      if (tile.vegetation.length === 0 || distanceToTile(tile.coord, position.x, position.z) > maxRange) continue;
      const size = tileSize(tile.coord.level);
      const worldX = tile.coord.x * size, worldZ = tile.coord.z * size;
      const data = tile.vegetation;
      for (let i = 0; i < data.length / PLANT_STRIDE; i++) {
        const p = readPlant(data, i, this.plant);
        if (p.random > preset.vegetationDensity) continue;
        const x = worldX + p.x, z = worldZ + p.z;
        const radius = p.kind === 3 ? preset.grassDistance : p.kind === 2 ? preset.vegetationDistance * 0.65 : preset.vegetationDistance;
        const d = Math.hypot(x - position.x, z - position.z);
        if (d > radius) continue;
        candidates[p.kind]!.push({ data, index: i, x, z, d });
      }
    }
    this.counts.fill(0);
    this.truncated = false;
    for (let kind = 0; kind < PLANT_KINDS.length; kind++) {
      const list = candidates[kind]!;
      // Nearest plants win a full budget, instead of whichever tile happened to
      // be visited first. This keeps the foreground stable under streaming.
      list.sort((a, b) => a.d - b.d);
      const batch = this.batches[kind]!;
      const limit = Math.min(list.length, batch.capacity);
      if (list.length > batch.capacity) this.truncated = true;
      for (let n = 0; n < limit; n++) {
        const candidate = list[n]!;
        const p = readPlant(candidate.data, candidate.index, this.plant);
        const localX = candidate.x - this.origin.absolute.x;
        const localY = p.y - this.origin.absolute.y;
        const localZ = candidate.z - this.origin.absolute.z;
        this.dummy.position.set(localX, localY, localZ);
        this.dummy.rotation.set(0, p.yaw, 0);
        this.dummy.scale.setScalar(p.scale);
        this.dummy.updateMatrix();
        batch.mesh.setMatrixAt(n, this.dummy.matrix);
        this.color.setRGB(p.brightness, p.brightness, p.brightness);
        batch.mesh.setColorAt(n, this.color);
        batch.roots.setXYZ(n, localX, localY, localZ);
        // Origin-invariant phase: origin shifts are multiples of 2048 m.
        const phase = mod(candidate.x, 1024) * 0.017 + mod(candidate.z, 1024) * 0.013 + p.yaw * 3;
        batch.meta.setXY(n, phase, FLEXIBILITY[p.kind]! * p.scale);
        this.counts[kind] = n + 1;
      }
      batch.mesh.count = this.counts[kind]!;
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.instanceColor!.needsUpdate = true;
      batch.roots.needsUpdate = true;
      batch.meta.needsUpdate = true;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
    if (enabled) this.dirty = true;
  }
  get vegetationEnabled(): boolean { return this.enabled; }
  setWind(enabled: boolean): void { this.windEnabled = enabled; }
  rebase(): void { this.dirty = true; this.elapsed = CONFIG.vegetation.updateInterval; }
  reset(): void {
    this.counts.fill(0);
    for (const batch of this.batches) batch.mesh.count = 0;
    this.revision = -1;
    this.dirty = true;
    this.lastPosition.set(Infinity, Infinity, Infinity);
  }
  setQuality(quality: QualityName): void {
    if (quality === this.quality) return;
    this.clearBatches();
    this.quality = quality;
    this.allocate();
    this.reset();
  }
  get stats() {
    return {
      instances: this.enabled ? this.counts.reduce((a, b) => a + b, 0) : 0,
      batches: this.enabled ? this.counts.filter((count) => count > 0).length : 0,
      truncated: this.truncated,
      capacity: this.batches.reduce((sum, batch) => sum + batch.capacity, 0),
      kinds: Object.fromEntries(PLANT_KINDS.map((kind, i) => [kind, this.enabled ? this.counts[i]! : 0])),
    };
  }
  private clearBatches(): void {
    for (const batch of this.batches) {
      this.group.remove(batch.mesh);
      batch.mesh.geometry.dispose();
      batch.material.dispose();
      batch.foliage?.dispose();
      batch.mesh.dispose();
    }
    this.batches = [];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearBatches();
  }
}
