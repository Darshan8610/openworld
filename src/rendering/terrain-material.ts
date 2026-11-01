import type { Node } from 'three/webgpu';
import { Color, MeshStandardNodeMaterial, MeshBasicNodeMaterial, FrontSide, Vector2 } from 'three/webgpu';
import { attribute, positionWorld, normalLocal, cameraPosition, vec3, float, mix, smoothstep, uniform, triplanarTexture, texture, bumpMap } from 'three/tsl';
import { mod } from '../utils/math';
import { BIOMES } from '../world/biomes';
import { createSurfaceTexture } from './surface-textures';

/**
 * Macro climate color is interpolated in vertex colors. Three seamless procedural
 * surfaces are blended by the worker's rock/snow masks and triplanar-projected,
 * so cliffs need no UV chart. Detail fades before it can alias on the horizon.
 */
export function createTerrainMaterial() {
  const originXZ = uniform(new Vector2());
  const detailStrength = uniform(1);
  const world = positionWorld.add(vec3(originXZ.x, 0, originXZ.y));
  const surface = attribute('surface', 'vec3');
  const rock = surface.x.mul(float(1).sub(surface.y));
  const snow = surface.y;
  const grassTexture = createSurfaceTexture('grass');
  const rockTexture = createSurfaceTexture('rock');
  const snowTexture = createSurfaceTexture('snow');
  // Power-of-two world periods divide the 1024 m shader-origin wrap exactly.
  const grass = triplanarTexture(texture(grassTexture), null, null, float(0.25), world, normalLocal).rgb;
  const stone = triplanarTexture(texture(rockTexture), null, null, float(0.0625), world, normalLocal).rgb;
  const ice = triplanarTexture(texture(snowTexture), null, null, float(0.125), world, normalLocal).rgb;
  const detail = grass.mul(float(1).sub(rock).sub(snow)).add(stone.mul(rock)).add(ice.mul(snow));
  const fade = float(1).sub(smoothstep(140, 520, positionWorld.distance(cameraPosition))).mul(detailStrength);
  const albedo = attribute('color', 'vec3').mul(mix(vec3(1), detail, fade.mul(0.72)));
  // Top-projected bump avoids nine derivative texture fetches per pixel; the
  // albedo remains fully triplanar on cliffs.
  const stoneHeight = texture(rockTexture, world.xz.mul(0.0625)).a;
  const lodColors = [0xc5e6a6, 0x80c9b1, 0x70b5d0, 0x8898df, 0xc193ce, 0xe5b77d].map((hex) => new Color(hex));
  const biomeColors = BIOMES.map((biome) => new Color(biome.color));
  let wireframe = false;

  function createTileMaterial(level: number, debug: false): MeshStandardNodeMaterial;
  function createTileMaterial(level: number, debug: true): MeshBasicNodeMaterial;
  function createTileMaterial(level: number, debug: 'biome'): MeshBasicNodeMaterial;
  function createTileMaterial(level: number, debug: boolean | 'biome') {
    const material = debug ? new MeshBasicNodeMaterial({ side: FrontSide }) : new MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0, side: FrontSide });
    material.name = debug === 'biome' ? 'Climate biomes' : debug ? `Terrain LOD ${level}` : 'Climate ground / phase 2';
    material.wireframe = wireframe;
    if (debug === 'biome') {
      let color: Node<'vec3'> = vec3(biomeColors[0]!.r, biomeColors[0]!.g, biomeColors[0]!.b);
      for (let i = 1; i < biomeColors.length; i++) {
        const c = biomeColors[i]!;
        color = mix(color, vec3(c.r, c.g, c.b), smoothstep(i - 0.01, i + 0.01, surface.z));
      }
      material.colorNode = color;
    } else if (debug) {
      const c = lodColors[level]!;
      material.colorNode = vec3(c.r, c.g, c.b);
    } else {
      const ground = material as MeshStandardNodeMaterial;
      ground.colorNode = albedo;
      ground.roughnessNode = float(0.96).sub(snow.mul(0.2));
      ground.normalNode = bumpMap(stoneHeight, fade.mul(rock).mul(0.24));
    }
    return material;
  }
  return {
    createTileMaterial,
    setWireframe(enabled: boolean) { wireframe = enabled; },
    setDetail(enabled: boolean) { detailStrength.value = enabled ? 1 : 0; },
    get detailEnabled() { return detailStrength.value > 0.5; },
    setOrigin(x: number, z: number) { originXZ.value.set(mod(x, 1024), mod(z, 1024)); },
    dispose() { grassTexture.dispose(); rockTexture.dispose(); snowTexture.dispose(); },
  };
}
