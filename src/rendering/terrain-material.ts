import { Color, MeshStandardNodeMaterial, MeshBasicNodeMaterial, FrontSide, Vector2 } from 'three/webgpu';
import { attribute, positionWorld, normalLocal, cameraPosition, vec3, float, mix, smoothstep, uniform, triplanarTexture, texture, bumpMap } from 'three/tsl';
import { mod } from '../utils/math';
import { BIOMES } from '../world/biomes';
import { createSurfaceTexture } from './surface-textures';

/**
 * Macro climate color is interpolated in vertex colors. Three seamless procedural
 * surfaces are blended by rock/snow masks and triplanar-projected in world space.
 * A second, continuous four-weight attribute drives the biome debug palette and
 * subtle ground tint, so borders blend instead of snapping to a dominant biome.
 * Materials are shared per LOD/mode to keep state changes and disposal bounded.
 */
export function createTerrainMaterial() {
  const originXZ = uniform(new Vector2());
  const detailStrength = uniform(1);
  const world = positionWorld.add(vec3(originXZ.x, 0, originXZ.y));
  const surface = attribute('surface', 'vec3');
  const weights = attribute('biomeWeights', 'vec4');
  const rock = surface.x.mul(float(1).sub(surface.y));
  const snow = surface.y;
  const grassTexture = createSurfaceTexture('grass');
  const rockTexture = createSurfaceTexture('rock');
  const snowTexture = createSurfaceTexture('snow');
  // Power-of-two world periods divide the 1024 m shader-origin wrap exactly.
  const grassSample = triplanarTexture(texture(grassTexture), null, null, float(0.25), world, normalLocal);
  const stoneSample = triplanarTexture(texture(rockTexture), null, null, float(0.0625), world, normalLocal);
  const iceSample = triplanarTexture(texture(snowTexture), null, null, float(0.125), world, normalLocal);
  const fade = float(1).sub(smoothstep(120, 850, positionWorld.distance(cameraPosition))).mul(detailStrength);

  const biomeColors = BIOMES.map((biome) => new Color(biome.color));
  const c = biomeColors.map((color) => vec3(color.r, color.g, color.b));
  const snowWeight = float(1).sub(weights.x.add(weights.y).add(weights.z).add(weights.w));
  const weightedColor = c[0]!.mul(weights.x).add(c[1]!.mul(weights.y)).add(c[2]!.mul(weights.z)).add(c[3]!.mul(weights.w)).add(c[4]!.mul(snowWeight));
  // Only a gentle tint: the worker's macro albedo already carries climate color.
  const grassTint = mix(vec3(1), weightedColor.mul(1.35).add(vec3(0.25)), 0.28);
  const grass = grassSample.rgb.mul(grassTint);
  const detail = grass.mul(float(1).sub(rock).sub(snow)).add(stoneSample.rgb.mul(rock)).add(iceSample.rgb.mul(snow));
  const albedo = attribute('color', 'vec3').mul(mix(vec3(1), detail, fade.mul(0.9)));
  const stoneHeight = texture(rockTexture, world.xz.mul(0.0625)).a;
  const grassHeight = texture(grassTexture, world.xz.mul(0.25)).a;
  const relief = mix(grassHeight, stoneHeight, rock);
  const lodColors = [0xc5e6a6, 0x80c9b1, 0x70b5d0, 0x8898df, 0xc193ce, 0xe5b77d].map((hex) => new Color(hex));
  const materials = new Map<string, MeshStandardNodeMaterial | MeshBasicNodeMaterial>();
  let wireframe = false;

  function createTileMaterial(level: number, debug: false): MeshStandardNodeMaterial;
  function createTileMaterial(level: number, debug: true): MeshBasicNodeMaterial;
  function createTileMaterial(level: number, debug: 'biome'): MeshBasicNodeMaterial;
  function createTileMaterial(level: number, debug: boolean | 'biome') {
    const key = `${level}:${debug}`;
    const cached = materials.get(key);
    if (cached) return cached;
    const material = debug ? new MeshBasicNodeMaterial({ side: FrontSide }) : new MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0, side: FrontSide });
    material.name = debug === 'biome' ? 'Climate biomes / continuous weights' : debug ? `Terrain LOD ${level}` : 'Climate ground / layered detail';
    material.wireframe = wireframe;
    if (debug === 'biome') {
      material.colorNode = weightedColor;
    } else if (debug) {
      const color = lodColors[level]!;
      material.colorNode = vec3(color.r, color.g, color.b);
    } else {
      const ground = material as MeshStandardNodeMaterial;
      ground.colorNode = albedo;
      ground.roughnessNode = float(0.95).sub(snow.mul(0.38)).sub(rock.mul(0.08));
      ground.normalNode = bumpMap(relief, fade.mul(rock.mul(0.3).add(float(0.1).mul(float(1).sub(snow)))));
    }
    materials.set(key, material);
    return material;
  }

  return {
    createTileMaterial,
    setWireframe(enabled: boolean) {
      wireframe = enabled;
      for (const material of materials.values()) material.wireframe = enabled;
    },
    setDetail(enabled: boolean) { detailStrength.value = enabled ? 1 : 0; },
    get detailEnabled() { return detailStrength.value > 0.5; },
    setOrigin(x: number, z: number) { originXZ.value.set(mod(x, 1024), mod(z, 1024)); },
    dispose() {
      for (const material of materials.values()) material.dispose();
      materials.clear();
      grassTexture.dispose(); rockTexture.dispose(); snowTexture.dispose();
    },
  };
}
