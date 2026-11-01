import { BufferGeometry, BufferAttribute, Color, IcosahedronGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlantKind } from '../world/vegetation-field';
import { seededRandom } from '../utils/random';

/**
 * One merged, vertex-colored geometry per species. Foliage is carried on cheap
 * crossed cards with alpha-tested procedural sprays; trunks/branches are solid.
 * `leaf` selects texture alpha, `plantFlex` weights wind so bark stays planted.
 */
function tag(geometry: BufferGeometry, hex: number, leaf: number, flex: number): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  const color = new Color(hex);
  const colors = new Float32Array(count * 3);
  const leaves = new Float32Array(count);
  const flexes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    leaves[i] = leaf;
    flexes[i] = flex;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('leaf', new BufferAttribute(leaves, 1));
  geometry.setAttribute('plantFlex', new BufferAttribute(flexes, 1));
  return geometry;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const compatible = parts.map((part) => {
    if (!part.index) return part;
    const expanded = part.toNonIndexed();
    part.dispose();
    return expanded;
  });
  const geometry = mergeGeometries(compatible, false);
  if (!geometry) throw new Error('Unable to build vegetation geometry');
  for (const part of compatible) part.dispose();
  geometry.computeBoundingSphere();
  return geometry;
}

function card(width: number, height: number, x: number, y: number, z: number, yaw: number, tilt: number, hex: number, flex: number): BufferGeometry {
  const geometry = new PlaneGeometry(width, height, 1, 1);
  geometry.rotateX(tilt);
  geometry.rotateY(yaw);
  geometry.translate(x, y, z);
  return tag(geometry, hex, 1, flex);
}

function pine(detail: 'low' | 'full'): BufferGeometry {
  const low = detail === 'low';
  const parts: BufferGeometry[] = [];
  const random = seededRandom(0x51ed270b);
  parts.push(tag(new CylinderGeometry(0.11, 0.27, 10.4, 7).translate(0, 5.2, 0), 0x4e3d2c, 0, 0));
  // Opaque inner crown gives the conifer mass; alpha sprays break the silhouette.
  parts.push(tag(new ConeGeometry(2.35, 5.6, 8).translate(0, 5.0, 0), 0x274434, 0, 0.18));
  parts.push(tag(new ConeGeometry(1.75, 4.7, 8).translate(0, 7.2, 0), 0x31543e, 0, 0.28));
  if (!low) parts.push(tag(new ConeGeometry(1.15, 3.7, 7).translate(0, 9.2, 0), 0x3d6247, 0, 0.38));
  const whorls = low ? 4 : 6;
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y = 2.3 + t * 7.4;
    const length = 3.6 * (1 - t * 0.78) + 0.5;
    const spread = 1.7 * (1 - t * 0.7) + 0.35;
    const branches = low ? 4 : 5;
    for (let b = 0; b < branches; b++) {
      const yaw = (b / branches) * Math.PI * 2 + w * 0.45 + random() * 0.25;
      const cx = Math.cos(yaw) * length * 0.42;
      const cz = Math.sin(yaw) * length * 0.42;
      const green = new Color().setHSL(0.31 + random() * 0.03, 0.32 + random() * 0.1, 0.2 + t * 0.07 + random() * 0.04).getHex();
      const flex = 0.25 + t * 0.65;
      // Horizontal spray + vertical cross card keep volume from every angle.
      parts.push(card(length, spread, cx, y, cz, -yaw, -Math.PI / 2 + 0.22, green, flex));
      if (!low) parts.push(card(length, spread * 0.82, cx, y + spread * 0.12, cz, -yaw, 0, green, flex));
    }
  }
  parts.push(card(1.1, 1.8, 0, 10.1, 0, 0, 0, 0x3d5c35, 0.95));
  parts.push(card(1.1, 1.8, 0, 10.1, 0, Math.PI / 2, 0, 0x456b3c, 0.95));
  return merge(parts);
}

function aspen(detail: 'low' | 'full'): BufferGeometry {
  const low = detail === 'low';
  const parts: BufferGeometry[] = [];
  const random = seededRandom(0x2545f491);
  parts.push(tag(new CylinderGeometry(0.08, 0.19, 7.8, 7).translate(0, 3.9, 0), 0xb8b2a2, 0, 0));
  parts.push(tag(new IcosahedronGeometry(1.9, 1).scale(1, 1.2, 0.92).translate(0, 6.7, 0), 0x6f8c42, 0, 0.45));
  if (!low) parts.push(tag(new IcosahedronGeometry(1.35, 1).translate(1.15, 5.9, 0.3), 0x87a04b, 0, 0.5));
  const clusters = low ? 3 : 5;
  for (let i = 0; i < clusters; i++) {
    const yaw = i * 2.39996 + random() * 0.4;
    const y = 4.4 + random() * 2.4;
    const branch = new CylinderGeometry(0.025, 0.05, 1.9, 5);
    branch.rotateZ(Math.PI / 2 - 0.45);
    branch.rotateY(yaw);
    branch.translate(Math.cos(yaw) * 0.8, y, Math.sin(yaw) * 0.8);
    parts.push(tag(branch, 0xa89f8d, 0, 0.12));
    const cx = Math.cos(yaw) * 1.55, cz = Math.sin(yaw) * 1.55;
    const gold = random();
    const green = new Color().setHSL(0.2 + gold * 0.08, 0.42, 0.34 + gold * 0.1).getHex();
    const cards = low ? 2 : 3;
    for (let c = 0; c < cards; c++) {
      parts.push(card(2.5, 2.1, cx, y + 0.55, cz, yaw + c * Math.PI / cards, 0, green, 0.65 + random() * 0.25));
    }
  }
  parts.push(card(2.8, 2.4, 0, 7.3, 0, 0.4, 0, 0x7f9a45, 0.9));
  parts.push(card(2.8, 2.4, 0, 7.3, 0, 0.4 + Math.PI / 2, 0, 0x93a94e, 0.9));
  return merge(parts);
}

function shrub(detail: 'low' | 'full'): BufferGeometry {
  const low = detail === 'low';
  const parts: BufferGeometry[] = [];
  const random = seededRandom(0x9b05688b);
  parts.push(tag(new CylinderGeometry(0.03, 0.06, 0.5, 5).translate(0, 0.25, 0), 0x5a4a35, 0, 0));
  const count = low ? 5 : 8;
  for (let i = 0; i < count; i++) {
    const yaw = i * 2.39996;
    const r = 0.28 + random() * 0.22;
    const x = Math.cos(yaw) * r, z = Math.sin(yaw) * r;
    const y = 0.45 + random() * 0.3;
    const green = new Color().setHSL(0.24 + random() * 0.05, 0.25, 0.3 + random() * 0.1).getHex();
    parts.push(card(1.15, 0.9, x, y, z, yaw, -0.25, green, 0.7));
    if (!low) parts.push(card(1.0, 0.85, x, y, z, yaw + Math.PI / 2, 0.15, green, 0.75));
  }
  return merge(parts);
}

function grass(detail: 'low' | 'full'): BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], uvs: number[] = [], leaves: number[] = [], flex: number[] = [];
  const root = new Color(0x4d6630), tip = new Color(0xa8b96a);
  const random = seededRandom(0x6a09e667);
  const blades = detail === 'low' ? 7 : 10;
  for (let i = 0; i < blades; i++) {
    const angle = i * 2.39996 + random() * 0.4;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const x = dx * 0.22, z = dz * 0.22;
    const height = 0.42 + random() * 0.5;
    const bend = 0.16 + random() * 0.2;
    const width = 0.045 + random() * 0.025;
    const tx = x + dx * bend, tz = z + dz * bend;
    // Two-triangle tapered blade, bent toward its tip.
    const verts = [
      x - dz * width, 0, z + dx * width,
      x + dz * width, 0, z - dx * width,
      tx + dz * width * 0.2, height, tz - dx * width * 0.2,
      tx - dz * width * 0.2, height, tz + dx * width * 0.2,
    ];
    const idx = [0, 1, 2, 0, 2, 3];
    for (const vi of idx) {
      positions.push(verts[vi * 3]!, verts[vi * 3 + 1]!, verts[vi * 3 + 2]!);
      normals.push(-dz * 0.4, 0.8, dx * 0.4);
      const isTip = vi >= 2;
      const c = isTip ? tip : root;
      colors.push(c.r, c.g, c.b);
      uvs.push(vi % 2, isTip ? 1 : 0);
      leaves.push(0);
      flex.push(isTip ? 1 : 0.05);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('leaf', new BufferAttribute(new Float32Array(leaves), 1));
  geometry.setAttribute('plantFlex', new BufferAttribute(new Float32Array(flex), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function rock(): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, 1);
  const p = geometry.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const distortion = 1 + Math.sin(x * 13.7 + z * 7.3) * 0.16 + Math.cos(y * 9.1 + x * 4.2) * 0.08;
    p.setXYZ(i, x * distortion * 1.25, y * 0.62 * distortion + 0.32, z * distortion);
  }
  geometry.computeVertexNormals();
  return tag(geometry, 0x8b8d84, 0, 0);
}

export function createPlantGeometry(kind: PlantKind, detail: 'low' | 'full' = 'full'): BufferGeometry {
  switch (kind) {
    case 'pine': return pine(detail);
    case 'aspen': return aspen(detail);
    case 'shrub': return shrub(detail);
    case 'grass': return grass(detail);
    case 'rock': return rock();
  }
}
