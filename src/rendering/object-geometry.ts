import {
  BufferAttribute, BufferGeometry, BoxGeometry, CylinderGeometry, TorusGeometry, SphereGeometry, PlaneGeometry,
  CanvasTexture, SRGBColorSpace, LinearFilter, Color, Group, Mesh, MeshStandardNodeMaterial, Object3D,
} from 'three/webgpu';
import type { Material, Texture } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ObjectMesh } from '../objects/archetypes';

const WOOD = 0x8a6134, DARK_WOOD = 0x6b4a27, METAL = 0x8d9498, DARK_METAL = 0x3f4a4e, PAINT = 0x4a6a63;

function tag(geometry: BufferGeometry, hex: number): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const color = new Color(hex), colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b; }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  return geometry;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number) => tag(new BoxGeometry(w, h, d).translate(x, y, z), hex);
const cyl = (rTop: number, rBottom: number, h: number, x: number, y: number, z: number, hex: number, segments = 10) => tag(new CylinderGeometry(rTop, rBottom, h, segments).translate(x, y, z), hex);

function merge(parts: BufferGeometry[]): BufferGeometry {
  const expanded = parts.map((part) => {
    if (!part.index) return part;
    const flat = part.toNonIndexed();
    part.dispose();
    return flat;
  });
  const geometry = mergeGeometries(expanded, false);
  if (!geometry) throw new Error('Unable to build object geometry');
  for (const part of expanded) part.dispose();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Body geometry per visual family (merged, vertex coloured, one draw call). */
function bodyParts(mesh: ObjectMesh, accent: number): BufferGeometry[] {
  switch (mesh) {
    case 'crate': {
      const parts = [box(0.9, 0.82, 0.9, 0, 0.41, 0, accent)];
      for (const y of [0.1, 0.72]) parts.push(box(0.94, 0.07, 0.94, 0, y, 0, DARK_WOOD));
      for (const x of [-0.42, 0.42]) parts.push(box(0.07, 0.82, 0.94, x, 0.41, 0, DARK_WOOD));
      parts.push(box(0.26, 0.16, 0.02, 0, 0.66, 0.46, METAL));
      return parts;
    }
    case 'chest': {
      return [
        box(0.86, 0.46, 0.58, 0, 0.23, 0, accent),
        box(0.9, 0.06, 0.62, 0, 0.48, 0, DARK_WOOD),
        box(0.2, 0.1, 0.03, 0, 0.36, 0.3, METAL),
      ];
    }
    case 'barrel': {
      const parts = [cyl(0.42, 0.42, 1.0, 0, 0.5, 0, accent, 14)];
      for (const y of [0.24, 0.76]) parts.push(tag(new TorusGeometry(0.43, 0.035, 6, 14).rotateX(Math.PI / 2).translate(0, y, 0), DARK_METAL));
      parts.push(cyl(0.18, 0.18, 0.04, 0, 1.02, 0, METAL, 8));
      return parts;
    }
    case 'bottle': {
      return [
        cyl(0.1, 0.11, 0.26, 0, 0.13, 0, accent, 10),
        cyl(0.055, 0.055, 0.06, 0, 0.29, 0, METAL, 8),
      ];
    }
    case 'toolbox': {
      return [
        box(0.62, 0.26, 0.34, 0, 0.13, 0, accent),
        box(0.64, 0.05, 0.36, 0, 0.28, 0, DARK_METAL),
        box(0.22, 0.04, 0.04, 0, 0.33, 0, METAL),
        box(0.1, 0.06, 0.02, 0, 0.16, 0.18, METAL),
      ];
    }
    case 'gate': {
      return [
        box(0.18, 2.0, 0.18, -1.0, 1.0, 0, DARK_WOOD),
        box(0.18, 2.0, 0.18, 1.0, 1.0, 0, DARK_WOOD),
        box(2.2, 0.16, 0.16, 0, 1.96, 0, accent),
      ];
    }
    case 'switch': {
      return [
        box(0.12, 1.2, 0.12, 0, 0.6, 0, METAL),
        box(0.3, 0.42, 0.1, 0, 1.18, 0.06, accent),
        box(0.34, 0.02, 0.12, 0, 1.36, 0.07, DARK_METAL),
      ];
    }
    case 'lever': {
      return [
        box(0.34, 0.3, 0.34, 0, 0.15, 0, DARK_METAL),
        box(0.4, 0.06, 0.4, 0, 0.31, 0, accent),
      ];
    }
    case 'valve': {
      return [
        box(0.34, 0.6, 0.34, 0, 0.3, 0, accent),
        cyl(0.07, 0.07, 0.5, 0, 0.62, 0, DARK_METAL, 8),
      ];
    }
    case 'lamp': {
      return [
        cyl(0.09, 0.13, 2.0, 0, 1.0, 0, DARK_METAL, 8),
        box(0.34, 0.1, 0.34, 0, 2.02, 0, accent),
        box(0.3, 0.22, 0.3, 0, 2.14, 0, METAL),
        box(0.06, 0.2, 0.06, 0, 0.1, 0.16, METAL),
      ];
    }
    case 'bench': {
      const parts: BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) parts.push(box(1.6, 0.07, 0.16, 0, 0.46, -0.2 + i * 0.2, accent));
      for (const x of [-0.7, 0.7]) {
        parts.push(box(0.1, 0.46, 0.1, x, 0.23, -0.2, DARK_METAL));
        parts.push(box(0.1, 0.46, 0.1, x, 0.23, 0.2, DARK_METAL));
        parts.push(box(0.1, 0.6, 0.1, x, 0.76, -0.28, DARK_METAL));
      }
      for (let i = 0; i < 2; i++) parts.push(box(1.6, 0.16, 0.06, 0, 0.76 + i * 0.22, -0.3, DARK_WOOD));
      return parts;
    }
    case 'sign': {
      return [
        box(0.12, 1.7, 0.12, 0, 0.85, 0, DARK_WOOD),
        box(1.0, 0.5, 0.06, 0, 1.7, 0.04, accent),
      ];
    }
  }
}

const geometryCache = new Map<string, BufferGeometry>();

function cachedGeometry(key: string, build: () => BufferGeometry): BufferGeometry {
  const existing = geometryCache.get(key);
  if (existing) return existing;
  const geometry = build();
  geometryCache.set(key, geometry);
  return geometry;
}

/** Shared geometries are owned by the module; call on teardown (tests + game exit). */
export function clearObjectGeometryCache(): void {
  for (const geometry of geometryCache.values()) geometry.dispose();
  geometryCache.clear();
}

export interface ObjectVisual {
  readonly root: Group;
  /** Materials/textures owned by this instance (geometry is shared). */
  readonly materials: Material[];
  readonly textures: Texture[];
  readonly door?: Object3D;
  readonly lid?: Object3D;
  readonly lever?: Object3D;
  readonly wheel?: Object3D;
  readonly toggle?: Object3D;
  readonly lamp?: MeshStandardNodeMaterial;
}

function meshOf(geometry: BufferGeometry, material: Material): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function signTexture(label: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#d8c9a4'; context.fillRect(0, 0, 256, 128);
    context.strokeStyle = '#6b5836'; context.lineWidth = 5; context.strokeRect(8, 8, 240, 112);
    context.fillStyle = '#3a3020'; context.textAlign = 'center';
    context.font = 'bold 30px sans-serif';
    context.fillText(label, 128, 56);
    context.font = '18px sans-serif';
    context.fillText('WAYFARER · TRAIL', 128, 92);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build one object's visual. Static props are a single merged, vertex-coloured
 * mesh; anything that animates (door, lid, lever, valve wheel, switch toggle)
 * gets its own pivot so the interaction system can drive the transform directly.
 * A clearly identified procedural placeholder stands in for authored art.
 */
export function createObjectVisual(mesh: ObjectMesh, options: { label: string; accent?: number }): ObjectVisual {
  const accent = options.accent ?? WOOD;
  const root = new Group();
  root.name = `object:${mesh}`;
  const materials: Material[] = [];
  const textures: Texture[] = [];

  const bodyMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.08 });
  bodyMaterial.name = `object / ${mesh}`;
  materials.push(bodyMaterial);
  root.add(meshOf(cachedGeometry(`body:${mesh}:${accent}`, () => merge(bodyParts(mesh, accent))), bodyMaterial));

  const vertexColorMaterial = (roughness = 0.7, metalness = 0.12): MeshStandardNodeMaterial => {
    const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness, metalness });
    materials.push(material);
    return material;
  };

  let door: Object3D | undefined, lid: Object3D | undefined, lever: Object3D | undefined;
  let wheel: Object3D | undefined, toggle: Object3D | undefined, lamp: MeshStandardNodeMaterial | undefined;

  if (mesh === 'gate') {
    door = new Group();
    door.position.set(-0.86, 0, 0);
    door.add(meshOf(cachedGeometry('gate:panel', () => merge([
      box(1.62, 1.5, 0.07, 0.81, 0.86, 0, WOOD),
      box(1.66, 0.12, 0.11, 0.81, 1.56, 0, DARK_WOOD),
      box(1.66, 0.12, 0.11, 0.81, 0.2, 0, DARK_WOOD),
      box(0.09, 1.5, 0.11, 0.81, 0.86, 0, DARK_WOOD),
      box(0.14, 0.05, 0.16, 0.06, 0.95, 0, METAL),
    ])), vertexColorMaterial()));
    root.add(door);
  }
  if (mesh === 'chest') {
    lid = new Group();
    lid.position.set(0, 0.46, -0.29);
    const panel = new Mesh(cachedGeometry('chest:lid', () => merge([box(0.9, 0.14, 0.62, 0, 0.07, 0.29, DARK_WOOD)])), bodyMaterial);
    panel.castShadow = true; panel.receiveShadow = true;
    lid.add(panel);
    root.add(lid);
  }
  if (mesh === 'lever') {
    lever = new Group();
    lever.position.set(0, 0.32, 0);
    lever.add(meshOf(cachedGeometry('lever:arm', () => merge([
      tag(new CylinderGeometry(0.045, 0.055, 0.78, 8).translate(0, 0.39, 0), METAL),
      tag(new SphereGeometry(0.09, 10, 8).translate(0, 0.79, 0), PAINT),
    ])), vertexColorMaterial()));
    root.add(lever);
  }
  if (mesh === 'valve') {
    wheel = new Group();
    wheel.position.set(0, 0.9, 0);
    wheel.add(meshOf(cachedGeometry('valve:wheel', () => merge([
      tag(new TorusGeometry(0.24, 0.035, 6, 16).rotateX(Math.PI / 2), METAL),
      box(0.46, 0.04, 0.05, 0, 0, 0, METAL),
      box(0.05, 0.04, 0.46, 0, 0, 0, METAL),
    ])), vertexColorMaterial(0.5, 0.4)));
    root.add(wheel);
  }
  if (mesh === 'switch') {
    toggle = new Group();
    toggle.position.set(0, 1.14, 0.11);
    toggle.add(meshOf(cachedGeometry('switch:toggle', () => merge([box(0.06, 0.16, 0.05, 0, 0.06, 0, 0xe0d8b4)])), vertexColorMaterial()));
    root.add(toggle);
  }
  if (mesh === 'lamp') {
    lamp = new MeshStandardNodeMaterial({ color: 0x2a2f31, roughness: 0.5, metalness: 0.2, emissive: 0x000000, emissiveIntensity: 0 });
    materials.push(lamp);
    const panel = new Mesh(cachedGeometry('lamp:panel', () => new PlaneGeometry(0.26, 0.26).rotateX(Math.PI / 2).translate(0, 2.0, 0)), lamp);
    panel.name = 'lamp-panel';
    root.add(panel);
  }
  if (mesh === 'sign') {
    const faceMaterial = new MeshStandardNodeMaterial({ roughness: 0.72, metalness: 0 });
    const texture = signTexture(options.label);
    faceMaterial.map = texture;
    materials.push(faceMaterial);
    textures.push(texture);
    const face = new Mesh(cachedGeometry('sign:face', () => new PlaneGeometry(0.94, 0.44).translate(0, 1.7, 0.08)), faceMaterial);
    face.name = 'sign-face';
    root.add(face);
  }

  return { root, materials, textures, door, lid, lever, wheel, toggle, lamp };
}

/** Dispose every material/texture owned by one visual (geometry is shared). */
export function disposeObjectVisual(visual: ObjectVisual): void {
  for (const material of visual.materials) material.dispose();
  for (const texture of visual.textures) texture.dispose();
}
