import { Color, MeshStandardNodeMaterial, MeshBasicNodeMaterial, FrontSide, Vector2 } from 'three/webgpu';
import { attribute, positionWorld, vec3, mx_noise_float, uniform } from 'three/tsl';
import { mod } from '../utils/math';

/**
 * Shared shader graph, explicit per-tile uniforms. A material instance is cheap;
 * the compiled pipeline is shared. Explicit references avoid cross-tile userData
 * aliasing in renderer node-builder caches.
 */
export function createTerrainMaterial() {
  const originXZ = uniform(new Vector2());
  const worldXZ = positionWorld.xz.add(originXZ);
  const grain = mx_noise_float(vec3(worldXZ.mul(0.16), 0.5));
  const mottling = mx_noise_float(vec3(worldXZ.mul(0.013), 2.7));
  const albedo = attribute('color', 'vec3').mul(grain.mul(0.14).add(mottling.mul(0.16)).add(0.85));
  const lodColors = [0xc5e6a6, 0x80c9b1, 0x70b5d0, 0x8898df, 0xc193ce, 0xe5b77d].map((hex) => new Color(hex));
  let wireframe = false;

  function createTileMaterial(level: number, debug: false): MeshStandardNodeMaterial;
  function createTileMaterial(level: number, debug: true): MeshBasicNodeMaterial;
  function createTileMaterial(level: number, debug: boolean) {
    const material = debug ? new MeshBasicNodeMaterial({ side: FrontSide }) : new MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0, side: FrontSide });
    material.name = debug ? `Terrain LOD ${level}` : 'Alpine ground / phase 1';
    material.wireframe = wireframe;
    material.colorNode = debug ? vec3(lodColors[level]!.r, lodColors[level]!.g, lodColors[level]!.b) : albedo;
    return material;
  }
  return {
    createTileMaterial,
    setWireframe(enabled: boolean) { wireframe = enabled; },
    setOrigin(x: number, z: number) {
      // Bounded shader inputs avoid origin-sized floats. Macro albedo remains
      // world-space; only fine grain can shift subtly at a rebase boundary.
      originXZ.value.set(mod(x, 1024), mod(z, 1024));
    },
  };
}
