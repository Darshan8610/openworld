import { RenderPipeline, WebGPURenderer, Scene, Camera } from 'three/webgpu';
import { pass, uv, vec2, float, smoothstep, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { QualityName } from '../config';

/**
 * Lightweight cinematic chain: HDR scene pass -> threshold bloom -> filmic
 * output transform -> FXAA -> subtle vignette. Low preset bypasses the chain so
 * software / mobile GPUs keep the direct MSAA path.
 */
export class PostProcessing {
  private readonly pipeline: RenderPipeline;
  private readonly scenePass: ReturnType<typeof pass>;
  private readonly bloomPass: ReturnType<typeof bloom>;
  private enabled = true;

  constructor(private readonly renderer: WebGPURenderer, scene: Scene, camera: Camera, quality: QualityName) {
    this.pipeline = new RenderPipeline(renderer);
    this.scenePass = pass(scene, camera);
    const color = this.scenePass.getTextureNode('output');
    this.bloomPass = bloom(color, 0.22, 0.55, 0.82);
    const bloomed = color.add(this.bloomPass);
    // Gentle lens vignette; keeps the eye on the horizon without darkening HUD.
    const d = uv().sub(vec2(0.5)).length();
    const vignette = float(1).sub(smoothstep(0.55, 0.95, d).mul(0.28));
    const graded = bloomed.mul(vignette);
    const output = renderOutput(graded);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = fxaa(output);
    this.setQuality(quality);
  }

  setQuality(quality: QualityName): void {
    this.enabled = quality !== 'low';
    const strength = quality === 'high' ? 0.3 : 0.2;
    this.bloomPass.strength.value = strength;
    this.bloomPass.threshold.value = quality === 'high' ? 0.78 : 0.85;
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  get isEnabled(): boolean { return this.enabled; }

  render(scene: Scene, camera: Camera): void {
    if (this.enabled) this.pipeline.render();
    else this.renderer.render(scene, camera);
  }

  dispose(): void {
    this.scenePass.dispose();
    this.bloomPass.dispose();
    this.pipeline.dispose();
  }
}
