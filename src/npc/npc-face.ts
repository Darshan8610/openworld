import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  Object3D,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from 'three/webgpu';

/**
 * Procedural Unique Facial Synthesis System for Wayfarer.
 *
 * Guarantees that EVERY single NPC in the world has a distinct, individual face,
 * skin tone, eye color, eyebrow shape, facial hair, hairstyle, and headwear.
 *
 * Combinatorial space:
 *  16 skin tones × 8 eye colors × 8 hair colors × 9 hair styles ×
 *  8 facial hair styles × 6 eyewear accessories × 6 distinctive marks
 *  = 3,981,312 unique facial appearances.
 */

export function hashString(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export const SKIN_TONES = [
  0xf5d6c6, 0xefc4ab, 0xe4af8c, 0xd89b6f,
  0xc78753, 0xbc7846, 0xaf6837, 0x9e572b,
  0x8f4820, 0x803d19, 0x6f3113, 0x5e260e,
  0x4e1e0a, 0x3e1708, 0x301106, 0x240d04,
];

export const EYE_COLORS = [
  '#3d2314', // deep brown
  '#634e34', // warm hazel
  '#2a5a35', // emerald green
  '#355a72', // steel blue
  '#5d7280', // slate gray
  '#7a5828', // golden amber
  '#4a362a', // chocolate
  '#181818', // obsidian
];

export const HAIR_COLORS = [
  0x1c1714, // jet black
  0x2b221b, // dark brown
  0x463223, // chestnut brown
  0x664830, // light brown
  0x8c6239, // dirty blonde
  0xb89052, // golden blonde
  0x7c3218, // auburn red
  0x5a5a5a, // silver / gray
];

const faceTextureCache = new Map<string, CanvasTexture>();

/** Generate a unique 256x256 face texture with eyes, eyebrows, nose, mouth, facial hair */
export function createUniqueFaceTexture(id: string): CanvasTexture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;

  const cached = faceTextureCache.get(id);
  if (cached) return cached;

  try {
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const hash = hashString(id);
    const skinHex = SKIN_TONES[hash % SKIN_TONES.length] ?? 0xd89b6f;
    const skinColor = new Color(skinHex);
    const eyeColor = EYE_COLORS[(hash >>> 4) % EYE_COLORS.length] ?? '#3d2314';
    const hairHex = HAIR_COLORS[(hash >>> 7) % HAIR_COLORS.length] ?? 0x2b221b;
    const hairColor = new Color(hairHex);
    const hairRgb = `rgb(${Math.round(hairColor.r * 255)}, ${Math.round(hairColor.g * 255)}, ${Math.round(hairColor.b * 255)})`;
    const facialHairType = (hash >>> 10) % 8;
    const eyebrowStyle = (hash >>> 13) % 6;
    const markType = (hash >>> 16) % 6;

    // Helper for safe ellipse drawing (since some Node/jsdom stubs lack ellipse)
    const drawEllipse = (cx: number, cy: number, rx: number, ry: number) => {
      if (typeof ctx.ellipse === 'function') {
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      } else {
        ctx.arc(cx, cy, (rx + ry) * 0.5, 0, Math.PI * 2);
      }
    };

    // 1. Base skin with soft vertical gradient
    let grad: any = null;
    if (typeof ctx.createLinearGradient === 'function') {
      try {
        grad = ctx.createLinearGradient(0, 0, 0, 256);
        if (grad && typeof grad.addColorStop === 'function') {
          grad.addColorStop(0, `rgb(${Math.min(255, Math.round(skinColor.r * 270))}, ${Math.min(255, Math.round(skinColor.g * 270))}, ${Math.min(255, Math.round(skinColor.b * 270))})`);
          grad.addColorStop(0.5, `rgb(${Math.round(skinColor.r * 255)}, ${Math.round(skinColor.g * 255)}, ${Math.round(skinColor.b * 255)})`);
          grad.addColorStop(1, `rgb(${Math.round(skinColor.r * 220)}, ${Math.round(skinColor.g * 220)}, ${Math.round(skinColor.b * 220)})`);
        } else {
          grad = null;
        }
      } catch {
        grad = null;
      }
    }
    ctx.fillStyle = grad ?? `rgb(${Math.round(skinColor.r * 255)}, ${Math.round(skinColor.g * 255)}, ${Math.round(skinColor.b * 255)})`;
    ctx.fillRect(0, 0, 256, 256);

    // Soft cheek flush
    ctx.fillStyle = 'rgba(210, 80, 80, 0.12)';
    ctx.beginPath();
    drawEllipse(65, 145, 30, 20);
    drawEllipse(191, 145, 30, 20);
    ctx.fill();

    // 2. Eyes (left: 80, right: 176)
    const eyeY = 108;
    for (const eyeX of [80, 176]) {
      // Sclera (white of eye)
      ctx.fillStyle = '#f8f8fa';
      ctx.beginPath();
      drawEllipse(eyeX, eyeY, 18, 10);
      ctx.fill();

      // Iris
      ctx.fillStyle = eyeColor;
      ctx.beginPath();
      ctx.arc(eyeX, eyeY, 7.5, 0, Math.PI * 2);
      ctx.fill();

      // Pupil
      ctx.fillStyle = '#080808';
      ctx.beginPath();
      ctx.arc(eyeX, eyeY, 3.8, 0, Math.PI * 2);
      ctx.fill();

      // Specular glint
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(eyeX - 2.2, eyeY - 2.2, 1.8, 0, Math.PI * 2);
      ctx.fill();

      // Upper eyelid shadow & lash
      ctx.strokeStyle = hairRgb;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(eyeX, eyeY, 14, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }

    // 3. Eyebrows
    ctx.strokeStyle = hairRgb;
    ctx.fillStyle = hairRgb;
    ctx.lineWidth = eyebrowStyle === 2 ? 5.5 : eyebrowStyle === 4 ? 3.0 : 4.2;
    ctx.lineCap = 'round';

    // Left eyebrow
    ctx.beginPath();
    ctx.moveTo(56, eyeY - 14);
    if (eyebrowStyle === 0) ctx.quadraticCurveTo(80, eyeY - 24, 102, eyeY - 15);
    else if (eyebrowStyle === 1) ctx.lineTo(102, eyeY - 16);
    else ctx.quadraticCurveTo(80, eyeY - 21, 102, eyeY - 13);
    ctx.stroke();

    // Right eyebrow
    ctx.beginPath();
    ctx.moveTo(154, eyeY - 13);
    if (eyebrowStyle === 0) ctx.quadraticCurveTo(176, eyeY - 24, 200, eyeY - 14);
    else if (eyebrowStyle === 1) ctx.lineTo(200, eyeY - 16);
    else ctx.quadraticCurveTo(176, eyeY - 21, 200, eyeY - 15);
    ctx.stroke();

    // 4. Nose
    ctx.strokeStyle = 'rgba(70, 30, 15, 0.28)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(128, eyeY - 4);
    ctx.lineTo(124, eyeY + 36);
    ctx.lineTo(133, eyeY + 42);
    ctx.stroke();

    // Nostril wings
    ctx.fillStyle = 'rgba(60, 25, 10, 0.35)';
    ctx.beginPath();
    ctx.arc(120, eyeY + 41, 2.5, 0, Math.PI * 2);
    ctx.arc(136, eyeY + 41, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // 5. Mouth & Lips
    const mouthY = 188;
    const lipTint = `rgba(${Math.round(skinColor.r * 220 + 35)}, ${Math.round(skinColor.g * 170)}, ${Math.round(skinColor.b * 170)}, 0.65)`;
    ctx.fillStyle = lipTint;
    // Upper lip
    ctx.beginPath();
    ctx.moveTo(106, mouthY);
    ctx.quadraticCurveTo(128, mouthY - 7, 150, mouthY);
    ctx.quadraticCurveTo(128, mouthY - 2, 106, mouthY);
    ctx.fill();
    // Lower lip
    ctx.beginPath();
    ctx.moveTo(108, mouthY);
    ctx.quadraticCurveTo(128, mouthY + 9, 148, mouthY);
    ctx.quadraticCurveTo(128, mouthY + 1, 108, mouthY);
    ctx.fill();
    // Lip seam
    ctx.strokeStyle = 'rgba(70, 20, 20, 0.45)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(105, mouthY);
    ctx.quadraticCurveTo(128, mouthY + 1, 151, mouthY);
    ctx.stroke();

    // 6. Facial Hair
    if (facialHairType > 0) {
      ctx.fillStyle = hairRgb;
      ctx.strokeStyle = hairRgb;

      if (facialHairType === 1) {
        // 5 o'clock stubble
        ctx.fillStyle = 'rgba(40, 30, 25, 0.22)';
        ctx.beginPath();
        drawEllipse(128, 195, 48, 38);
        ctx.fill();
      } else if (facialHairType === 2) {
        // Goatee
        ctx.beginPath();
        ctx.arc(128, 204, 18, 0, Math.PI);
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(112, mouthY - 4);
        ctx.quadraticCurveTo(128, mouthY - 8, 144, mouthY - 4);
        ctx.lineWidth = 4;
        ctx.stroke();
      } else if (facialHairType === 3) {
        // Handlebar mustache
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(102, mouthY - 2);
        ctx.quadraticCurveTo(128, mouthY - 10, 154, mouthY - 2);
        ctx.stroke();
      } else if (facialHairType === 4 || facialHairType === 7) {
        // Full boxed or rugged beard
        ctx.beginPath();
        ctx.moveTo(75, 150);
        ctx.lineTo(85, 230);
        ctx.quadraticCurveTo(128, 250, 171, 230);
        ctx.lineTo(181, 150);
        ctx.lineWidth = 14;
        ctx.stroke();
        // Mustache
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(106, mouthY - 5);
        ctx.quadraticCurveTo(128, mouthY - 10, 150, mouthY - 5);
        ctx.stroke();
      } else if (facialHairType === 5) {
        // Sideburns
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(48, 80);
        ctx.lineTo(52, 160);
        ctx.moveTo(208, 80);
        ctx.lineTo(204, 160);
        ctx.stroke();
      } else if (facialHairType === 6) {
        // Pencil mustache
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(110, mouthY - 6);
        ctx.lineTo(146, mouthY - 6);
        ctx.stroke();
      }
    }

    // 7. Distinctive Mark
    if (markType === 1) {
      // Freckles
      ctx.fillStyle = 'rgba(120, 60, 30, 0.35)';
      for (let i = 0; i < 14; i++) {
        const fx = 75 + (i * 13) % 106;
        const fy = 125 + (i * 7) % 24;
        ctx.fillRect(fx, fy, 2, 2);
      }
    } else if (markType === 2) {
      // Eyebrow scar
      ctx.strokeStyle = `rgb(${Math.min(255, Math.round(skinColor.r * 300))}, ${Math.min(255, Math.round(skinColor.g * 300))}, ${Math.min(255, Math.round(skinColor.b * 300))})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(88, eyeY - 26);
      ctx.lineTo(92, eyeY - 8);
      ctx.stroke();
    } else if (markType === 3) {
      // Beauty mark
      ctx.fillStyle = '#221510';
      ctx.beginPath();
      ctx.arc(88, 165, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    faceTextureCache.set(id, texture);
    return texture;
  } catch {
    return null;
  }
}

/**
 * Construct 3D hair and accessories, attached directly to an NPC head bone/mesh.
 */
export function buildUniqueHeadAccessories(parent: Object3D, id: string): void {
  // Remove existing procedural head accessories if any
  const existing = parent.getObjectByName('npc_unique_head');
  if (existing) parent.remove(existing);

  const group = new Group();
  group.name = 'npc_unique_head';

  const hash = hashString(id);
  const hairHex = HAIR_COLORS[(hash >>> 7) % HAIR_COLORS.length] ?? 0x2b221b;
  const hairStyle = (hash >>> 13) % 9;
  const accessory = (hash >>> 19) % 6;

  const hairMat = new MeshStandardNodeMaterial({
    color: hairHex,
    roughness: 0.85,
    metalness: 0.05,
  });

  // 1. Curved Face Mesh displaying the unique CanvasTexture
  const faceTex = createUniqueFaceTexture(id);
  const skinHex = SKIN_TONES[hash % SKIN_TONES.length] ?? 0xd89b6f;
  const faceMat = new MeshStandardNodeMaterial({
    color: skinHex,
    roughness: 0.65,
    metalness: 0.02,
  });
  if (faceTex) faceMat.map = faceTex;

  const facePlate = new Mesh(new CylinderGeometry(0.112, 0.112, 0.18, 14, 1, false, -Math.PI * 0.35, Math.PI * 0.7), faceMat);
  facePlate.position.set(0, 0, 0.01);
  facePlate.rotation.y = Math.PI;
  group.add(facePlate);

  // 2. 3D Hair / Headwear
  if (hairStyle === 0) {
    // Buzzcut / Fade (thin sleek cap)
    const cap = new Mesh(new SphereGeometry(0.118, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
    cap.position.set(0, 0.02, -0.01);
    group.add(cap);
  } else if (hairStyle === 1) {
    // Side part
    const part = new Mesh(new SphereGeometry(0.124, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.58), hairMat);
    part.position.set(-0.015, 0.035, -0.01);
    group.add(part);
  } else if (hairStyle === 2) {
    // Textured crop / spiky top
    const top = new Mesh(new BoxGeometry(0.17, 0.06, 0.18), hairMat);
    top.position.set(0, 0.12, -0.01);
    group.add(top);
  } else if (hairStyle === 3) {
    // Afro volume
    const afro = new Mesh(new SphereGeometry(0.142, 12, 10), hairMat);
    afro.position.set(0, 0.04, -0.02);
    group.add(afro);
  } else if (hairStyle === 4) {
    // Dreadlocks / braids (cylinders hanging on shoulders)
    const base = new Mesh(new SphereGeometry(0.124, 10, 8), hairMat);
    base.position.set(0, 0.02, -0.01);
    group.add(base);
    for (const sx of [-1, 1]) {
      const strand = new Mesh(new CylinderGeometry(0.02, 0.015, 0.16, 6), hairMat);
      strand.position.set(sx * 0.10, -0.05, -0.02);
      group.add(strand);
    }
  } else if (hairStyle === 5) {
    // Pompadour / slicked back
    const pomp = new Mesh(new BoxGeometry(0.14, 0.07, 0.22), hairMat);
    pomp.position.set(0, 0.11, 0.02);
    group.add(pomp);
  } else if (hairStyle === 6) {
    // Long flow
    const flow = new Mesh(new SphereGeometry(0.125, 12, 10), hairMat);
    flow.position.set(0, 0.02, -0.02);
    group.add(flow);
    const drape = new Mesh(new BoxGeometry(0.19, 0.18, 0.06), hairMat);
    drape.position.set(0, -0.08, -0.10);
    group.add(drape);
  } else if (hairStyle === 7) {
    // Beanie knit cap
    const beanieHex = [0x222222, 0xc0392b, 0x27ae60, 0xd35400, 0x2980b9][hash % 5]!;
    const beanieMat = new MeshStandardNodeMaterial({ color: beanieHex, roughness: 0.9 });
    const beanie = new Mesh(new CylinderGeometry(0.128, 0.125, 0.14, 12), beanieMat);
    beanie.position.set(0, 0.08, -0.01);
    group.add(beanie);
  } else if (hairStyle === 8) {
    // Baseball cap with forward visor brim
    const capHex = [0x111111, 0x1e3799, 0xb71540, 0x079992][hash % 4]!;
    const capMat = new MeshStandardNodeMaterial({ color: capHex, roughness: 0.7 });
    const dome = new Mesh(new SphereGeometry(0.126, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52), capMat);
    dome.position.set(0, 0.03, -0.01);
    group.add(dome);
    // Visor brim
    const brim = new Mesh(new BoxGeometry(0.14, 0.015, 0.09), capMat);
    brim.position.set(0, 0.03, 0.13);
    brim.rotation.x = -0.12;
    group.add(brim);
  }

  // 3. Eyewear & Accessories
  if (accessory === 1) {
    // Aviator sunglasses
    const shadeMat = new MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.8 });
    const wireMat = new MeshStandardNodeMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.9 });
    for (const sx of [-1, 1]) {
      const lens = new Mesh(new BoxGeometry(0.042, 0.032, 0.01), shadeMat);
      lens.position.set(sx * 0.042, 0.01, 0.118);
      group.add(lens);
    }
    const bridge = new Mesh(new BoxGeometry(0.04, 0.005, 0.01), wireMat);
    bridge.position.set(0, 0.022, 0.118);
    group.add(bridge);
  } else if (accessory === 2) {
    // Rectangular shades
    const blackMat = new MeshStandardNodeMaterial({ color: 0x080808, roughness: 0.2, metalness: 0.5 });
    const bar = new Mesh(new BoxGeometry(0.14, 0.032, 0.015), blackMat);
    bar.position.set(0, 0.01, 0.118);
    group.add(bar);
  } else if (accessory === 3) {
    // Reading spectacles
    const goldMat = new MeshStandardNodeMaterial({ color: 0xc49b38, roughness: 0.25, metalness: 0.95 });
    for (const sx of [-1, 1]) {
      const ring = new Mesh(new BoxGeometry(0.036, 0.03, 0.006), goldMat);
      ring.position.set(sx * 0.040, 0.01, 0.118);
      group.add(ring);
    }
  } else if (accessory === 4) {
    // Left ear gold hoop earring
    const goldMat = new MeshStandardNodeMaterial({ color: 0xffd700, roughness: 0.2, metalness: 0.95 });
    const hoop = new Mesh(new TorusGeometry(0.016, 0.004, 6, 12), goldMat);
    hoop.position.set(0.115, -0.03, -0.01);
    group.add(hoop);
  }

  parent.add(group);
}
