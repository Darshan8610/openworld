import { DataTexture, RGBAFormat, UnsignedByteType, ClampToEdgeWrapping, LinearMipmapLinearFilter, LinearFilter, SRGBColorSpace } from 'three/webgpu';
import { seededRandom } from '../utils/random';
import { clamp } from '../utils/math';

export type FoliageKind = 'pine' | 'aspen' | 'shrub';
const SIZE = 256;

/**
 * Dense alpha-tested foliage sprays. The silhouette lives in a procedural
 * texture so a tree can read as hundreds of needles/leaves while the instanced
 * geometry stays inside the fixed five-batch budget.
 */
export function createFoliageTexture(kind: FoliageKind): DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const random = seededRandom(kind === 'pine' ? 0x9e3779b9 : kind === 'aspen' ? 0x85ebca6b : 0xc2b2ae35);

  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= SIZE || yi >= SIZE) return;
    const i = (yi * SIZE + xi) * 4;
    if (a * 255 <= data[i + 3]!) return;
    data[i] = Math.round(clamp(r, 0, 1) * 255);
    data[i + 1] = Math.round(clamp(g, 0, 1) * 255);
    data[i + 2] = Math.round(clamp(b, 0, 1) * 255);
    data[i + 3] = Math.round(clamp(a, 0, 1) * 255);
  };

  const segment = (x0: number, y0: number, x1: number, y1: number, width: number, r: number, g: number, b: number) => {
    const minX = Math.floor(Math.min(x0, x1) - width - 1), maxX = Math.ceil(Math.max(x0, x1) + width + 1);
    const minY = Math.floor(Math.min(y0, y1) - width - 1), maxY = Math.ceil(Math.max(y0, y1) + width + 1);
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const t = clamp(((x - x0) * dx + (y - y0) * dy) / len2, 0, 1);
      const px = x0 + dx * t, py = y0 + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d <= width + 0.75) {
        const a = clamp(1 - Math.max(0, d - width * 0.55) / (width * 0.45 + 0.75), 0, 1);
        put(x, y, r, g, b, a);
      }
    }
  };

  if (kind === 'pine') {
    // Horizontal woody rachis with dense paired needles drooping above/below.
    // U runs along the branch so the spray maps naturally onto a branch card.
    segment(SIZE * 0.03, SIZE * 0.52, SIZE * 0.97, SIZE * 0.50, 2.2, 0.34, 0.27, 0.18);
    const pairs = 72;
    for (let i = 0; i < pairs; i++) {
      const t = i / (pairs - 1);
      const x = SIZE * (0.05 + t * 0.90);
      const y = SIZE * (0.51 + Math.sin(t * 3.1) * 0.015);
      const envelope = Math.sin(Math.min(1, t * 1.12) * Math.PI) * 0.55 + 0.45;
      const length = SIZE * (0.44 * (1 - t * 0.55) * envelope + 0.04);
      const angle = 0.45 + random() * 0.4;
      for (const side of [-1, 1]) {
        const x1 = x + Math.sin(angle) * length * 0.35;
        const y1 = y + side * Math.cos(angle) * length;
        const shade = 0.85 + random() * 0.5;
        segment(x, y, x1, y1, 1.25 + random() * 0.55, 0.55 * shade, 0.78 * shade, 0.52 * shade);
        if (random() < 0.5) segment(x, y, x1, y1, 0.45, 0.78 * shade, 0.95 * shade, 0.66 * shade);
      }
      if (i % 6 === 3) {
        for (const side of [-1, 1]) {
          const bx = x + SIZE * 0.02;
          const by = y + side * SIZE * 0.10 * envelope;
          segment(x, y, bx, by, 1.1, 0.48, 0.42, 0.28);
          for (let k = 0; k < 6; k++) {
            const tt = k / 5;
            const nx = bx + SIZE * 0.06 * tt;
            const ny = by + side * SIZE * 0.05 * tt;
            segment(bx + SIZE * 0.03 * tt, by + side * SIZE * 0.02 * tt, nx, ny, 0.9, 0.58, 0.82, 0.55);
          }
        }
      }
    }
  } else {
    const leaves = kind === 'aspen' ? 96 : 140;
    for (let i = 0; i < leaves; i++) {
      const cx = SIZE * (0.10 + random() * 0.80);
      const cy = SIZE * (0.10 + random() * 0.80);
      const angle = random() * Math.PI * 2;
      const rx = kind === 'aspen' ? 7 + random() * 10 : 4 + random() * 6;
      const ry = rx * (kind === 'aspen' ? 1.2 : 0.6);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const gold = kind === 'aspen' ? random() : random() * 0.25;
      const baseR = kind === 'aspen' ? 0.62 + gold * 0.30 : 0.55 + random() * 0.16;
      const baseG = kind === 'aspen' ? 0.78 + gold * 0.14 : 0.74 + random() * 0.16;
      const baseB = kind === 'aspen' ? 0.42 + gold * 0.16 : 0.46 + random() * 0.12;
      const minX = Math.floor(cx - rx - ry - 1), maxX = Math.ceil(cx + rx + ry + 1);
      const minY = Math.floor(cy - rx - ry - 1), maxY = Math.ceil(cy + rx + ry + 1);
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const dx = x - cx, dy = y - cy;
        const lx = (dx * cos + dy * sin) / rx;
        const ly = (-dx * sin + dy * cos) / ry;
        const d = lx * lx + ly * ly;
        if (d <= 1) {
          const edge = clamp((1 - d) * 5, 0, 1);
          const vein = Math.abs(lx) < 0.07 ? 0.10 : (Math.abs(ly - lx * 0.35) < 0.05 ? 0.045 : 0);
          const shade = 0.86 + 0.14 * (1 - d);
          put(x, y, baseR * shade + vein, baseG * shade + vein, baseB * shade + vein * 0.6, edge);
        }
      }
      // Petiole connecting the leaf toward the spray centre.
      if (kind === 'aspen' && random() < 0.6) {
        segment(cx, cy, SIZE * 0.5 + (cx - SIZE * 0.5) * 0.55, SIZE * 0.5 + (cy - SIZE * 0.5) * 0.55, 0.7, 0.33, 0.36, 0.18);
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
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
