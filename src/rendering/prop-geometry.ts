import { BufferGeometry, BufferAttribute, Color, BoxGeometry, CylinderGeometry, PlaneGeometry, CanvasTexture, SRGBColorSpace, LinearFilter } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PropKind } from '../world/road-geometry';
import type { GeometryDetail } from '../config';

function tag(geometry: BufferGeometry, hex: number, face = 0): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const color = new Color(hex), colors = new Float32Array(count * 3), faces = new Float32Array(count);
  for (let i = 0; i < count; i++) { colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b; faces[i] = face; }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('propFace', new BufferAttribute(faces, 1));
  if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  return geometry;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number, face = 0) => tag(new BoxGeometry(w, h, d).translate(x, y, z), hex, face);
function merge(parts: BufferGeometry[]): BufferGeometry {
  const expanded = parts.map((p) => { if (!p.index) return p; const n = p.toNonIndexed(); p.dispose(); return n; });
  const geometry = mergeGeometries(expanded, false);
  if (!geometry) throw new Error('Unable to build road prop geometry');
  for (const p of expanded) p.dispose();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Roadside furniture. Forward is +Z; guardrail segments run along Z. */
export function createPropGeometry(kind: PropKind, detail: GeometryDetail = 'full'): BufferGeometry {
  const segments = detail === 'low' ? 6 : detail === 'ultra' ? 12 : 8;
  const parts: BufferGeometry[] = [];
  switch (kind) {
    case 'guardrail': {
      parts.push(box(0.07, 0.26, 4, 0, 0.74, 0, 0x9fa6ad));
      parts.push(box(0.10, 0.055, 4, 0.02, 0.80, 0, 0xb7bec4));
      parts.push(box(0.10, 0.055, 4, 0.02, 0.68, 0, 0x858d95));
      for (const z of [-1.8, 1.8]) {
        parts.push(box(0.11, 0.82, 0.12, -0.05, 0.39, z, 0x6f777f));
        parts.push(box(0.16, 0.05, 0.16, -0.05, 0.02, z, 0x555b60));
      }
      break;
    }
    case 'reflector': {
      parts.push(box(0.11, 1.05, 0.07, 0, 0.52, 0, 0xe8e8e2));
      parts.push(box(0.115, 0.22, 0.075, 0, 0.86, 0, 0x22262a));
      parts.push(box(0.07, 0.09, 0.02, 0, 0.88, 0.045, 0xffb23e));
      break;
    }
    case 'route-sign': {
      parts.push(box(0.08, 2.5, 0.08, 0, 1.25, 0, 0x8a9096));
      parts.push(box(0.95, 0.95, 0.06, 0, 2.25, 0, 0x1f5c46));
      const face = new PlaneGeometry(0.9, 0.9).translate(0, 2.25, 0.035);
      parts.push(tag(face, 0xffffff, 1));
      break;
    }
    case 'direction-sign': {
      for (const x of [-1.1, 1.1]) parts.push(box(0.09, 2.7, 0.09, x, 1.35, 0, 0x7d858c));
      parts.push(box(2.7, 0.85, 0.07, 0, 2.45, 0, 0x1f5c46));
      parts.push(tag(new PlaneGeometry(2.62, 0.77).translate(0, 2.45, 0.04), 0xffffff, 1));
      break;
    }
    case 'bench': {
      const wood = 0x8a6540, metal = 0x3a4045;
      for (const z of [-0.18, 0, 0.18]) parts.push(box(1.8, 0.055, 0.14, 0, 0.46, z, wood));
      for (const y of [0.72, 0.9]) parts.push(box(1.8, 0.12, 0.045, 0, y, -0.27, wood));
      for (const x of [-0.75, 0.75]) {
        parts.push(box(0.07, 0.46, 0.4, x, 0.23, 0, metal));
        parts.push(box(0.07, 0.6, 0.07, x, 0.72, -0.28, metal));
      }
      break;
    }
    case 'kiosk': {
      for (const x of [-0.75, 0.75]) parts.push(box(0.1, 2.2, 0.1, x, 1.1, 0, 0x5a4632));
      parts.push(box(1.7, 1.2, 0.08, 0, 1.55, 0, 0x284b3d));
      parts.push(tag(new PlaneGeometry(1.6, 1.1).translate(0, 1.55, 0.045), 0xffffff, 1));
      parts.push(box(1.95, 0.08, 0.55, 0, 2.25, 0.1, 0x5a4632));
      break;
    }
    case 'bollard': {
      parts.push(tag(new CylinderGeometry(0.075, 0.09, 0.9, segments).translate(0, 0.45, 0), 0x6b5138));
      parts.push(tag(new CylinderGeometry(0.078, 0.078, 0.1, segments).translate(0, 0.78, 0), 0xe8e4d4));
      break;
    }
  }
  return merge(parts);
}

export type SignKind = 'route' | 'direction' | 'kiosk';
/** Crisp procedural sign faces; no downloaded art or font-dependent geometry. */
export function createSignTexture(kind: SignKind): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = kind === 'route' ? 256 : 512; canvas.height = kind === 'kiosk' ? 384 : 256;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = kind === 'kiosk' ? '#e9e2cc' : '#1f5c46'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = kind === 'kiosk' ? '#4b5b43' : '#f2f0e6'; ctx.lineWidth = 8; ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.textAlign = 'center'; ctx.fillStyle = kind === 'kiosk' ? '#2f3d2d' : '#f4f2e8';
  if (kind === 'route') {
    ctx.font = 'bold 34px sans-serif'; ctx.fillText('SCENIC', w / 2, 78);
    ctx.font = 'bold 46px sans-serif'; ctx.fillText('ROUTE', w / 2, 132);
    ctx.beginPath(); ctx.moveTo(w / 2, 158); ctx.lineTo(w / 2 + 34, 196); ctx.lineTo(w / 2, 234); ctx.lineTo(w / 2 - 34, 196); ctx.closePath(); ctx.lineWidth = 6; ctx.stroke();
  } else if (kind === 'direction') {
    ctx.font = 'bold 44px sans-serif'; ctx.fillText('WAYFARER', w / 2, 92);
    ctx.font = '28px sans-serif'; ctx.fillText('SCENIC OVERLOOK  →', w / 2, 158);
    ctx.font = '22px sans-serif'; ctx.fillText('NEXT REST AREA  ·  1.5 km', w / 2, 208);
  } else {
    ctx.font = 'bold 38px sans-serif'; ctx.fillText('WAYFARER', w / 2, 70);
    ctx.font = 'bold 30px sans-serif'; ctx.fillText('SCENIC OVERLOOK', w / 2, 122);
    ctx.strokeStyle = '#8a9377'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(50, 150); ctx.lineTo(w - 50, 150); ctx.stroke();
    ctx.font = '22px sans-serif';
    ctx.fillText('A world without edges.', w / 2, 195);
    ctx.fillText('Pause. Look further.', w / 2, 230);
    ctx.font = 'bold 20px sans-serif'; ctx.fillText('LEAVE NO TRACE', w / 2, 312);
    ctx.font = '17px sans-serif'; ctx.fillText('Pack out what you pack in.', w / 2, 344);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace; texture.minFilter = LinearFilter; texture.magFilter = LinearFilter; texture.generateMipmaps = false;
  texture.name = `Procedural ${kind} sign`;
  return texture;
}
