import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardNodeMaterial, PointLight } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDING_TEMPLATES } from '../../world/buildings/templates';
import type { BuildingDescriptor, BuildingMaterial, BuildingPart, BuildingTemplate } from '../../world/buildings/types';

export interface BuildingView {
  root: Group;
  interior?: Group;
  light?: PointLight;
  doors: Map<string, Group>;
  ownGeometries: BufferGeometry[];
}
interface SharedMesh { geometry: BufferGeometry; material: MeshStandardNodeMaterial }
const PALETTE: Record<BuildingMaterial, number> = {
  stone: 0x95948b, plaster: 0xd7d1bf, timber: 0x816244, floor: 0x9e805d,
  roof: 0x354649, metal: 0x454d50, glass: 0xadc9cb, window: 0xffce81,
  linen: 0xb8b6a0, ceramic: 0x828e81, light: 0xffdfa7,
};

function gable(size: BuildingPart['size']): BufferGeometry {
  const w = size.x / 2, d = size.z / 2, h = size.y / 2;
  const vertices = [[-w, -h, -d], [w, -h, -d], [0, h, -d], [-w, -h, d], [w, -h, d], [0, h, d]];
  const indices = [0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices.flat()), 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}
function piece(part: BuildingPart): BufferGeometry {
  const geometry = part.shape === 'gable' ? gable(part.size) : part.shape === 'cylinder' ? new CylinderGeometry(part.size.x / 2, part.size.x / 2, part.size.y, 10) : new BoxGeometry(part.size.x, part.size.y, part.size.z);
  // Roof prism has no UVs; all materials here are procedural flat PBR colours.
  geometry.deleteAttribute('uv');
  if (part.rotation) { geometry.rotateX(part.rotation.x); geometry.rotateY(part.rotation.y); geometry.rotateZ(part.rotation.z); }
  geometry.translate(part.center.x, part.center.y, part.center.z);
  const expanded = geometry.toNonIndexed(); geometry.dispose();
  return expanded;
}

/** Shared merged geometry per template/stage/material: no mesh per brick or chair leg. */
export class BuildingVisuals {
  private readonly materials = new Map<BuildingMaterial, MeshStandardNodeMaterial>();
  private readonly cache = new Map<string, SharedMesh[]>();
  constructor() {
    for (const [key, color] of Object.entries(PALETTE) as [BuildingMaterial, number][]) {
      const material = new MeshStandardNodeMaterial({ color, roughness: key === 'metal' ? 0.46 : key === 'roof' ? 0.72 : 0.88, metalness: key === 'metal' || key === 'roof' ? 0.35 : 0 });
      material.name = `Building / ${key}`;
      if (key === 'glass' || key === 'window') { material.transparent = true; material.opacity = key === 'glass' ? 0.18 : 0.035; material.depthWrite = false; material.roughness = 0.18; }
      if (key === 'window' || key === 'light') { material.emissive.setHex(color); material.emissiveIntensity = key === 'light' ? 0.8 : 0; }
      this.materials.set(key, material);
    }
  }
  private batch(parts: readonly BuildingPart[]): SharedMesh[] {
    const groups = new Map<BuildingMaterial, BuildingPart[]>();
    for (const part of parts) { if (!groups.has(part.material)) groups.set(part.material, []); groups.get(part.material)!.push(part); }
    const result: SharedMesh[] = [];
    for (const [key, list] of groups) {
      const pieces = list.map(piece);
      const geometry = mergeGeometries(pieces, false);
      for (const part of pieces) part.dispose();
      if (!geometry) throw new Error(`Cannot merge building material ${key}`);
      geometry.computeBoundingSphere();
      result.push({ geometry, material: this.materials.get(key)! });
    }
    return result;
  }
  private shared(template: BuildingTemplate, stage: BuildingPart['stage']): SharedMesh[] {
    const key = `${template.id}:${stage}`;
    let result = this.cache.get(key);
    if (!result) { result = this.batch(template.parts.filter((part) => part.stage === stage)); this.cache.set(key, result); }
    return result;
  }
  private meshes(target: Group, batch: SharedMesh[]): void {
    for (const item of batch) {
      const mesh = new Mesh(item.geometry, item.material);
      mesh.name = item.material.name;
      mesh.castShadow = !item.material.transparent; mesh.receiveShadow = true;
      target.add(mesh);
    }
  }
  create(building: BuildingDescriptor, site: readonly BuildingPart[]): BuildingView {
    const template = BUILDING_TEMPLATES.get(building.template);
    const root = new Group(); root.name = `building ${building.id}`; root.rotation.y = building.yaw;
    this.meshes(root, this.shared(template, 'shell'));
    const own = this.batch(site); this.meshes(root, own);
    const doors = new Map<string, Group>();
    for (const door of template.doors) {
      const pivot = new Group(); pivot.position.set(door.hinge.x, door.hinge.y, door.hinge.z); pivot.rotation.y = door.yaw; pivot.name = `door ${door.id}`;
      const key = `door:${door.width}:${door.height}:${door.thickness}`;
      let batch = this.cache.get(key);
      if (!batch) {
        const parts: BuildingPart[] = [
          { id: 'leaf', center: { x: door.width / 2, y: door.height / 2, z: 0 }, size: { x: door.width, y: door.height, z: door.thickness }, stage: 'shell', material: 'timber' },
          { id: 'inset', center: { x: door.width / 2, y: door.height * 0.65, z: door.thickness * 0.55 }, size: { x: door.width * 0.7, y: door.height * 0.45, z: 0.03 }, stage: 'shell', material: 'plaster' },
        ];
        for (const sign of [-1, 1]) parts.push({ id: `handle-${sign}`, center: { x: door.width * 0.86, y: 1.05, z: sign * (door.thickness / 2 + 0.04) }, size: { x: 0.18, y: 0.035, z: 0.07 }, material: 'metal', stage: 'shell' });
        batch = this.batch(parts); this.cache.set(key, batch);
      }
      this.meshes(pivot, batch); root.add(pivot); doors.set(door.id, pivot);
    }
    return { root, doors, ownGeometries: own.map((item) => item.geometry) };
  }
  setInterior(view: BuildingView, template: BuildingTemplate, loaded: boolean): void {
    if (loaded && !view.interior) {
      const interior = new Group(); interior.name = 'Streamed rooms & furnishings';
      this.meshes(interior, this.shared(template, 'interior'));
      view.root.add(interior); view.interior = interior;
    } else if (!loaded && view.interior) {
      view.root.remove(view.interior); view.interior.clear(); view.interior = undefined;
      if (view.light) { view.root.remove(view.light); view.light.dispose(); view.light = undefined; }
    }
  }
  setLight(view: BuildingView, room: BuildingTemplate['rooms'][number] | undefined, enabled: boolean): void {
    if (!enabled || !room || !view.interior) { if (view.light) view.light.visible = false; return; }
    if (!view.light) { view.light = new PointLight(0xffd6a4, 32, 18, 2); view.light.castShadow = false; view.root.add(view.light); }
    view.light.visible = true; view.light.position.set(room.light.x, room.light.y, room.light.z);
  }
  setHour(hour: number): void {
    const night = hour < 6 || hour > 19 ? 1 : hour < 7 ? 7 - hour : hour > 18 ? hour - 18 : 0;
    this.materials.get('window')!.emissiveIntensity = night * 2.5;
    this.materials.get('window')!.opacity = 0.035 + night * 0.2;
    this.materials.get('light')!.emissiveIntensity = 0.8 + night;
  }
  destroy(view: BuildingView): void {
    view.root.removeFromParent(); view.light?.dispose(); view.root.clear(); view.doors.clear();
    for (const geometry of view.ownGeometries) geometry.dispose();
    view.ownGeometries.length = 0;
  }
  dispose(): void {
    for (const batch of this.cache.values()) for (const item of batch) item.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.cache.clear(); this.materials.clear();
  }
  get stats() { return { sharedGeometryBatches: [...this.cache.values()].reduce((count, meshes) => count + meshes.length, 0), materials: this.materials.size }; }
}
