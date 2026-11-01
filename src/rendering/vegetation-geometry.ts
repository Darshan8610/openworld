import { BufferGeometry, BufferAttribute, Color, IcosahedronGeometry, CylinderGeometry, PlaneGeometry } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlantKind } from '../world/vegetation-field';
import { seededRandom } from '../utils/random';

/**
 * One merged, vertex-colored geometry per species. Foliage is carried on cheap
 * crossed cards with alpha-tested procedural sprays; trunks/branches are solid.
 * `leaf` selects texture alpha, `plantFlex` weights wind, `flower` marks forb
 * heads inside the grass batch so the shader can hide them per instance.
 */
function tag(geometry: BufferGeometry, hex: number, leaf: number, flex: number, flower = 0): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  const color = new Color(hex);
  const colors = new Float32Array(count * 3);
  const leaves = new Float32Array(count);
  const flexes = new Float32Array(count);
  const flowers = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    leaves[i] = leaf;
    flexes[i] = flex;
    flowers[i] = flower;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('leaf', new BufferAttribute(leaves, 1));
  geometry.setAttribute('plantFlex', new BufferAttribute(flexes, 1));
  geometry.setAttribute('flower', new BufferAttribute(flowers, 1));
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

function card(width: number, height: number, x: number, y: number, z: number, yaw: number, tilt: number, hex: number, flex: number, flower = 0): BufferGeometry {
  const geometry = new PlaneGeometry(width, height, 1, 1);
  geometry.rotateX(tilt);
  geometry.rotateY(yaw);
  geometry.translate(x, y, z);
  return tag(geometry, hex, 1, flex, flower);
}

/** Tapered trunk with subtle per-vertex bark colour break-up. */
function trunk(topRadius: number, baseRadius: number, height: number, hex: number, segments = 8): BufferGeometry {
  const geometry = new CylinderGeometry(topRadius, baseRadius, height, segments, 4).translate(0, height / 2, 0);
  const count = geometry.getAttribute('position').count;
  const base = new Color(hex);
  const colors = new Float32Array(count * 3);
  const random = seededRandom(0x2371a9);
  for (let i = 0; i < count; i++) {
    const shade = 0.8 + random() * 0.35;
    colors[i * 3] = base.r * shade; colors[i * 3 + 1] = base.g * shade; colors[i * 3 + 2] = base.b * shade;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const leaves = new Float32Array(count);
  const flexes = new Float32Array(count);
  const flowers = new Float32Array(count);
  geometry.setAttribute('leaf', new BufferAttribute(leaves, 1));
  geometry.setAttribute('plantFlex', new BufferAttribute(flexes, 1));
  geometry.setAttribute('flower', new BufferAttribute(flowers, 1));
  if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  return geometry;
}

function pine(detail: 'low' | 'full'): BufferGeometry {
  const low = detail === 'low';
  const parts: BufferGeometry[] = [];
  const random = seededRandom(0x51ed270b);
  const height = 14;
  parts.push(trunk(0.10, 0.36, height, 0x4a3826, low ? 6 : 8));

  // Natural conifer: irregular whorls of drooping branch sprays, no solid cone.
  const whorls = low ? 7 : 13;
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y = 1.1 + t * (height - 2.2);
    const crown = Math.pow(1 - t, 0.82);
    const length = 4.9 * crown + 0.55;
    const spread = 2.5 * crown + 0.42;
    const branches = low ? 4 : 7;
    const droop = 0.16 + t * 0.1;
    for (let b = 0; b < branches; b++) {
      const yaw = (b / branches) * Math.PI * 2 + w * 0.52 + (random() - 0.5) * 0.4;
      const len = length * (0.82 + random() * 0.32);
      const cx = Math.cos(yaw) * len * 0.46;
      const cz = Math.sin(yaw) * len * 0.46;
      const light = 0.30 + t * 0.10 + random() * 0.07;
      const green = new Color().setHSL(0.32 + (random() - 0.5) * 0.045, 0.34 + random() * 0.12, light).getHex();
      const flex = 0.22 + t * 0.62;
      // Horizontal spray reads from above; two angled side cards give volume.
      parts.push(card(len, spread, cx, y - droop * len * 0.22, cz, -yaw, -Math.PI / 2 + droop, green, flex));
      parts.push(card(len * 0.94, spread * 0.78, cx, y + spread * 0.1, cz, -yaw + 0.5, -0.28, green, flex));
      if (!low) parts.push(card(len * 0.94, spread * 0.78, cx, y + spread * 0.1, cz, -yaw - 0.5, 0.28, green, flex));
    }
  }
  // Dense inner tufts close the silhouette around the leader.
  const tufts = low ? 3 : 6;
  for (let i = 0; i < tufts; i++) {
    const y = height * (0.45 + i * 0.11);
    const size = 1.7 * (1 - i / tufts) + 0.5;
    const green = new Color().setHSL(0.33, 0.40, 0.26 + i * 0.025).getHex();
    parts.push(card(size, size * 1.4, 0, y, 0, i * 1.1, 0, green, 0.5 + i * 0.1));
    parts.push(card(size, size * 1.4, 0, y, 0, i * 1.1 + Math.PI / 2, 0, green, 0.5 + i * 0.1));
  }
  parts.push(card(0.9, 1.7, 0, height - 0.4, 0, 0.3, 0, 0x3f6034, 0.95));
  parts.push(card(0.9, 1.7, 0, height - 0.4, 0, 0.3 + Math.PI / 2, 0, 0x476b3a, 0.95));
  return merge(parts);
}

function aspen(detail: 'low' | 'full'): BufferGeometry {
  const low = detail === 'low';
  const parts: BufferGeometry[] = [];
  const random = seededRandom(0x2545f491);
  const height = 10.5;
  parts.push(trunk(0.07, 0.22, height, 0xcfc8b6, low ? 6 : 8));

  // Visible branches carrying leaf-cluster cards through an ellipsoid crown.
  const branches = low ? 5 : 8;
  for (let i = 0; i < branches; i++) {
    const yaw = i * 2.39996 + (random() - 0.5) * 0.5;
    const y = height * (0.46 + random() * 0.34);
    const reach = 1.5 + random() * 1.2;
    const branch = new CylinderGeometry(0.02, 0.05, reach, 5);
    branch.rotateZ(Math.PI / 2 - 0.42 - random() * 0.2);
    branch.rotateY(yaw);
    branch.translate(Math.cos(yaw) * reach * 0.42, y, Math.sin(yaw) * reach * 0.42);
    parts.push(tag(branch, 0xb9b09c, 0, 0.12));
  }

  const clusters = low ? 7 : 16;
  for (let i = 0; i < clusters; i++) {
    const t = i / clusters;
    const yaw = i * 2.39996 + random() * 0.4;
    const ring = Math.sin(t * Math.PI) * 2.1 + 0.25;
    const cx = Math.cos(yaw) * ring * (0.7 + random() * 0.4);
    const cz = Math.sin(yaw) * ring * (0.7 + random() * 0.4);
    const cy = height * (0.52 + t * 0.42) + (random() - 0.5) * 0.7;
    const size = (low ? 2.3 : 2.7) * (0.75 + random() * 0.45);
    const gold = random();
    const green = new Color().setHSL(0.21 + gold * 0.075, 0.50, 0.38 + gold * 0.14).getHex();
    const cardsPerCluster = low ? 2 : 3;
    for (let c = 0; c < cardsPerCluster; c++) {
      parts.push(card(size, size * 0.86, cx, cy, cz, yaw + c * Math.PI / cardsPerCluster + random() * 0.3, (random() - 0.5) * 0.5, green, 0.6 + random() * 0.3));
    }
  }
  return merge(parts);
}

function shrub(detail: 'low' | 'full'): BufferGeometry {
  const low = detail === 'low';
  const parts: BufferGeometry[] = [];
  const random = seededRandom(0x9b05688b);
  const stems = low ? 2 : 5;
  for (let i = 0; i < stems; i++) {
    const yaw = i * 2.39996;
    const stem = new CylinderGeometry(0.018, 0.045, 0.62, 5);
    stem.rotateZ(0.28);
    stem.rotateY(yaw);
    stem.translate(Math.cos(yaw) * 0.12, 0.28, Math.sin(yaw) * 0.12);
    parts.push(tag(stem, 0x5a4632, 0, 0.08));
  }
  const count = low ? 7 : 16;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const yaw = i * 2.39996 + random() * 0.3;
    const r = 0.18 + Math.sin(t * Math.PI) * 0.42;
    const x = Math.cos(yaw) * r, z = Math.sin(yaw) * r;
    const y = 0.34 + t * 0.62 + random() * 0.16;
    const size = 0.95 + random() * 0.5;
    const green = new Color().setHSL(0.25 + random() * 0.06, 0.32 + random() * 0.12, 0.34 + random() * 0.14).getHex();
    parts.push(card(size, size * 0.8, x, y, z, yaw, -0.2 + random() * 0.4, green, 0.7));
    if (!low) parts.push(card(size * 0.9, size * 0.75, x, y, z, yaw + Math.PI / 2, 0.15, green, 0.75));
  }
  return merge(parts);
}

function grass(detail: 'low' | 'full'): BufferGeometry {
  const low = detail === 'low';
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], uvs: number[] = [];
  const leaves: number[] = [], flex: number[] = [], flowers: number[] = [];
  const random = seededRandom(0x6a09e667);
  const root = new Color(0x46632c), mid = new Color(0x7ba044), tip = new Color(0xb9c97e);

  const pushVertex = (x: number, y: number, z: number, nx: number, nz: number, c: Color, u: number, v: number, f: number, flower: number) => {
    positions.push(x, y, z);
    normals.push(nx, 0.82, nz);
    colors.push(c.r, c.g, c.b);
    uvs.push(u, v);
    leaves.push(0);
    flex.push(f);
    flowers.push(flower);
  };

  const blades = detail === 'low' ? 10 : 26;
  for (let i = 0; i < blades; i++) {
    const angle = i * 2.39996 + (random() - 0.5) * 0.5;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const r0 = random() * 0.24;
    const x = dx * r0, z = dz * r0;
    const height = 0.4 + random() * 0.62;
    const bend = 0.14 + random() * 0.3;
    const width = 0.045 + random() * 0.035;
    const dry = random();
    const tint = new Color().lerpColors(mid, tip, dry * 0.6);
    // Curved blade with a mid segment: root -> knee -> tip.
    const mx = x + dx * bend * 0.38, mz = z + dz * bend * 0.38, my = height * 0.58;
    const tx = x + dx * bend, tz = z + dz * bend, ty = height;
    const wMid = width * 0.72, wTip = width * 0.14;
    const verts: [number, number, number, Color, number, number][] = [
      [x - dz * width, 0, z + dx * width, root, 0, 0],
      [x + dz * width, 0, z - dx * width, root, 1, 0],
      [mx - dz * wMid, my, mz + dx * wMid, tint, 0, 0.58],
      [mx + dz * wMid, my, mz - dx * wMid, tint, 1, 0.58],
      [tx - dz * wTip, ty, tz + dx * wTip, tip, 0, 1],
      [tx + dz * wTip, ty, tz - dx * wTip, tip, 1, 1],
    ];
    const idx = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4];
    for (const vi of idx) {
      const v = verts[vi]!;
      const f = vi <= 1 ? 0.04 : vi <= 3 ? 0.5 : 1;
      pushVertex(v[0], v[1], v[2], -dz * 0.42, dx * 0.42, v[3], v[4], v[5], f, 0);
    }
    // Occasional tan seed head on the tallest blades.
    if (!low && height > 0.8 && random() < 0.5) {
      const hw = 0.05, hh = 0.16;
      const head = new Color(0xc9b26a);
      const q: [number, number, number][] = [
        [tx - dz * hw, ty, tz + dx * hw], [tx + dz * hw, ty, tz - dx * hw],
        [tx - dz * hw * 0.4, ty + hh, tz + dx * hw * 0.4], [tx + dz * hw * 0.4, ty + hh, tz - dx * hw * 0.4],
      ];
      for (const vi of [0, 1, 2, 1, 3, 2]) {
        const v = q[vi]!;
        pushVertex(v[0], v[1], v[2], -dz * 0.4, dx * 0.4, head, vi % 2, vi >= 2 ? 1 : 0, 1, 0);
      }
    }
  }

  // Forb heads: a few slender stems with coloured flower cards. The shader
  // collapses these vertices per instance via plantMeta.z, so only some clumps
  // bloom and the batch count stays at five.
  if (!low) {
    const petalColors = [0xf2efdc, 0xe8c84a, 0xb78bc9, 0xe8a15c];
    const forbs = 3;
    for (let i = 0; i < forbs; i++) {
      const angle = random() * Math.PI * 2;
      const dx = Math.cos(angle), dz = Math.sin(angle);
      const x = dx * (0.1 + random() * 0.2), z = dz * (0.1 + random() * 0.2);
      const h = 0.5 + random() * 0.34;
      const stem = new Color(0x55703a);
      const sw = 0.014;
      const sv: [number, number, number][] = [
        [x - dz * sw, 0, z + dx * sw], [x + dz * sw, 0, z - dx * sw],
        [x - dz * sw, h, z + dx * sw], [x + dz * sw, h, z - dx * sw],
      ];
      for (const vi of [0, 1, 2, 1, 3, 2]) {
        const v = sv[vi]!;
        pushVertex(v[0], v[1], v[2], -dz * 0.4, dx * 0.4, stem, vi % 2, vi >= 2 ? 1 : 0, vi >= 2 ? 0.9 : 0.05, 1);
      }
      const petal = new Color(petalColors[i % petalColors.length]!);
      const centre = new Color(0xd9b23a);
      const fw = 0.075;
      for (let c = 0; c < 2; c++) {
        const yaw = angle + c * Math.PI / 2;
        const fx = Math.cos(yaw), fz = Math.sin(yaw);
        const fv: [number, number, number, Color][] = [
          [x - fx * fw, h - fw * 0.4, z - fz * fw, petal],
          [x + fx * fw, h - fw * 0.4, z + fz * fw, petal],
          [x - fx * fw * 0.7, h + fw * 1.1, z - fz * fw * 0.7, petal],
          [x + fx * fw * 0.7, h + fw * 1.1, z + fz * fw * 0.7, petal],
        ];
        for (const vi of [0, 1, 2, 1, 3, 2]) {
          const v = fv[vi]!;
          pushVertex(v[0], v[1], v[2], -fz * 0.3, fx * 0.3, vi >= 2 && vi <= 3 ? centre : v[3], vi % 2, vi >= 2 ? 1 : 0, 1, 1);
        }
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('leaf', new BufferAttribute(new Float32Array(leaves), 1));
  geometry.setAttribute('plantFlex', new BufferAttribute(new Float32Array(flex), 1));
  geometry.setAttribute('flower', new BufferAttribute(new Float32Array(flowers), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function rock(detail: 'low' | 'full'): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, detail === 'low' ? 1 : 2);
  const p = geometry.getAttribute('position');
  const random = seededRandom(0x7c31f0a3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const distortion = 1 + Math.sin(x * 13.7 + z * 7.3) * 0.17 + Math.cos(y * 9.1 + x * 4.2) * 0.1 + (random() - 0.5) * 0.08;
    p.setXYZ(i, x * distortion * 1.28, Math.max(-0.18, y * 0.62 * distortion + 0.3), z * distortion);
  }
  geometry.computeVertexNormals();
  const n = geometry.getAttribute('normal');
  const count = p.count;
  const colors = new Float32Array(count * 3);
  const stone = new Color(0x87897f), moss = new Color(0x6d7a52), dark = new Color(0x5f6158);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    const up = Math.max(0, n.getY(i));
    c.copy(stone).lerp(moss, up * up * 0.55).lerp(dark, Math.max(0, -n.getY(i)) * 0.4);
    const shade = 0.86 + random() * 0.26;
    colors[i * 3] = c.r * shade; colors[i * 3 + 1] = c.g * shade; colors[i * 3 + 2] = c.b * shade;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('leaf', new BufferAttribute(new Float32Array(count), 1));
  geometry.setAttribute('plantFlex', new BufferAttribute(new Float32Array(count), 1));
  geometry.setAttribute('flower', new BufferAttribute(new Float32Array(count), 1));
  if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createPlantGeometry(kind: PlantKind, detail: 'low' | 'full' = 'full'): BufferGeometry {
  switch (kind) {
    case 'pine': return pine(detail);
    case 'aspen': return aspen(detail);
    case 'shrub': return shrub(detail);
    case 'grass': return grass(detail);
    case 'rock': return rock(detail);
  }
}
