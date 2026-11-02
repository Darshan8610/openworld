import {
  AdditiveBlending, BoxGeometry, CanvasTexture, Color, CylinderGeometry, Group, InstancedMesh,
  Mesh, MeshStandardMaterial, Matrix4, Points, PointsMaterial, BufferGeometry,
  Float32BufferAttribute, Quaternion, RepeatWrapping, Vector3,
} from 'three/webgpu';
import type { TerrainPlateau } from '../world/terrain-field';

/**
 * The Blackwood city district — a GTA-style street grid laid over the flat
 * plateau instead of mountain terrain: asphalt avenues with lane dashes and
 * crosswalks, sidewalked blocks, tinted storefronts with lit window grids,
 * gable-roofed houses on the outskirts, downtown towers, parked cars,
 * street lamps with additive glow halos and neon accents.
 *
 * Everything is deterministic (integer hash from cell coords), instanced
 * (~12 draw calls for the whole city) and built from primitives — no external
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

/** Per-building facade tints (multiplied over the window texture). */
const FACADE_TINTS = [0xd8d2c4, 0xc6cfda, 0xd9c3b4, 0xcdd6c4, 0xe0d3ae, 0xc9ced6, 0xd4c8d2, 0xc4d2cf];
/** Gable roof tints — slate, moss, terracotta, charcoal. */
const ROOF_TINTS = [0x8f9aa8, 0x7f9482, 0xb08a74, 0x8a8580, 0x9d8f9e];
/** Parked-car palette. */
const CAR_TINTS = [0x9fb4c8, 0xc8c3b8, 0x8a2f2f, 0x2f3a4a, 0x5b6b4f, 0xd8d8dc, 0x394047, 0xb09a6a];

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

/** Soft radial halo used for lamp glows (additive points). */
function makeGlowTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(255, 214, 150, 1)');
  gradient.addColorStop(0.35, 'rgba(255, 190, 110, 0.45)');
  gradient.addColorStop(1, 'rgba(255, 170, 80, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
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
      const mesh = object as Mesh | InstancedMesh | Points;
      mesh.geometry?.dispose();
      const material = mesh.material as MeshStandardMaterial | MeshStandardMaterial[] | PointsMaterial | undefined;
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
        (single as unknown as PointsMaterial).map?.dispose();
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

    const asphalt = new MeshStandardMaterial({ color: 0x17191c, roughness: 0.82, metalness: 0.08 });
    const concrete = new MeshStandardMaterial({ color: 0x3d4147, roughness: 0.92 });
    const paint = new MeshStandardMaterial({ color: 0xd8d5c8, roughness: 0.8, emissive: 0x3a3a33, emissiveIntensity: 0.3 });
    const poleMat = new MeshStandardMaterial({ color: 0x2b3036, roughness: 0.5, metalness: 0.7 });
    const lampMat = new MeshStandardMaterial({ color: 0x1a1408, emissive: 0xffc766, emissiveIntensity: 3.4, roughness: 0.4 });
    const roofMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    const carBodyMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.55 });
    const carGlassMat = new MeshStandardMaterial({ color: 0x171d24, roughness: 0.16, metalness: 0.7 });
    const shopGlowMat = new MeshStandardMaterial({ color: 0x14110c, emissive: 0xffd9a0, emissiveIntensity: 2.1, roughness: 0.6 });
    this.disposables.push(asphalt, concrete, paint, poleMat, lampMat, roofMat, carBodyMat, carGlassMat, shopGlowMat);

    const facadeTextures = [
      makeWindowTexture(4, 8, 11),
      makeWindowTexture(5, 10, 29),
      makeWindowTexture(3, 7, 47),
    ];
    const facadeMats = facadeTextures.map((texture) => {
      const mat = new MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.85,
        metalness: 0.08,
        map: texture ?? null,
        emissive: new Color(0xffe8c8),
        emissiveMap: texture ?? null,
        emissiveIntensity: texture ? 1.15 : 0,
      });
      this.disposables.push(mat);
      if (texture) this.disposables.push(texture);
      return mat;
    });
    const roofMaterial = roofMat;

    const unitBox = new BoxGeometry(1, 1, 1);
    // Triangular prism: ridge along Z, apex up — the gable roof.
    const roofPrism = new CylinderGeometry(1, 1, 1, 3, 1, false).rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
    this.disposables.push(unitBox, roofPrism);

    // Collect instances first, then build instanced meshes (~12 draw calls).
    const street: Matrix4[] = [];
    const dash: Matrix4[] = [];
    const crosswalk: Matrix4[] = [];
    const sidewalk: Matrix4[] = [];
    const poles: Matrix4[] = [];
    const heads: Matrix4[] = [];
    const glowPositions: number[] = [];
    const buildingGroups: { matrices: Matrix4[]; tints: Color[] }[] = [
      { matrices: [], tints: [] }, { matrices: [], tints: [] }, { matrices: [], tints: [] },
    ];
    const roofs: Matrix4[] = [];
    const roofTints: Color[] = [];
    const carBodies: Matrix4[] = [];
    const carTops: Matrix4[] = [];
    const carTints: Color[] = [];
    const shopGlow: Matrix4[] = [];
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
    const tint = (hex: number) => new Color(hex);

    // Streets: N-S and E-W avenues in 24 m segments (the lookout hill is
    // never asphalted), with lane dashes, crosswalks and lamp runs.
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
          const hy = yAt(px, z) + 6.1;
          put(heads, px - side * 0.9, hy, z, 1.5, 0.18, 0.4);
          glowPositions.push(px - side * 0.9, hy, z);
          // Parked cars along the curb (skip intersection zones).
          if (((z - z0) % (STREET_SPACING * 2)) === 24 && flat(x, z + 30)) {
            const cy = yAt(x, z + 30);
            const lane = side * 3.9;
            const index = carTints.length;
            put(carBodies, x + lane, cy + 0.62, z + 30, 1.85, 0.78, 4.3, 0.02);
            put(carTops, x + lane, cy + 1.28, z + 29.4, 1.66, 0.6, 2.2, 0.02);
            carTints.push(tint(CAR_TINTS[index % CAR_TINTS.length]!));
          }
        }
      }
      // Crosswalk bars at each intersection this avenue crosses.
      for (const z of zs) {
        if (!flat(x, z)) continue;
        const gy = yAt(x, z) + 0.12;
        for (let i = -2; i <= 2; i++) {
          put(crosswalk, x + i * 1.6, gy, z + STREET_WIDTH / 2 + 2.4, 1.0, 0.05, 2.4);
          put(crosswalk, x + i * 1.6, gy, z - STREET_WIDTH / 2 - 2.4, 1.0, 0.05, 2.4);
          put(crosswalk, x + STREET_WIDTH / 2 + 2.4, gy, z + i * 1.6, 2.4, 0.05, 1.0);
          put(crosswalk, x - STREET_WIDTH / 2 - 2.4, gy, z + i * 1.6, 2.4, 0.05, 1.0);
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
          const hy = yAt(x, pz) + 6.1;
          put(heads, x, hy, pz - side * 0.9, 0.4, 0.18, 1.5);
          glowPositions.push(x, hy, pz - side * 0.9);
          if (((x - x0) % (STREET_SPACING * 2)) === 48 && flat(x + 30, z)) {
            const cy = yAt(x + 30, z);
            const lane = side * 3.9;
            const index = carTints.length;
            put(carBodies, x + 30, cy + 0.62, z + lane, 4.3, 0.78, 1.85, Math.PI / 2 + 0.02);
            put(carTops, x + 29.4, cy + 1.28, z + lane, 2.2, 0.6, 1.66, Math.PI / 2 + 0.02);
            carTints.push(tint(CAR_TINTS[index % CAR_TINTS.length]!));
          }
        }
      }
    }

    // Blocks: sidewalk slab + buildings (tinted storefronts downtown,
    // gable-roofed houses on the outskirts).
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

        const distance = Math.hypot(cx - midX, cz - midZ);
        const downtown = distance < 300;
        const residential = distance > 300;
        const count = residential ? 2 + Math.floor(rand(i, j, 3) * 3) : 1 + Math.floor(rand(i, j, 3) * 3);
        for (let b = 0; b < count; b++) {
          const rx = rand(i * 7 + b, j * 13 - b, 5);
          const rz = rand(i * 11 - b, j * 5 + b, 9);
          const rw = rand(i + b, j - b, 13);
          const rh = rand(i * 3 + b, j * 3 + b, 17);
          const bw = residential ? 10 + rw * 9 : 16 + rw * 16;
          const bd = residential ? 9 + rz * 9 : 14 + rz * 15;
          let bh = residential ? 5.5 + rh * 7 : 9 + rh * 26 + (downtown ? 12 : 0);
          if (downtown && rw > 0.82) bh += 26; // a couple of towers
          const ox = (rx - 0.5) * Math.max(4, cellW - bw - 4);
          const oz = (rz - 0.5) * Math.max(4, cellD - bd - 4);
          const bx = cx + ox; const bz = cz + oz;
          if (!this.clearOfLandmarks(bx, bz, 34)) continue;
          const yaw = (rw - 0.5) * 0.14;
          const variant = hash2(i * 5 + b, j * 7 - b) % 3;
          const group = buildingGroups[variant]!;
          group.matrices.push(compose(bx, baseY + 0.24 + bh / 2, bz, bw, bh, bd, yaw));
          group.tints.push(tint(FACADE_TINTS[hash2(i + b * 13, j - b * 7) % FACADE_TINTS.length]!));

          if (residential) {
            // Gable roof house.
            const roofH = 2.6 + rw * 2.4;
            roofs.push(compose(bx, baseY + 0.24 + bh + roofH * 0.42, bz, bw * 1.16, roofH * 1.5, bd * 1.16, yaw));
            roofTints.push(tint(ROOF_TINTS[hash2(i - b, j + b * 3) % ROOF_TINTS.length]!));
          } else {
            // Storefront glow band at street level + neon on some facades.
            if (!downtown || rw > 0.3) put(shopGlow, bx, baseY + 1.1, bz + bd / 2 + 0.18, bw * 0.92, 0.9, 0.24, yaw);
            if (rw > 0.74 && downtown) {
              const target = rz > 0.5 ? neon : neonCyan;
              put(target, bx, baseY + 0.24 + bh * 0.72, bz + bd / 2 + 0.2, bw * 0.7, 1.1, 0.3, yaw);
            }
          }
        }
      }
    }

    // Build instanced meshes.
    const addInstances = (
      geometry: import('three/webgpu').BufferGeometry,
      material: import('three/webgpu').Material | import('three/webgpu').Material[],
      matrices: Matrix4[],
      tints?: Color[],
    ) => {
      if (matrices.length === 0) return;
      const mesh = new InstancedMesh(geometry, material, matrices.length);
      for (const [index, matrix] of matrices.entries()) {
        mesh.setMatrixAt(index, matrix);
        if (tints) mesh.setColorAt(index, tints[index]!);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (tints && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      this.group.add(mesh);
    };

    addInstances(unitBox, asphalt, street);
    addInstances(unitBox, paint, dash);
    addInstances(unitBox, paint, crosswalk);
    addInstances(unitBox, concrete, sidewalk);
    addInstances(unitBox, poleMat, poles);
    addInstances(unitBox, lampMat, heads);
    for (const [index, entry] of buildingGroups.entries()) {
      addInstances(
        unitBox,
        [facadeMats[index]!, facadeMats[index]!, facadeMats[index]!, facadeMats[index]!, roofMaterial, roofMaterial],
        entry.matrices,
        entry.tints,
      );
    }
    addInstances(roofPrism, roofMat, roofs, roofTints);
    addInstances(unitBox, carBodyMat, carBodies, carTints);
    addInstances(unitBox, carGlassMat, carTops);
    addInstances(unitBox, shopGlowMat, shopGlow);
    const neonMagenta = new MeshStandardMaterial({ color: 0x12040f, emissive: 0xff2fa8, emissiveIntensity: 3.4, roughness: 0.5 });
    const neonCyanMat = new MeshStandardMaterial({ color: 0x041012, emissive: 0x2fe8ff, emissiveIntensity: 3.2, roughness: 0.5 });
    this.disposables.push(neonMagenta, neonCyanMat);
    addInstances(unitBox, neonMagenta, neon);
    addInstances(unitBox, neonCyanMat, neonCyan);

    // Lamp halos: one additive Points draw call for the whole city.
    const glowTexture = makeGlowTexture();
    if (glowTexture && glowPositions.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(glowPositions, 3));
      const material = new PointsMaterial({
        size: 5.5, map: glowTexture, transparent: true, depthWrite: false,
        blending: AdditiveBlending, color: 0xffce8a, opacity: 0.75, sizeAttenuation: true,
      });
      this.disposables.push(geometry, material, glowTexture);
      const points = new Points(geometry, material);
      points.frustumCulled = true;
      this.group.add(points);
    }
  }
}

/** Compose an axis-aligned (yaw-rotated) box transform. */
function compose(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  return new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz));
}
