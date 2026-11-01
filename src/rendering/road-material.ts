import { MeshStandardNodeMaterial, FrontSide, Vector2 } from 'three/webgpu';
import { attribute, uv, texture, mix, vec3, float, bumpMap, smoothstep, positionWorld, cameraPosition, uniform } from 'three/tsl';
import { createSurfaceTexture } from './surface-textures';
import { mod } from '../utils/math';

/**
 * One shared PBR road material. Vertex colours carry lane markings; a float
 * attribute selects asphalt / gravel / paint so paint stays crisp while the
 * aggregate receives procedural albedo and bump. UVs are wrapped at 1024 m in
 * the worker, keeping texture phase invariant under floating-origin rebases.
 */
export function createRoadMaterial() {
  const asphalt = createSurfaceTexture('asphalt');
  const gravel = createSurfaceTexture('gravel');
  const origin = uniform(new Vector2());
  const kind = attribute('roadSurface', 'float');
  const paint = smoothstep(1.5, 2.0, kind);
  const gravelWeight = smoothstep(0.5, 1.0, kind).mul(float(1).sub(paint));
  const asphaltSample = texture(asphalt, uv());
  const gravelSample = texture(gravel, uv().mul(0.65));
  const detail = mix(asphaltSample.rgb, gravelSample.rgb, gravelWeight);
  const height = mix(asphaltSample.a, gravelSample.a, gravelWeight);
  const fade = float(1).sub(smoothstep(80, 900, positionWorld.distance(cameraPosition)));
  const material = new MeshStandardNodeMaterial({ vertexColors: true, side: FrontSide, roughness: 0.9, metalness: 0 });
  material.name = 'Scenic highway / asphalt, gravel & painted markings';
  material.colorNode = attribute('color', 'vec3').mul(mix(detail, vec3(1), paint));
  material.roughnessNode = mix(float(0.88), float(0.97), gravelWeight).sub(paint.mul(0.18));
  material.normalNode = bumpMap(height, fade.mul(float(1).sub(paint)).mul(mix(0.045, 0.12, gravelWeight)));
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
  return {
    material,
    setOrigin(x: number, z: number) { origin.value.set(mod(x, 1024), mod(z, 1024)); },
    dispose() { material.dispose(); asphalt.dispose(); gravel.dispose(); },
  };
}
