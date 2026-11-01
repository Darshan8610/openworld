import { Color, MeshStandardNodeMaterial, DoubleSide, Vector2, Vector3 } from 'three/webgpu';
import {
  attribute, cameraPosition, cos, dot, float, mix, normalize, positionLocal, positionWorld,
  pow, saturate, sin, smoothstep, transformNormalToView, uniform, vec3,
} from 'three/tsl';
import { WATER_WAVES } from '../world/water-field';

const W = WATER_WAVES;
/** Steepness of the analytic wave normals; higher = choppier highlights. */
const NORMAL_GAIN = 3.2;

export interface WaterMaterialOptions {
  /** 0 flat, 1 waves, 2 waves + shoreline foam + sun glitter. */
  detail: 0 | 1 | 2;
  deepColor?: Color;
}

/**
 * One shared water surface material for every body (ponds, rivers, lakes, seas).
 *
 * The vertex displacement is the *same* three-wave sum the CPU uses for buoyancy
 * and swimming (`WaterField.waveOffset`). The wave phase is baked per vertex on
 * the CPU in canonical world space, so:
 *  - large world coordinates never lose precision inside the shader, and
 *  - the surface does not shift when the floating origin rebases.
 *
 * Backend portability: this is a node material built from portable TSL nodes, so
 * the existing WebGPU renderer and the WebGL2 fallback compile the same graph.
 * `detail: 0` (Low preset) drops displacement, foam and glitter entirely instead
 * of assuming the fallback will cope.
 */
export function createWaterMaterial(options: WaterMaterialOptions) {
  const detail = options.detail;
  const phase = attribute('waterPhase', 'vec3');
  const amplitude = attribute('waterAmp', 'float');
  const depth = attribute('waterDepth', 'float');
  const time = uniform(0);
  const sunDirection = uniform(new Vector3(0.3, 0.85, 0.2).normalize());
  const sunColor = uniform(new Color(1, 0.96, 0.9));
  const wind = uniform(new Vector2(1, 0));
  const activity = uniform(1);
  /** Rain intensity 0..1: pockmark normals, never height (physics stays a height field). */
  const rain = uniform(0);

  const deepColor = options.deepColor ?? new Color(0.012, 0.062, 0.098);
  const shallowColor = new Color(0.116, 0.335, 0.32);
  const foamColor = new Color(0.86, 0.91, 0.9);
  const deep = vec3(deepColor.r, deepColor.g, deepColor.b);
  const shallow = vec3(shallowColor.r, shallowColor.g, shallowColor.b);
  const foam = vec3(foamColor.r, foamColor.g, foamColor.b);

  // Depth response is shared by colour, opacity and wave damping.
  const depthFactor = saturate(depth.mul(0.42));
  const waveScale = amplitude
    .mul(mix(float(0.35), float(1), saturate(depth.mul(0.5))))
    .mul(activity);
  // Phase is precomputed per vertex; the shader only advances the wave trains.
  const phaseX = phase.x.add(time.mul(W.w1));
  const phaseY = phase.y.sub(time.mul(W.w2)).add(wind.x.mul(0.35));
  const phaseZ = phase.z.add(time.mul(W.w3));

  // Exactly `WaterField.waveOffset()`: a1 sin(k1·p + w1 t) + a2 sin(k2·p - w2 t)
  // + a3 sin(k3·p + w3 t), damped in the shallows by the same factor the CPU uses.
  const height = waveScale.mul(
    sin(phaseX).mul(W.a1).add(sin(phaseY).mul(W.a2)).add(sin(phaseZ).mul(W.a3)),
  );
  // Analytic gradient of the same sum (d/dx and d/dz).
  // Rain pockmarks: two crossing high-frequency trains in world space. They only
  // perturb the normal, so the drawn surface still equals `waveOffset()` and no
  // gameplay system can be misled by a drop that is invisible to physics.
  const rippleA = positionWorld.x.mul(2.35).add(positionWorld.z.mul(1.7)).sub(time.mul(6.4));
  const rippleB = positionWorld.x.mul(-1.85).add(positionWorld.z.mul(2.95)).add(time.mul(4.7));
  const rippleAmount = rain.mul(0.075).mul(activity);
  const slopeX = waveScale.mul(
    cos(phaseX).mul(W.a1 * W.k1x).add(cos(phaseY).mul(W.a2 * W.k2x)).add(cos(phaseZ).mul(W.a3 * W.k3x)),
  ).add(rippleAmount.mul(cos(rippleA).mul(2.35).add(cos(rippleB).mul(-1.85))));
  const slopeZ = waveScale.mul(
    cos(phaseX).mul(W.a1 * W.k1z).add(cos(phaseY).mul(W.a2 * W.k2z)).add(cos(phaseZ).mul(W.a3 * W.k3z)),
  ).add(rippleAmount.mul(cos(rippleA).mul(1.7).add(cos(rippleB).mul(2.95))));

  const material = new MeshStandardNodeMaterial({
    transparent: true,
    side: DoubleSide,
    depthWrite: detail > 0,
    roughness: detail > 0 ? 0.08 : 0.18,
    metalness: 0.04,
  });
  material.name = `Water surface / detail ${detail}`;

  const waveNormal = normalize(vec3(slopeX.mul(-NORMAL_GAIN), float(1), slopeZ.mul(-NORMAL_GAIN)));
  if (detail > 0) {
    // Vertical displacement only: the surface keeps its horizontal footprint, so
    // the physics query (a height field) stays exact.
    material.positionNode = vec3(positionLocal.x, positionLocal.y.add(height), positionLocal.z);
    material.normalNode = transformNormalToView(waveNormal);
  }

  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const facing = detail > 0
    ? saturate(dot(viewDirection, waveNormal))
    : saturate(dot(viewDirection, vec3(0, 1, 0)));
  // Schlick-style Fresnel: grazing angles turn the surface into a sky mirror.
  const fresnel = pow(float(1).sub(facing), float(4));
  const base = mix(shallow, deep, depthFactor);
  let color = mix(base, vec3(0.42, 0.55, 0.62), fresnel.mul(0.72));
  let opacity = detail === 0 ? float(0.82) : saturate(mix(float(0.42), float(0.96), depthFactor));

  if (detail > 1) {
    const half = normalize(sunDirection.add(viewDirection));
    const highlight = detail > 0
      ? saturate(dot(waveNormal, half))
      : saturate(dot(vec3(0, 1, 0), half));
    const glitter = pow(highlight, float(180)).mul(sunColor).mul(2.2);
    // Shoreline foam: the water column thins over the bed near the bank.
    const shore = float(1).sub(smoothstep(float(0.04), float(0.8), depth));
    const foamAmount = smoothstep(float(0.4), float(1), shore);
    color = color.add(glitter).add(foam.mul(foamAmount.mul(0.8)));
    opacity = saturate(opacity.add(foamAmount.mul(0.5)));
    material.roughnessNode = mix(float(0.06), float(0.6), foamAmount);
  }
  material.colorNode = color;
  material.opacityNode = opacity;

  return {
    material,
    setTime(seconds: number) { time.value = seconds; },
    setSun(direction: Vector3, color: Color, intensity: number) {
      sunDirection.value.copy(direction);
      sunColor.value.copy(color).multiplyScalar(Math.min(intensity, 4));
    },
    setWind(x: number, z: number) { wind.value.set(x, z); },
    /** Storm roughness; 0 stills the surface, 1 is calm, >1 is rough. */
    setActivity(value: number) { activity.value = Math.max(0, Math.min(1.6, value)); },
    /** Rain intensity 0..1, from the weather system. */
    setRain(value: number) { rain.value = Math.max(0, Math.min(1, value)); },
    dispose() { material.dispose(); },
  };
}

export type WaterMaterial = ReturnType<typeof createWaterMaterial>;

/** Three-wave phase triple for a canonical world position (CPU side). */
export function waterPhaseAt(x: number, z: number, target = new Vector3()): Vector3 {
  return target.set(
    x * W.k1x + z * W.k1z,
    x * W.k2x + z * W.k2z,
    x * W.k3x + z * W.k3z,
  );
}
