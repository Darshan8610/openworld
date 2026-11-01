import { DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping, LinearMipmapLinearFilter, LinearFilter, NoColorSpace } from 'three/webgpu';
import { clamp, lerp } from '../utils/math';

export type SurfaceKind = 'grass' | 'rock' | 'snow';
const SIZE = 128;
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Exact periodic value noise: opposite texture edges share the same lattice. */
function noise(x: number, y: number, period: number, seed: number, periodY = period): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const at = (dx: number, dy: number) => hash(((ix + dx) % period + period) % period, ((iy + dy) % periodY + periodY) % periodY, seed);
  return lerp(lerp(at(0, 0), at(1, 0), u), lerp(at(0, 1), at(1, 1), u), v);
}

/** One tiny, mipmapped, repeatable procedural texture per surface; no downloads. */
export function createSurfaceTexture(kind: SurfaceKind): DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const seed = kind === 'grass' ? 7241 : kind === 'rock' ? 9127 : 3187;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const u = x / SIZE, v = y / SIZE;
    const broad = noise(u * 8, v * 8, 8, seed);
    const fine = noise(u * 32, v * 32, 32, seed + 1);
    const grain = hash(x, y, seed + 2);
    let height = broad * 0.5 + fine * 0.35 + grain * 0.15;
    if (kind === 'rock') {
      const fissure = Math.abs(noise(u * 8, v * 8, 8, seed + 3) - 0.5);
      height = clamp(height * 0.7 + fissure * 0.6, 0, 1);
    }
    if (kind === 'grass') height = height * 0.65 + noise(u * 64, v * 16, 64, seed + 4, 16) * 0.35;
    if (kind === 'snow') height = 0.5 + (height - 0.5) * 0.3;
    const value = Math.round(clamp(0.69 + height * 0.43, 0, 1) * 255);
    const i = (y * SIZE + x) * 4;
    data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = Math.round(height * 255);
  }
  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  texture.name = `Procedural ${kind} / 128px`;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = NoColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
