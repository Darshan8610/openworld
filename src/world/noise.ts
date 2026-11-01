import { seededRandom } from '../utils/random';

const GRADIENTS = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1];
const F2 = (Math.sqrt(3) - 1) / 2;
const G2 = (3 - Math.sqrt(3)) / 6;

/**
 * Seeded 2D simplex noise, following Gustavson's public-domain lattice formulation.
 * No global random state: two generators with the same seed are interchangeable.
 */
export class SimplexNoise {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const random = seededRandom(seed);
    const p = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const value = p[i]!;
      p[i] = p[j]!;
      p[j] = value;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  noise(x: number, y: number): number {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const p = this.perm;
    const g0 = (p[ii + p[jj]!]! & 7) * 2;
    const g1 = (p[ii + i1 + p[jj + j1]!]! & 7) * 2;
    const g2 = (p[ii + 1 + p[jj + 1]!]! & 7) * 2;
    const corner = (a: number, b: number, g: number): number => {
      let q = 0.5 - a * a - b * b;
      if (q <= 0) return 0;
      q *= q;
      return q * q * (GRADIENTS[g]! * a + GRADIENTS[g + 1]! * b);
    };
    return 70 * (corner(x0, y0, g0) + corner(x1, y1, g1) + corner(x2, y2, g2));
  }

  fbm(x: number, y: number, octaves = 4): number {
    let sum = 0, amplitude = 0.5, normalization = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x, y) * amplitude;
      normalization += amplitude;
      x = x * 2.03 + 17.1;
      y = y * 2.03 - 9.2;
      amplitude *= 0.49;
    }
    return sum / normalization;
  }

  ridged(x: number, y: number, octaves = 5): number {
    let sum = 0, amplitude = 0.5, weight = 1, normalization = 0;
    for (let i = 0; i < octaves; i++) {
      let ridge = 1 - Math.abs(this.noise(x, y));
      ridge *= ridge;
      ridge *= weight;
      weight = Math.min(1, ridge * 2.1);
      sum += ridge * amplitude;
      normalization += amplitude;
      x = x * 2.07 + 5.3;
      y = y * 2.07 + 8.9;
      amplitude *= 0.48;
    }
    return sum / normalization;
  }
}
