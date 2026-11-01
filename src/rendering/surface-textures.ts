import { DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping, LinearMipmapLinearFilter, LinearFilter, NoColorSpace } from 'three/webgpu';
import { clamp, lerp } from '../utils/math';

export type SurfaceKind = 'grass' | 'rock' | 'snow' | 'asphalt' | 'gravel';
const SIZE = 256;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Exact periodic value noise: opposite texture edges share the same lattice. */
function noise(x: number, y: number, period: number, seed: number, periodY = period): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const at = (dx: number, dy: number) => hash(((ix + dx) % period + period) % period, ((iy + dy) % periodY + periodY) % periodY, seed);
  return lerp(lerp(at(0, 0), at(1, 0), u), lerp(at(0, 1), at(1, 1), u), v);
}

function fbm(u: number, v: number, seed: number, octaves: number, base = 8): number {
  let value = 0, amplitude = 0.5, frequency = base, total = 0;
  for (let i = 0; i < octaves; i++) {
    value += noise(u * frequency, v * frequency, frequency, seed + i * 101) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / total;
}

/**
 * Small, seamless, mipmapped surface tiles. RGB is a near-neutral albedo/detail
 * multiplier; alpha stores a height field for bump. All noise lattices wrap, so
 * the textures can be triplanar-projected in world space without a visible seam.
 */
export function createSurfaceTexture(kind: SurfaceKind): DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const seed = kind === 'grass' ? 7241 : kind === 'rock' ? 9127 : kind === 'asphalt' ? 5107 : kind === 'gravel' ? 6113 : 3187;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const u = x / SIZE, v = y / SIZE;
    const broad = fbm(u, v, seed, 3, 4);
    const fine = fbm(u, v, seed + 17, 3, 16);
    const grain = hash(x, y, seed + 2);
    let height: number;
    let r: number, g: number, b: number;

    if (kind === 'grass') {
      // Anisotropic blade streaks + clumping, rather than isotropic static.
      const blades = noise(u * 96, v * 24, 96, seed + 4, 24);
      const clumps = fbm(u, v, seed + 31, 2, 8);
      height = clamp(broad * 0.34 + fine * 0.24 + blades * 0.28 + clumps * 0.14, 0, 1);
      const dry = smooth01((clumps - 0.42) * 2.4);
      const shade = 0.72 + height * 0.4;
      r = shade * lerp(0.86, 1.04, dry);
      g = shade * lerp(0.98, 0.94, dry);
      b = shade * lerp(0.72, 0.62, dry);
    } else if (kind === 'rock') {
      // Warped fissures and strata give cliffs a layered, fractured read.
      const warp = fbm(u, v, seed + 5, 2, 4) - 0.5;
      const fissure = Math.abs(noise((u + warp * 0.08) * 8, (v + warp * 0.05) * 8, 8, seed + 3) - 0.5);
      const strata = 0.5 + 0.5 * Math.sin((v * 10 + warp * 1.7) * Math.PI * 2);
      height = clamp(broad * 0.3 + fine * 0.28 + fissure * 0.3 + strata * 0.12, 0, 1);
      const shade = 0.68 + height * 0.44;
      const warm = fbm(u, v, seed + 9, 2, 4);
      r = shade * lerp(0.94, 1.04, warm);
      g = shade * lerp(0.95, 0.99, warm);
      b = shade * lerp(0.96, 0.92, warm);
    } else if (kind === 'asphalt') {
      // Dense aggregate with hairline cracks; alpha is a shallow bump height.
      const aggregate = fbm(u, v, seed + 11, 2, 32);
      const crack = Math.abs(noise((u + broad * 0.05) * 5, (v + fine * 0.04) * 5, 5, seed + 7) - 0.5);
      height = clamp(aggregate * 0.55 + grain * 0.25 + smooth01(crack * 5) * 0.2, 0, 1);
      const shade = 0.78 + height * 0.34;
      r = shade * 0.94; g = shade * 0.97; b = shade;
    } else if (kind === 'gravel') {
      const stones = fbm(u, v, seed + 5, 3, 24);
      height = clamp(stones * 0.7 + grain * 0.3, 0, 1);
      const shade = 0.66 + height * 0.5;
      r = shade * 1.02; g = shade * 0.98; b = shade * 0.9;
    } else {
      // Wind-packed snow: soft sastrugi, sparse sparkle, very low relief.
      const drift = noise(u * 6, v * 18, 6, seed + 6, 18);
      height = clamp(0.5 + (broad - 0.5) * 0.22 + (drift - 0.5) * 0.18 + (grain - 0.5) * 0.05, 0, 1);
      const shade = 0.86 + height * 0.16;
      r = shade * 0.96; g = shade * 0.985; b = shade;
    }

    const i = (y * SIZE + x) * 4;
    data[i] = Math.round(clamp(r, 0, 1) * 255);
    data[i + 1] = Math.round(clamp(g, 0, 1) * 255);
    data[i + 2] = Math.round(clamp(b, 0, 1) * 255);
    data[i + 3] = Math.round(clamp(height, 0, 1) * 255);
  }
  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  texture.name = `Procedural ${kind} / ${SIZE}px`;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = NoColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}
