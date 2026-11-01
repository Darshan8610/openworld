import { BufferGeometry, BufferAttribute, Color, IcosahedronGeometry, CylinderGeometry, ConeGeometry } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlantKind } from '../world/vegetation-field';

function colored(geometry: BufferGeometry, hex: number): BufferGeometry {
  geometry.deleteAttribute('uv');
  const color = new Color(hex), colors = new Float32Array(geometry.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) { colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b; }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}
function merge(parts: BufferGeometry[]): BufferGeometry {
  // Primitive crowns are non-indexed; cylinders/cones are indexed. Normalize
  // before merging so the same vertex-colored material can draw the whole plant.
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

/** Low-poly but shaded silhouettes; one vertex-colored draw per species. */
export function createPlantGeometry(kind: PlantKind): BufferGeometry {
  if (kind === 'pine') {
    const trunk = colored(new CylinderGeometry(0.14, 0.27, 6, 6).translate(0, 3, 0), 0x554638);
    const lower = colored(new ConeGeometry(2.25, 5.4, 8).translate(0, 5.1, 0), 0x294c3b);
    const middle = colored(new ConeGeometry(1.72, 4.8, 8).translate(0, 7.25, 0), 0x365d43);
    const crown = colored(new ConeGeometry(1.12, 3.8, 7).translate(0, 9.3, 0), 0x456b4c);
    return merge([trunk, lower, middle, crown]);
  }
  if (kind === 'aspen') {
    const trunk = colored(new CylinderGeometry(0.11, 0.21, 6.8, 6).translate(0, 3.4, 0), 0xa9a394);
    const crown = colored(new IcosahedronGeometry(2.25, 1).scale(1, 1.25, 0.92).translate(0, 6.7, 0), 0x77934b);
    const side = colored(new IcosahedronGeometry(1.55, 1).translate(1.35, 5.8, 0.35), 0x91a653);
    return merge([trunk, crown, side]);
  }
  if (kind === 'shrub') {
    const a = colored(new IcosahedronGeometry(0.8, 1).scale(1, 0.72, 0.85).translate(0, 0.5, 0), 0x657953);
    const b = colored(new IcosahedronGeometry(0.55, 0).translate(0.5, 0.38, 0.15), 0x829064);
    return merge([a, b]);
  }
  if (kind === 'rock') {
    const geometry = new IcosahedronGeometry(1, 1);
    const p = geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const distortion = 1 + Math.sin(x * 13 + z * 7) * 0.13;
      p.setXYZ(i, x * distortion * 1.2, y * 0.65 * distortion + 0.35, z * distortion);
    }
    geometry.computeVertexNormals();
    return colored(geometry, 0x8b8d84);
  }
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const root = new Color(0x526b35), tip = new Color(0xa4b568);
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.39996, dx = Math.cos(angle), dz = Math.sin(angle);
    const x = dx * 0.24, z = dz * 0.24, height = 0.48 + (i % 3) * 0.17;
    positions.push(x - dz * 0.065, 0, z + dx * 0.065, x + dz * 0.065, 0, z - dx * 0.065, x + dx * 0.2, height, z + dz * 0.2);
    for (let v = 0; v < 3; v++) { normals.push(-dz * 0.5, 0.85, dx * 0.5); const c = v === 2 ? tip : root; colors.push(c.r, c.g, c.b); }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeBoundingSphere();
  return geometry;
}
