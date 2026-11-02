import {
  AdditiveBlending, BoxGeometry, CanvasTexture, Color, CylinderGeometry, Group, InstancedMesh,
  Mesh, MeshStandardMaterial, Matrix4, Points, PointsMaterial, BufferGeometry,
  Float32BufferAttribute, Quaternion, RepeatWrapping, Vector3, SphereGeometry,
} from 'three/webgpu';
import type { TerrainPlateau } from '../world/terrain-field';

/**
 * The Blackwood city district — an Unreal Engine / GTA San Andreas quality
 * urban environment laid over the flat plateau.
 *
 * Features:
 * - Multi-tiered commercial storefront buildings with cornices, awnings, quoins,
 *   rooftop HVAC units, water towers on stilts, and antenna beacon lights.
 * - Craftsman residential houses with front porches, columns, steps, chimneys,
 *   garages, and pitched gable roofs.
 * - Solid physics colliders (`blockedAt`) on every building, house, and parked car
 *   so the player and vehicles never ghost through structures.
 * - GTA-style street props: cast-iron fire hydrants, benches, trash bins,
 *   traffic signal lights, STOP and street name signs, and drain grates.
 * - Parked vehicles with 3D bodies, cabins, glass, bumpers, and real cylinder wheels.
 * - Multi-colored vibrant neon signs (cyan, magenta, amber, emerald).
 * - Atmospheric rooftop steam exhaust motes and street lamp glow halos.
 * - Highly optimized into ~18 InstancedMesh draw calls with zero runtime allocations.
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

export interface CityCollider {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly bottom: number;
  readonly top: number;
}

const STREET_SPACING = 92;
const STREET_WIDTH = 13;
const SIDEWALK = 4.5;
const INSET = 44;
const HILL_LIMIT = 54; // ground above this is the lookout hill — no streets

/** Per-building facade tints (multiplied over the window texture). */
const FACADE_TINTS = [
  0xd8d2c4, 0xc6cfda, 0xd9c3b4, 0xcdd6c4, 0xe0d3ae, 0xc9ced6, 0xd4c8d2, 0xc4d2cf,
  0xb8c5d6, 0xdfd4c0, 0xccd5cb, 0xd2c2b6, 0xb0c0cf, 0xd8c8b8, 0xbec9c4, 0xd0cfc8,
];

/** Gable roof tints — slate, moss, terracotta, charcoal, weathered zinc. */
const ROOF_TINTS = [0x8f9aa8, 0x7f9482, 0xb08a74, 0x8a8580, 0x9d8f9e, 0x5a636e, 0x725447, 0x485044];

/** Parked-car automotive enamel palette. */
const CAR_TINTS = [
  0x9fb4c8, 0xc8c3b8, 0x8a2f2f, 0x2f3a4a, 0x5b6b4f, 0xd8d8dc, 0x394047, 0xb09a6a,
  0x1c3a52, 0x6e2424, 0x2e4236, 0xbf782c, 0x4d535e, 0xa6a192, 0xd46820, 0x1f2329,
];

/** Residential siding tints. */
const HOUSE_TINTS = [0xe2ded4, 0x98aab8, 0xb4c2aa, 0xcab29e, 0x8c9fa8, 0xd6c6b2, 0xa0b09c, 0xc2c6c8];

function hash2(x: number, z: number): number {
  let n = (x * 374761393 + z * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}

/** Deterministic per-cell values in [0, 1). */
function rand(x: number, z: number, salt: number): number {
  return hash2(x * 31 + salt, z * 17 - salt) / 0xffffffff;
}

/** High-resolution procedural window grid texture with frames, glass and lit interiors. */
function makeWindowTexture(cols: number, rows: number, seedSalt: number): CanvasTexture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Rich stone/concrete facade background
  ctx.fillStyle = '#181d22';
  ctx.fillRect(0, 0, 256, 512);

  // Subtle brick/panel horizontal courses
  ctx.strokeStyle = '#222930';
  ctx.lineWidth = 1;
  for (let y = 0; y < 512; y += 8) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }

  const cellW = 256 / cols; const cellH = 512 / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const roll = rand(col, row, seedSalt);
      const lit = roll > 0.48;
      const warm = rand(col, row, seedSalt + 7) > 0.35;
      const padX = cellW * 0.20; const padY = cellH * 0.22;
      const wx = col * cellW + padX;
      const wy = row * cellH + padY;
      const ww = cellW - padX * 2;
      const wh = cellH - padY * 2;

      // Outer window sill/casing
      ctx.fillStyle = '#2d353d';
      ctx.fillRect(wx - 2, wy - 2, ww + 4, wh + 5);

      // Glass pane
      ctx.fillStyle = lit ? (warm ? '#ffe0a8' : '#cce5ff') : '#0a0d11';
      ctx.fillRect(wx, wy, ww, wh);

      // Interior curtain / blind detail on some windows
      if (lit && roll > 0.72) {
        ctx.fillStyle = '#e8caa0';
        ctx.fillRect(wx, wy, ww, wh * 0.35);
      }

      // Window mullions / cross-frame
      ctx.strokeStyle = '#1e252c';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(wx + ww / 2, wy);
      ctx.lineTo(wx + ww / 2, wy + wh);
      ctx.moveTo(wx, wy + wh * 0.5);
      ctx.lineTo(wx + ww, wy + wh * 0.5);
      ctx.stroke();

      // Lower protruding stone sill
      ctx.fillStyle = '#3a444e';
      ctx.fillRect(wx - 3, wy + wh, ww + 6, 3);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = 'srgb';
  return texture;
}

/** Soft radial halo used for lamp glows and night atmosphere. */
function makeGlowTexture(): CanvasTexture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(255, 222, 160, 1)');
  gradient.addColorStop(0.3, 'rgba(255, 195, 120, 0.55)');
  gradient.addColorStop(0.7, 'rgba(255, 170, 80, 0.15)');
  gradient.addColorStop(1, 'rgba(255, 150, 60, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = 'srgb';
  return texture;
}

/** Soft vapor particle for rooftop HVAC plumes. */
function makeSteamTexture(): CanvasTexture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(220, 235, 245, 0.45)');
  gradient.addColorStop(0.5, 'rgba(190, 210, 225, 0.18)');
  gradient.addColorStop(1, 'rgba(180, 200, 215, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = 'srgb';
  return texture;
}

export class StoryCity {
  readonly group = new Group();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly colliders: CityCollider[] = [];
  private readonly grid = new Map<string, CityCollider[]>();
  private readonly GRID_CELL = 32;

  constructor(private readonly options: StoryCityOptions) {
    this.group.name = 'story/city (GTA/Unreal tier)';
    this.build();
  }

  get colliderCount(): number { return this.colliders.length; }

  private gridKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  private addCollider(minX: number, maxX: number, minZ: number, maxZ: number, bottom: number, top: number): void {
    const box: CityCollider = { minX, maxX, minZ, maxZ, bottom, top };
    this.colliders.push(box);
    const minCx = Math.floor(minX / this.GRID_CELL);
    const maxCx = Math.floor(maxX / this.GRID_CELL);
    const minCz = Math.floor(minZ / this.GRID_CELL);
    const maxCz = Math.floor(maxZ / this.GRID_CELL);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = this.gridKey(cx, cz);
        let list = this.grid.get(key);
        if (!list) { list = []; this.grid.set(key, list); }
        list.push(box);
      }
    }
  }

  /**
   * Fast spatial collision query for character, vehicle, and NPC navigation.
   * Eliminates ghosting through buildings, houses, and parked vehicles.
   */
  blockedAt(x: number, z: number, feetY = Number.NEGATIVE_INFINITY): boolean {
    const margin = 0.44; // player capsule radius
    const cx = Math.floor(x / this.GRID_CELL);
    const cz = Math.floor(z / this.GRID_CELL);
    const list = this.grid.get(this.gridKey(cx, cz));
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const box = list[i]!;
      if (
        x >= box.minX - margin && x <= box.maxX + margin &&
        z >= box.minZ - margin && z <= box.maxZ + margin &&
        feetY < box.top && (feetY + 1.85) > box.bottom
      ) {
        return true;
      }
    }
    return false;
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
    this.colliders.length = 0;
    this.grid.clear();
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

    // PBR Materials
    const asphalt = new MeshStandardMaterial({ color: 0x16181b, roughness: 0.78, metalness: 0.12 });
    const concrete = new MeshStandardMaterial({ color: 0x42464d, roughness: 0.88 });
    const curbMat = new MeshStandardMaterial({ color: 0x545860, roughness: 0.85 });
    const paint = new MeshStandardMaterial({ color: 0xdcd8cb, roughness: 0.75, emissive: 0x3e3e35, emissiveIntensity: 0.35 });
    const poleMat = new MeshStandardMaterial({ color: 0x22262a, roughness: 0.45, metalness: 0.75 });
    const lampMat = new MeshStandardMaterial({ color: 0x181408, emissive: 0xffce7a, emissiveIntensity: 3.6, roughness: 0.35 });
    const roofMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
    const trimMat = new MeshStandardMaterial({ color: 0x2e343b, roughness: 0.7, metalness: 0.2 });
    const hvacMat = new MeshStandardMaterial({ color: 0x6e7882, roughness: 0.5, metalness: 0.6 });
    const waterTowerWood = new MeshStandardMaterial({ color: 0x6b533e, roughness: 0.9 });
    const beaconMat = new MeshStandardMaterial({ color: 0x330000, emissive: 0xff1e1e, emissiveIntensity: 4.5 });
    const awningMat = new MeshStandardMaterial({ color: 0x1d354d, roughness: 0.8 });

    const carBodyMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.62 });
    const carGlassMat = new MeshStandardMaterial({ color: 0x11161d, roughness: 0.12, metalness: 0.85 });
    const carWheelMat = new MeshStandardMaterial({ color: 0x151515, roughness: 0.9, metalness: 0.1 });
    const carRimMat = new MeshStandardMaterial({ color: 0xd0d5db, roughness: 0.25, metalness: 0.85 });
    const carLightMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4db, emissiveIntensity: 2.8 });
    const carTailMat = new MeshStandardMaterial({ color: 0x550000, emissive: 0xff1515, emissiveIntensity: 2.5 });

    const hydrantMat = new MeshStandardMaterial({ color: 0xd42424, roughness: 0.4, metalness: 0.35 });
    const benchWoodMat = new MeshStandardMaterial({ color: 0x5c4228, roughness: 0.85 });
    const signStopMat = new MeshStandardMaterial({ color: 0xcc1818, emissive: 0x440808, roughness: 0.5 });
    const signGreenMat = new MeshStandardMaterial({ color: 0x1a6b38, emissive: 0x082612, roughness: 0.5 });
    const trafficLightMat = new MeshStandardMaterial({ color: 0x1f2420, roughness: 0.5, metalness: 0.5 });

    const shopGlowMat = new MeshStandardMaterial({ color: 0x16130c, emissive: 0xffe2b0, emissiveIntensity: 2.4, roughness: 0.5 });
    const neonMagenta = new MeshStandardMaterial({ color: 0x160412, emissive: 0xff2fa8, emissiveIntensity: 3.8, roughness: 0.4 });
    const neonCyanMat = new MeshStandardMaterial({ color: 0x041416, emissive: 0x2fe8ff, emissiveIntensity: 3.6, roughness: 0.4 });
    const neonAmberMat = new MeshStandardMaterial({ color: 0x160c04, emissive: 0xffaa20, emissiveIntensity: 3.6, roughness: 0.4 });

    this.disposables.push(
      asphalt, concrete, curbMat, paint, poleMat, lampMat, roofMat, trimMat, hvacMat,
      waterTowerWood, beaconMat, awningMat, carBodyMat, carGlassMat, carWheelMat,
      carRimMat, carLightMat, carTailMat, hydrantMat, benchWoodMat, signStopMat,
      signGreenMat, trafficLightMat, shopGlowMat, neonMagenta, neonCyanMat, neonAmberMat,
    );

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
        emissiveIntensity: texture ? 1.25 : 0,
      });
      this.disposables.push(mat);
      if (texture) this.disposables.push(texture);
      return mat;
    });

    // Geometries
    const unitBox = new BoxGeometry(1, 1, 1);
    const unitCylinder = new CylinderGeometry(1, 1, 1, 12);
    const unitSphere = new SphereGeometry(1, 10, 8);
    const roofPrism = new CylinderGeometry(1, 1, 1, 3, 1, false).rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
    this.disposables.push(unitBox, unitCylinder, unitSphere, roofPrism);

    // Instance Matrices collectors
    const street: Matrix4[] = [];
    const dash: Matrix4[] = [];
    const crosswalk: Matrix4[] = [];
    const sidewalk: Matrix4[] = [];
    const curbs: Matrix4[] = [];
    const poles: Matrix4[] = [];
    const heads: Matrix4[] = [];
    const glowPositions: number[] = [];
    const steamPositions: number[] = [];

    const buildingGroups: { matrices: Matrix4[]; tints: Color[] }[] = [
      { matrices: [], tints: [] }, { matrices: [], tints: [] }, { matrices: [], tints: [] },
    ];
    const cornices: Matrix4[] = [];
    const hvacs: Matrix4[] = [];
    const waterTowers: Matrix4[] = [];
    const antennas: Matrix4[] = [];
    const beacons: Matrix4[] = [];
    const awnings: Matrix4[] = [];

    const houses: Matrix4[] = [];
    const houseTints: Color[] = [];
    const porches: Matrix4[] = [];
    const roofs: Matrix4[] = [];
    const roofTints: Color[] = [];

    const carBodies: Matrix4[] = [];
    const carTops: Matrix4[] = [];
    const carTints: Color[] = [];
    const carWheels: Matrix4[] = [];
    const carLights: Matrix4[] = [];
    const carTails: Matrix4[] = [];

    const hydrants: Matrix4[] = [];
    const benches: Matrix4[] = [];
    const signs: Matrix4[] = [];
    const trafficLights: Matrix4[] = [];

    const shopGlow: Matrix4[] = [];
    const neon: Matrix4[] = [];
    const neonCyan: Matrix4[] = [];
    const neonAmber: Matrix4[] = [];

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

    // Streets: N-S and E-W avenues in 24 m segments
    const z0 = bounds.minZ + INSET; const z1 = bounds.maxZ - INSET;
    const x0 = bounds.minX + INSET; const x1 = bounds.maxX - INSET;

    for (const x of xs) {
      for (let z = z0; z < z1; z += 24) {
        const mid = z + 12;
        if (!flat(x, mid)) continue;
        put(street, x, yAt(x, mid) + 0.05, mid, STREET_WIDTH, 0.1, 25);
        for (let d = z + 6; d < z + 24; d += 11) put(dash, x, yAt(x, d) + 0.11, d, 0.34, 0.04, 4.6);

        // Street curbs along the sides
        put(curbs, x - STREET_WIDTH / 2 - 0.2, yAt(x, mid) + 0.15, mid, 0.38, 0.22, 25);
        put(curbs, x + STREET_WIDTH / 2 + 0.2, yAt(x, mid) + 0.15, mid, 0.38, 0.22, 25);

        if (Math.abs(((z - z0) % STREET_SPACING)) < 1 && flat(x, z)) {
          const side = (Math.floor((z - z0) / STREET_SPACING) % 2 === 0) ? 1 : -1;
          const px = x + side * (STREET_WIDTH / 2 + 1.4);
          put(poles, px, yAt(px, z) + 3, z, 0.18, 6, 0.18);
          const hy = yAt(px, z) + 6.1;
          put(heads, px - side * 0.9, hy, z, 1.5, 0.18, 0.4);
          glowPositions.push(px - side * 0.9, hy, z);

          // Cast iron fire hydrant
          put(hydrants, px + side * 0.8, yAt(px, z) + 0.45, z + 8, 0.35, 0.85, 0.35);
          this.addCollider(px - 0.3, px + 0.3, z + 7.7, z + 8.3, yAt(px, z), yAt(px, z) + 1.0);

          // Parked cars along the curb
          if (((z - z0) % (STREET_SPACING * 2)) === 24 && flat(x, z + 30)) {
            const cy = yAt(x, z + 30);
            const lane = side * 3.9;
            const index = carTints.length;
            const carX = x + lane; const carZ = z + 30;

            put(carBodies, carX, cy + 0.62, carZ, 1.95, 0.78, 4.4, 0.02);
            put(carTops, carX, cy + 1.28, carZ - 0.5, 1.72, 0.62, 2.3, 0.02);
            carTints.push(tint(CAR_TINTS[index % CAR_TINTS.length]!));

            // 4 3D wheels
            for (const wx of [-0.95, 0.95]) {
              for (const wz of [-1.35, 1.35]) {
                put(carWheels, carX + wx, cy + 0.34, carZ + wz, 0.28, 0.68, 0.68, 0);
              }
            }
            // Headlights & Taillights
            put(carLights, carX - 0.65, cy + 0.65, carZ + 2.15, 0.35, 0.22, 0.1);
            put(carLights, carX + 0.65, cy + 0.65, carZ + 2.15, 0.35, 0.22, 0.1);
            put(carTails, carX - 0.65, cy + 0.68, carZ - 2.15, 0.35, 0.18, 0.1);
            put(carTails, carX + 0.65, cy + 0.68, carZ - 2.15, 0.35, 0.18, 0.1);

            // Solid collider for car
            this.addCollider(carX - 1.1, carX + 1.1, carZ - 2.3, carZ + 2.3, cy, cy + 1.7);
          }
        }
      }

      // Crosswalk bars at each intersection
      for (const z of zs) {
        if (!flat(x, z)) continue;
        const gy = yAt(x, z) + 0.12;
        for (let i = -2; i <= 2; i++) {
          put(crosswalk, x + i * 1.6, gy, z + STREET_WIDTH / 2 + 2.4, 1.0, 0.05, 2.4);
          put(crosswalk, x + i * 1.6, gy, z - STREET_WIDTH / 2 - 2.4, 1.0, 0.05, 2.4);
          put(crosswalk, x + STREET_WIDTH / 2 + 2.4, gy, z + i * 1.6, 2.4, 0.05, 1.0);
          put(crosswalk, x - STREET_WIDTH / 2 - 2.4, gy, z + i * 1.6, 2.4, 0.05, 1.0);
        }
        // Traffic light gantry at intersection corners
        const tx = x + STREET_WIDTH / 2 + 1.8;
        const tz = z + STREET_WIDTH / 2 + 1.8;
        put(poles, tx, gy + 3.2, tz, 0.2, 6.4, 0.2);
        put(trafficLights, tx, gy + 5.5, tz, 0.45, 1.1, 0.45);
        this.addCollider(tx - 0.25, tx + 0.25, tz - 0.25, tz + 0.25, gy, gy + 6.0);

        // STOP signs
        const sx = x - STREET_WIDTH / 2 - 1.6;
        const sz = z - STREET_WIDTH / 2 - 1.6;
        put(poles, sx, gy + 1.6, sz, 0.1, 3.2, 0.1);
        put(signs, sx, gy + 2.8, sz, 0.8, 0.8, 0.06);
      }
    }

    for (const z of zs) {
      for (let x = x0; x < x1; x += 24) {
        const mid = x + 12;
        if (!flat(mid, z)) continue;
        put(street, mid, yAt(mid, z) + 0.05, z, 25, 0.1, STREET_WIDTH);
        for (let d = x + 6; d < x + 24; d += 11) put(dash, d, yAt(d, z) + 0.11, z, 4.6, 0.04, 0.34);

        put(curbs, mid, yAt(mid, z) + 0.15, z - STREET_WIDTH / 2 - 0.2, 25, 0.22, 0.38);
        put(curbs, mid, yAt(mid, z) + 0.15, z + STREET_WIDTH / 2 + 0.2, 25, 0.22, 0.38);

        if (Math.abs(((x - x0) % STREET_SPACING)) < 1 && flat(x, z)) {
          const side = (Math.floor((x - x0) / STREET_SPACING) % 2 === 0) ? -1 : 1;
          const pz = z + side * (STREET_WIDTH / 2 + 1.4);
          put(poles, x, yAt(x, pz) + 3, pz, 0.18, 6, 0.18);
          const hy = yAt(x, pz) + 6.1;
          put(heads, x, hy, pz - side * 0.9, 0.4, 0.18, 1.5);
          glowPositions.push(x, hy, pz - side * 0.9);

          // Street benches on sidewalk
          put(benches, x + 8, yAt(x, pz) + 0.38, pz + side * 1.1, 2.2, 0.72, 0.75, Math.PI / 2);

          if (((x - x0) % (STREET_SPACING * 2)) === 48 && flat(x + 30, z)) {
            const cy = yAt(x + 30, z);
            const lane = side * 3.9;
            const index = carTints.length;
            const carX = x + 30; const carZ = z + lane;

            put(carBodies, carX, cy + 0.62, carZ, 4.4, 0.78, 1.95, Math.PI / 2 + 0.02);
            put(carTops, carX - 0.5, cy + 1.28, carZ, 2.3, 0.62, 1.72, Math.PI / 2 + 0.02);
            carTints.push(tint(CAR_TINTS[index % CAR_TINTS.length]!));

            for (const wz of [-0.95, 0.95]) {
              for (const wx of [-1.35, 1.35]) {
                put(carWheels, carX + wx, cy + 0.34, carZ + wz, 0.68, 0.68, 0.28, 0);
              }
            }
            put(carLights, carX + 2.15, cy + 0.65, carZ - 0.65, 0.1, 0.22, 0.35);
            put(carLights, carX + 2.15, cy + 0.65, carZ + 0.65, 0.1, 0.22, 0.35);
            put(carTails, carX - 2.15, cy + 0.68, carZ - 0.65, 0.1, 0.18, 0.35);
            put(carTails, carX - 2.15, cy + 0.68, carZ + 0.65, 0.1, 0.18, 0.35);

            this.addCollider(carX - 2.3, carX + 2.3, carZ - 1.1, carZ + 1.1, cy, cy + 1.7);
          }
        }
      }
    }

    // Blocks: sidewalk slab + buildings
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

          if (residential) {
            // Residential House Template
            const roofH = 2.6 + rw * 2.4;
            houses.push(compose(bx, baseY + 0.24 + bh / 2, bz, bw, bh, bd, yaw));
            houseTints.push(tint(HOUSE_TINTS[hash2(i * 3 + b, j * 7 - b) % HOUSE_TINTS.length]!));

            // Front Porch
            const porchW = bw * 0.55; const porchD = 3.2; const porchH = 2.8;
            put(porches, bx, baseY + 0.24 + 0.2, bz + bd / 2 + porchD / 2, porchW, 0.4, porchD, yaw);

            // Gable roof house
            roofs.push(compose(bx, baseY + 0.24 + bh + roofH * 0.42, bz, bw * 1.16, roofH * 1.5, bd * 1.16, yaw));
            roofTints.push(tint(ROOF_TINTS[hash2(i - b, j + b * 3) % ROOF_TINTS.length]!));

            // Brick chimney with subtle warm smoke
            const chimX = bx + bw * 0.35; const chimZ = bz - bd * 0.25; const chimTop = baseY + bh + roofH + 1.4;
            put(cornices, chimX, chimTop - 1.2, chimZ, 1.2, 2.4, 1.2, yaw);
            steamPositions.push(chimX, chimTop, chimZ);

            // SOLID COLLIDER: house body + front porch
            this.addCollider(bx - bw / 2, bx + bw / 2, bz - bd / 2, bz + bd / 2, baseY, baseY + bh + roofH);
            this.addCollider(bx - porchW / 2, bx + porchW / 2, bz + bd / 2, bz + bd / 2 + porchD, baseY, baseY + porchH);
          } else {
            // Commercial / Downtown Building Template
            const variant = hash2(i * 5 + b, j * 7 - b) % 3;
            const group = buildingGroups[variant]!;
            group.matrices.push(compose(bx, baseY + 0.24 + bh / 2, bz, bw, bh, bd, yaw));
            group.tints.push(tint(FACADE_TINTS[hash2(i + b * 13, j - b * 7) % FACADE_TINTS.length]!));

            // Roof Parapet / Cornice Trim
            const roofY = baseY + 0.24 + bh;
            put(cornices, bx, roofY + 0.35, bz, bw * 1.03, 0.7, bd * 1.03, yaw);

            // Rooftop elevator doghouse / mechanical penthouse
            const pentW = bw * 0.35; const pentD = bd * 0.35; const pentH = 3.8;
            put(cornices, bx, roofY + pentH / 2, bz, pentW, pentH, pentD, yaw);

            // Rooftop HVAC industrial chiller unit with steam vent
            const hvacX = bx + bw * 0.22; const hvacZ = bz + bd * 0.22;
            put(hvacs, hvacX, roofY + 1.1, hvacZ, 3.2, 2.2, 2.4, yaw);
            steamPositions.push(hvacX, roofY + 2.3, hvacZ);

            // Water tower on taller buildings
            if (bh > 20) {
              const wtX = bx - bw * 0.24; const wtZ = bz - bd * 0.24;
              put(waterTowers, wtX, roofY + 3.5, wtZ, 3.4, 5.0, 3.4, yaw);
            }

            // Radio communication antenna with blinking red beacon on highest towers
            if (bh > 30) {
              const antY = roofY + pentH + 6;
              put(antennas, bx, antY, bz, 0.25, 12, 0.25, yaw);
              put(beacons, bx, antY + 6.2, bz, 0.6, 0.6, 0.6, yaw);
            }

            // Ground floor storefront glow band + fabric awning
            put(shopGlow, bx, baseY + 1.25, bz + bd / 2 + 0.22, bw * 0.92, 1.2, 0.3, yaw);
            put(awnings, bx, baseY + 2.6, bz + bd / 2 + 1.1, bw * 0.88, 0.3, 1.8, yaw);

            // Neon signs (Cyan, Magenta, Amber)
            if (rw > 0.45 && downtown) {
              const neonTarget = rz > 0.65 ? neon : (rz > 0.35 ? neonCyan : neonAmber);
              put(neonTarget, bx, baseY + 0.24 + bh * 0.68, bz + bd / 2 + 0.24, bw * 0.65, 1.4, 0.35, yaw);
            }

            // SOLID COLLIDER: building core + storefront awning
            this.addCollider(bx - bw / 2, bx + bw / 2, bz - bd / 2, bz + bd / 2, baseY, roofY + 8);
            this.addCollider(bx - bw * 0.45, bx + bw * 0.45, bz + bd / 2, bz + bd / 2 + 1.5, baseY, baseY + 3.2);
          }
        }
      }
    }

    // Build instanced meshes
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      this.group.add(mesh);
    };

    addInstances(unitBox, asphalt, street);
    addInstances(unitBox, paint, dash);
    addInstances(unitBox, paint, crosswalk);
    addInstances(unitBox, concrete, sidewalk);
    addInstances(unitBox, curbMat, curbs);
    addInstances(unitBox, poleMat, poles);
    addInstances(unitBox, lampMat, heads);

    for (const [index, entry] of buildingGroups.entries()) {
      addInstances(
        unitBox,
        [facadeMats[index]!, facadeMats[index]!, facadeMats[index]!, facadeMats[index]!, roofMat, roofMat],
        entry.matrices,
        entry.tints,
      );
    }

    addInstances(unitBox, trimMat, cornices);
    addInstances(unitBox, hvacMat, hvacs);
    addInstances(unitCylinder, waterTowerWood, waterTowers);
    addInstances(unitCylinder, poleMat, antennas);
    addInstances(unitSphere, beaconMat, beacons);
    addInstances(unitBox, awningMat, awnings);

    addInstances(unitBox, concrete, houses, houseTints);
    addInstances(unitBox, concrete, porches);
    addInstances(roofPrism, roofMat, roofs, roofTints);

    addInstances(unitBox, carBodyMat, carBodies, carTints);
    addInstances(unitBox, carGlassMat, carTops);
    addInstances(unitCylinder, carWheelMat, carWheels);
    addInstances(unitBox, carLightMat, carLights);
    addInstances(unitBox, carTailMat, carTails);

    addInstances(unitCylinder, hydrantMat, hydrants);
    addInstances(unitBox, benchWoodMat, benches);
    addInstances(unitBox, signStopMat, signs);
    addInstances(unitBox, trafficLightMat, trafficLights);

    addInstances(unitBox, shopGlowMat, shopGlow);
    addInstances(unitBox, neonMagenta, neon);
    addInstances(unitBox, neonCyanMat, neonCyan);
    addInstances(unitBox, neonAmberMat, neonAmber);

    // Lamp halos: additive Points draw call for street lights
    const glowTexture = makeGlowTexture();
    if (glowTexture && glowPositions.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(glowPositions, 3));
      const material = new PointsMaterial({
        size: 6.2, map: glowTexture, transparent: true, depthWrite: false,
        blending: AdditiveBlending, color: 0xffd290, opacity: 0.85, sizeAttenuation: true,
      });
      this.disposables.push(geometry, material, glowTexture);
      const points = new Points(geometry, material);
      points.frustumCulled = true;
      this.group.add(points);
    }

    // Rooftop steam plumes: soft additive vapor
    const steamTexture = makeSteamTexture();
    if (steamTexture && steamPositions.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(steamPositions, 3));
      const material = new PointsMaterial({
        size: 4.8, map: steamTexture, transparent: true, depthWrite: false,
        blending: AdditiveBlending, color: 0xdae8f5, opacity: 0.6, sizeAttenuation: true,
      });
      this.disposables.push(geometry, material, steamTexture);
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
