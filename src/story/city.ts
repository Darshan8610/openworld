import {
  BoxGeometry, CanvasTexture, Group, InstancedMesh, Mesh, MeshStandardMaterial,
  PlaneGeometry, RepeatWrapping, Vector3, Matrix4, Quaternion, Color,
} from 'three/webgpu';
import type { TerrainPlateau } from '../world/terrain-field';

/**
 * The Blackwood city district — a GTA-style street grid laid over the flat
 * plateau instead of mountain terrain: asphalt avenues with lane dashes,
 * sidewalked blocks, low-rise storefronts with lit window grids, downtown
 * towers near the centre, street lamps and neon accents.
 *
 * Everything is deterministic (integer hash from cell coords), instanced
 * (~8 draw calls for the whole city) and built from primitives — no external
 * assets, nothing to license. Only the story mode builds it; the infinite
 * world keeps streaming underneath the district.
 */

export interface StoryCityOptions {
  readonly bounds: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
  readonly ground: (x: number, z: number) => number;
  /** Keep clear of authored landmark plots (diner, motel, station, lookout). */
  readonly landmarks: readonly { readonly x: number; readonly z: number }[];
  readonly arrival: { readonly x: number; readonly z: number };
  /** Plateau height — buildings sit on the graded street level. */
  readonly plateau: Pick<TerrainPlateau, 'height'>;
}

const STREET_SPACING = 92;
const STREET_WIDTH = 13;
const SIDEWALK = 4.5;
const INSET = 44;
const HILL_LIMIT = 54; // ground above this is the lookout hill — no streets

function hash2(x: number, z: number): number {
  let n = (x * 374761393 + z * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}

/** Deterministic per-cell values in [0, 1). */
function rand(x: number, z: number, salt: number): number {
  return hash2(x * 31 + salt, z * 17 - salt) / 0xffffffff;
}

function makeWindowTexture(cols: number, rows: number, seedSalt: number): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#14181d';
  ctx.fillRect(0, 0, 128, 256);
  const cellW = 128 / cols; const cellH = 256 / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const roll = rand(col, row, seedSalt);
      const lit = roll > 0.52;
      const warm = rand(col, row, seedSalt + 7) > 0.3;
      ctx.fillStyle = lit ? (warm ? '#ffd9a0' : '#bfe0ff') : '#0c0f13';
      const padX = cellW * 0.24; const padY = cellH * 0.28;
      ctx.fillRect(col * cellW + padX, row * cellH + padY, cellW - padX * 2, cellH - padY * 2);
      // Frame
      ctx.strokeStyle = '#232a31';
      ctx.lineWidth = 1;
      ctx.strokeRect(col * cellW + padX, row * cellH + padY, cellW - padX * 2, cellH - padY * 2);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = 'srgb';
  return texture;
}

export class StoryCity {
  readonly group = new Group();
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly options: StoryCityOptions) {
    this.group.name = 'story/city';
    this.build();
  }

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as Mesh | InstancedMesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          const single = entry as MeshStandardMaterial;
          single.map?.dispose();
          (single.emissiveMap as CanvasTexture | undefined)?.dispose();
          single.dispose();
        }
      } else if (material) {
        const single = material as MeshStandardMaterial;
        single.map?.dispose();
        (single.emissiveMap as CanvasTexture | undefined)?.dispose();
        single.dispose();
      }
    });
    for (const entry of this.disposables) entry.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  // ---- layout --------------------------------------------------------------

  private cellCoords(): { xs: number[]; zs: number[] } {
    const { bounds } = this.options;
    const xs: number[] = [];
    const zs: number[] = [];
    for (let x = bounds.minX + INSET; x <= bounds.maxX - INSET; x += STREET_SPACING) xs.push(Math.round(x));
    for (let z = bounds.minZ + INSET; z <= bounds.maxZ - INSET; z += STREET_SPACING) zs.push(Math.round(z));
    return { xs, zs };
  }

  private clearOfLandmarks(x: number, z: number, radius: number): boolean {
    for (const point of [...this.options.landmarks, this.options.arrival]) {
      if (Math.hypot(point.x - x, point.z - z) < radius) return false;
    }
    return true;
  }

  private build(): void {
    const { bounds, ground } = this.options;
    const { xs, zs } = this.cellCoords();
    const midX = (bounds.minX + bounds.maxX) / 2;
    const midZ = (bounds.minZ + bounds.maxZ) / 2;

    const asphalt = new MeshStandardMaterial({ color: 0x17191c, roughness: 0.94, metalness: 0.02 });
    const concrete = new MeshStandardMaterial({ color: 0x3d4147, roughness: 0.92 });
    const paint = new MeshStandardMaterial({ color: 0xd8d5c8, roughness: 0.8, emissive: 0x3a3a33, emissiveIntensity: 0.25 });
    const poleMat = new MeshStandardMaterial({ color: 0x2b3036, roughness: 0.5, metalness: 0.7 });
    const lampMat = new MeshStandardMaterial({ color: 0x1a1408, emissive: 0xffc766, emissiveIntensity: 2.4, roughness: 0.4 });
    const roofMat = new MeshStandardMaterial({ color: 0x101214, roughness: 1 });
    this.disposables.push(asphalt, concrete, paint, poleMat, lampMat, roofMat);

    const facadeTextures = [
      makeWindowTexture(4, 8, 11),
      makeWindowTexture(5, 10, 29),
      makeWindowTexture(3, 7, 47),
    ];
    const facadeMats = facadeTextures.map((texture) => {
      const mat = new MeshStandardMaterial({
        color: 0x1a1e24,
        roughness: 0.85,
        metalness: 0.08,
        map: texture ?? null,
        emissive: new Color(0xffe8c8),
        emissiveMap: texture ?? null,
        emissiveIntensity: texture ? 0.85 : 0,
      });
      this.disposables.push(mat);
      if (texture) this.disposables.push(texture);
      return mat;
    });
    const facadeMaterials = [...facadeMats, roofMat] as MeshStandardMaterial[];

    const unitBox = new BoxGeometry(1, 1, 1);
    const flatPlane = new PlaneGeometry(1, 1);
    this.disposables.push(unitBox, flatPlane);

    // Collect instances first, then build instanced meshes (8-ish draw calls).
    const street: Matrix4[] = [];
    const dash: Matrix4[] = [];
    const sidewalk: Matrix4[] = [];
    const poles: Matrix4[] = [];
    const heads: Matrix4[] = [];
    const buildingGroups: Matrix4[][] = [[], [], []];
    const neon: Matrix4[] = [];
    const neonCyan: Matrix4[] = [];
    const m = new Matrix4();
    const q = new Quaternion();
    const put = (list: Matrix4[], x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0) => {
      q.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      m.compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz));
      list.push(m.clone());
    };

    const yAt = (x: number, z: number) => ground(x, z);
    const flat = (x: number, z: number) => yAt(x, z) < HILL_LIMIT;

    // Streets: N-S and E-W avenues on the grid, paved in 24 m segments so
    // the lookout hill (ground above HILL_LIMIT) is never asphalted over.
    const z0 = bounds.minZ + INSET; const z1 = bounds.maxZ - INSET;
    const x0 = bounds.minX + INSET; const x1 = bounds.maxX - INSET;
    for (const x of xs) {
      for (let z = z0; z < z1; z += 24) {
        const mid = z + 12;
        if (!flat(x, mid)) continue;
        put(street, x, yAt(x, mid) + 0.05, mid, STREET_WIDTH, 0.1, 25);
        for (let d = z + 6; d < z + 24; d += 11) put(dash, x, yAt(x, d) + 0.11, d, 0.34, 0.04, 4.6);
        if (Math.abs(((z - z0) % STREET_SPACING)) < 1 && flat(x, z)) {
          const side = (Math.floor((z - z0) / STREET_SPACING) % 2 === 0) ? 1 : -1;
          const px = x + side * (STREET_WIDTH / 2 + 1.4);
          put(poles, px, yAt(px, z) + 3, z, 0.16, 6, 0.16);
          put(heads, px - side * 0.9, yAt(px, z) + 6.1, z, 1.5, 0.18, 0.4);
        }
      }
    }
    for (const z of zs) {
      for (let x = x0; x < x1; x += 24) {
        const mid = x + 12;
        if (!flat(mid, z)) continue;
        put(street, mid, yAt(mid, z) + 0.05, z, 25, 0.1, STREET_WIDTH);
        for (let d = x + 6; d < x + 24; d += 11) put(dash, d, yAt(d, z) + 0.11, z, 4.6, 0.04, 0.34);
        if (Math.abs(((x - x0) % STREET_SPACING)) < 1 && flat(x, z)) {
          const side = (Math.floor((x - x0) / STREET_SPACING) % 2 === 0) ? -1 : 1;
          const pz = z + side * (STREET_WIDTH / 2 + 1.4);
          put(poles, x, yAt(x, pz) + 3, pz, 0.16, 6, 0.16);
          put(heads, x, yAt(x, pz) + 6.1, pz - side * 0.9, 0.4, 0.18, 1.5);
        }
      }
    }

    // Blocks: sidewalk slab + 1–3 buildings per cell.
    for (let i = 0; i + 1 < xs.length; i++) {
      for (let j = 0; j + 1 < zs.length; j++) {
        const cx = (xs[i]! + xs[i + 1]!) / 2;
        const cz = (zs[j]! + zs[j + 1]!) / 2;
        if (!flat(cx, cz)) continue;
        if (!this.clearOfLandmarks(cx, cz, 46)) continue;
        const cellW = xs[i + 1]! - xs[i]! - STREET_WIDTH;
        const cellD = zs[j + 1]! - zs[j]! - STREET_WIDTH;
        if (cellW <= 10 || cellD <= 10) continue;
        const baseY = yAt(cx, cz);
        put(sidewalk, cx, baseY + 0.12, cz, cellW + SIDEWALK, 0.24, cellD + SIDEWALK);

        const downtown = Math.hypot(cx - midX, cz - midZ) < 300;
        const count = 1 + Math.floor(rand(i, j, 3) * 3);
        for (let b = 0; b < count; b++) {
          const rx = rand(i * 7 + b, j * 13 - b, 5);
          const rz = rand(i * 11 - b, j * 5 + b, 9);
          const rw = rand(i + b, j - b, 13);
          const rh = rand(i * 3 + b, j * 3 + b, 17);
          const bw = 16 + rw * 16;
          const bd = 14 + rz * 15;
          let bh = 9 + rh * 26 + (downtown ? 12 : 0);
          if (downtown && rw > 0.82) bh += 26; // a couple of towers
          const ox = (rx - 0.5) * Math.max(4, cellW - bw - 4);
          const oz = (rz - 0.5) * Math.max(4, cellD - bd - 4);
          const bx = cx + ox; const bz = cz + oz;
          if (!this.clearOfLandmarks(bx, bz, 34)) continue;
          const variant = hash2(i * 5 + b, j * 7 - b) % 3;
          put(buildingGroups[variant]!, bx, baseY + 0.24 + bh / 2, bz, bw, bh, bd, (rw - 0.5) * 0.14);
          // Neon accent strips on a minority of facades.
          if (rw > 0.74 && downtown) {
            const target = rz > 0.5 ? neon : neonCyan;
            put(target, bx, baseY + 0.24 + bh * 0.72, bz + bd / 2 + 0.2, bw * 0.7, 1.1, 0.3);
          }
        }
      }
    }

    // Build instanced meshes.
    const addInstances = (geometry: import('three/webgpu').BufferGeometry, material: import('three/webgpu').Material | import('three/webgpu').Material[], matrices: Matrix4[]) => {
      if (matrices.length === 0) return;
      const mesh = new InstancedMesh(geometry, material, matrices.length);
      for (const [index, matrix] of matrices.entries()) mesh.setMatrixAt(index, matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      this.group.add(mesh);
    };

    addInstances(this.orientedBox(), asphalt, street);
    addInstances(this.orientedBox(), paint, dash);
    addInstances(this.orientedBox(), concrete, sidewalk);
    addInstances(this.orientedBox(), poleMat, poles);
    addInstances(this.orientedBox(), lampMat, heads);
    for (const [index, matrices] of buildingGroups.entries()) {
      // Multi-material box: 4 facades + roof.
      addInstances(unitBox, [facadeMaterials[index]!, facadeMaterials[index]!, facadeMaterials[index]!, facadeMaterials[index]!, roofMat, roofMat], matrices);
    }
    const neonMagenta = new MeshStandardMaterial({ color: 0x12040f, emissive: 0xff2fa8, emissiveIntensity: 2.6, roughness: 0.5 });
    const neonCyanMat = new MeshStandardMaterial({ color: 0x041012, emissive: 0x2fe8ff, emissiveIntensity: 2.4, roughness: 0.5 });
    this.disposables.push(neonMagenta, neonCyanMat);
    addInstances(this.orientedBox(), neonMagenta, neon);
    addInstances(this.orientedBox(), neonCyanMat, neonCyan);
  }

  /** Unit box with Y up already — BoxGeometry's default orientation. */
  private orientedBox(): BoxGeometry {
    return new BoxGeometry(1, 1, 1);
  }
}
