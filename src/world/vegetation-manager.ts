import { Group, InstancedMesh, InstancedBufferAttribute, MeshStandardNodeMaterial, DynamicDrawUsage, DoubleSide, FrontSide, Object3D, Color, Vector3, Sphere } from 'three/webgpu';
import { attribute, cameraPosition, distance, float, positionGeometry, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import type { FloatingOrigin } from '../core/floating-origin';
import type { TerrainManager } from './terrain-manager';
import { createPlantGeometry } from '../rendering/vegetation-geometry';
import { PLANT_KINDS, PLANT_STRIDE, readPlant } from './vegetation-field';
import type { PlantPlacement } from './vegetation-field';
import { tileSize, distanceToTile } from './tiles';
import { smoothstep as cpuSmoothstep } from '../utils/math';

interface Batch {
  mesh: InstancedMesh;
  material: MeshStandardNodeMaterial;
  roots: InstancedBufferAttribute;
  meta: InstancedBufferAttribute;
  capacity: number;
}

/**
 * Five reusable global instance batches, not one draw call per plant or tile.
 * Workers own placement; this class only packs visible records into bounded GPU
 * buffers. Distance scaling happens in the vertex shader, so range edges do not
 * pop. All matrices are render-local and are rebuilt after an origin shift.
 */
export class VegetationManager {
  readonly group = new Group();
  private batches: Batch[] = [];
  private readonly time = uniform(0);
  private readonly wind = uniform(CONFIG.vegetation.wind as number);
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
      const geometry = createPlantGeometry(kind);
      const roots = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
      const meta = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
      geometry.setAttribute('plantRoot', roots);
      geometry.setAttribute('plantMeta', meta);
      const radius = uniform(kind === 'grass' ? preset.grassDistance : kind === 'shrub' ? preset.vegetationDistance * 0.65 : preset.vegetationDistance);
      const root = attribute('plantRoot', 'vec3');
      const info = attribute('plantMeta', 'vec2');
      const fade = float(1).sub(smoothstep(radius.mul(0.8), radius, distance(cameraPosition.xz, root.xz)));
      const phase = this.time.mul(1.35).add(info.x);
      const sway = vec3(phase.sin(), 0, phase.mul(0.73).cos()).mul(positionGeometry.y.mul(positionGeometry.y).mul(info.y).mul(this.wind));
      const material = new MeshStandardNodeMaterial({
        roughness: 0.92, metalness: 0, vertexColors: true,
        side: kind === 'grass' || kind === 'shrub' ? DoubleSide : FrontSide,
      });
      material.name = `Instanced ${kind} / wind + range fade`;
      material.positionNode = root.add(positionLocal.sub(root).mul(fade)).add(sway.mul(fade));
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = `vegetation:${kind}`;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.setColorAt(0, new Color(1, 1, 1));
      mesh.instanceColor!.setUsage(DynamicDrawUsage);
      mesh.castShadow = kind === 'pine' || kind === 'aspen' || kind === 'rock';
      mesh.receiveShadow = true;
      // Individual records are range-limited; the batch bounds cover that window.
      mesh.boundingSphere = new Sphere(new Vector3(), preset.vegetationDistance + CONFIG.origin.rebaseDistance * 2 + 2500);
      this.group.add(mesh);
      this.batches.push({ mesh, material, roots, meta, capacity });
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
    const tiles = [...this.terrain.activeTiles].filter((tile) => tile.vegetation.length > 0 && distanceToTile(tile.coord, position.x, position.z) < preset.vegetationDistance);
    tiles.sort((a, b) => distanceToTile(a.coord, position.x, position.z) - distanceToTile(b.coord, position.x, position.z));
    this.counts.fill(0);
    this.truncated = false;
    for (const tile of tiles) {
      const size = tileSize(tile.coord.level);
      const worldX = tile.coord.x * size, worldZ = tile.coord.z * size;
      const data = tile.vegetation;
      for (let i = 0; i < data.length / PLANT_STRIDE; i++) {
        const p = readPlant(data, i, this.plant);
        if (p.random > preset.vegetationDensity) continue;
        const batch = this.batches[p.kind]!;
        const count = this.counts[p.kind]!;
        if (count >= batch.capacity) { this.truncated = true; continue; }
        const x = worldX + p.x, z = worldZ + p.z;
        const radius = p.kind === 3 ? preset.grassDistance : p.kind === 2 ? preset.vegetationDistance * 0.65 : preset.vegetationDistance;
        const d = Math.hypot(x - position.x, z - position.z);
        if (d > radius) continue;
        // A soft population boundary avoids a hard line at the last instance.
        const edge = 1 - cpuSmoothstep(radius * 0.88, radius, d);
        const scale = p.scale * edge;
        if (scale < 0.005) continue;
        const localX = x - this.origin.absolute.x, localY = p.y - this.origin.absolute.y, localZ = z - this.origin.absolute.z;
        this.dummy.position.set(localX, localY, localZ);
        this.dummy.rotation.set(0, p.yaw, 0);
        this.dummy.scale.setScalar(scale);
        this.dummy.updateMatrix();
        batch.mesh.setMatrixAt(count, this.dummy.matrix);
        this.color.setRGB(p.brightness, p.brightness, p.brightness);
        batch.mesh.setColorAt(count, this.color);
        batch.roots.setXYZ(count, localX, localY, localZ);
        const flexibility = p.kind === 3 ? 0.2 : p.kind === 2 ? 0.06 : p.kind === 4 ? 0 : 0.0025;
        batch.meta.setXY(count, p.yaw * 4 + localX * 0.015, flexibility * scale);
        this.counts[p.kind] = count + 1;
      }
    }
    this.batches.forEach((batch, i) => {
      batch.mesh.count = this.counts[i]!;
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.instanceColor!.needsUpdate = true;
      batch.roots.needsUpdate = true;
      batch.meta.needsUpdate = true;
    });
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
