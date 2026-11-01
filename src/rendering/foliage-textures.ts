import { DataTexture, RGBAFormat, UnsignedByteType, ClampToEdgeWrapping, LinearMipmapLinearFilter, LinearFilter, SRGBColorSpace } from 'three/webgpu';
import { seededRandom } from '../utils/random';
import { clamp } from '../utils/math';

export type FoliageKind = 'pine' | 'aspen' | 'shrub';
const SIZE = 128;

/**
 * Alpha-tested foliage sprays. Keeping the silhouette in a tiny procedural
 * texture lets a tree read as hundreds of needles/leaves while the instanced
 * geometry stays cheap enough for the fixed five-batch budget.
 */
export function createFoliageTexture(kind: FoliageKind): DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const random = seededRandom(kind === 'pine' ? 0x9e3779b9 : kind === 'aspen' ? 0x85ebca6b : 0xc2b2ae35);

  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    if (a * 255 <= data[i + 3]!) return;
    data[i] = Math.round(clamp(r, 0, 1) * 255);
    data[i + 1] = Math.round(clamp(g, 0, 1) * 255);
    data[i + 2] = Math.round(clamp(b, 0, 1) * 255);
    data[i + 3] = Math.round(clamp(a, 0, 1) * 255);
  };

  const segment = (x0: number, y0: number, x1: number, y1: number, width: number, r: number, g: number, b: number) => {
    const minX = Math.floor(Math.min(x0, x1) - width), maxX = Math.ceil(Math.max(x0, x1) + width);
    const minY = Math.floor(Math.min(y0, y1) - width), maxY = Math.ceil(Math.max(y0, y1) + width);
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const t = clamp(((x - x0) * dx + (y - y0) * dy) / len2, 0, 1);
      const px = x0 + dx * t, py = y0 + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d <= width) put(x, y, r, g, b, 1 - d / (width + 0.6) * 0.35);
    }
  };

  if (kind === 'pine') {
    // Central twig with paired needles along its length.
    segment(SIZE * 0.5, SIZE * 0.96, SIZE * 0.5, SIZE * 0.06, 1.4, 0.32, 0.27, 0.18);
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      const y = SIZE * (0.94 - t * 0.86);
      const length = SIZE * (0.42 * (1 - t * 0.62) + 0.04);
      const angle = 0.55 + random() * 0.35;
      const green = 0.3 + random() * 0.16;
      for (const side of [-1, 1]) {
        const x1 = SIZE * 0.5 + side * Math.sin(angle) * length;
        const y1 = y - Math.cos(angle) * length * 0.55;
        segment(SIZE * 0.5, y, x1, y1, 0.9 + random() * 0.5, 0.16 + random() * 0.08, green, 0.2 + random() * 0.08);
      }
    }
  } else {
    const leaves = kind === 'aspen' ? 34 : 46;
    for (let i = 0; i < leaves; i++) {
      const cx = SIZE * (0.16 + random() * 0.68);
      const cy = SIZE * (0.14 + random() * 0.72);
      const angle = random() * Math.PI * 2;
      const rx = kind === 'aspen' ? 5 + random() * 7 : 3 + random() * 4;
      const ry = rx * (kind === 'aspen' ? 1.15 : 0.55);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const gold = kind === 'aspen' ? random() : random() * 0.3;
      const r = kind === 'aspen' ? 0.34 + gold * 0.3 : 0.3 + random() * 0.1;
      const g = kind === 'aspen' ? 0.46 + gold * 0.16 : 0.4 + random() * 0.12;
      const b = kind === 'aspen' ? 0.18 + gold * 0.08 : 0.24 + random() * 0.08;
      const minX = Math.floor(cx - rx - ry), maxX = Math.ceil(cx + rx + ry);
      const minY = Math.floor(cy - rx - ry), maxY = Math.ceil(cy + rx + ry);
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const dx = x - cx, dy = y - cy;
        const lx = (dx * cos + dy * sin) / rx;
        const ly = (-dx * sin + dy * cos) / ry;
        const d = lx * lx + ly * ly;
        if (d <= 1) {
          const vein = Math.abs(lx) < 0.08 ? 0.08 : 0;
          put(x, y, r + vein, g + vein, b + vein, 1 - Math.max(0, d - 0.72) * 1.4);
        }
      }
    }
  }

  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  texture.name = `Procedural ${kind} foliage / ${SIZE}px`;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
