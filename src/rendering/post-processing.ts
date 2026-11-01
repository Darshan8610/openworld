import { RenderPipeline, WebGPURenderer, Scene, Camera, Node } from 'three/webgpu';
import { pass, uv, vec2, float, smoothstep, renderOutput, mix, builtinAOContext, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { QUALITY } from '../config';
import type { QualityName } from '../config';

interface Chain {
  pipeline: RenderPipeline;
  scenePass: ReturnType<typeof pass>;
  bloomPass: ReturnType<typeof bloom>;
  aoPass?: ReturnType<typeof ao>;
  denoisePass?: ReturnType<typeof denoise>;
}

/**
 * HDR scene pass -> optional GTAO (Ultra) -> threshold bloom -> filmic output
 * -> FXAA -> subtle vignette. Low bypasses the chain entirely. The chain is
 * rebuilt on preset changes so lower presets never pay for Ultra-only passes.
 */
export class PostProcessing {
  private chain?: Chain;
  private chainQuality?: QualityName;
  private enabled = true;
  private camera: Camera;

  constructor(private readonly renderer: WebGPURenderer, private readonly scene: Scene, camera: Camera, quality: QualityName) {
    this.camera = camera;
    this.setQuality(quality);
  }

  /**
   * The pass node owns its camera, so a view change (walk <-> survey) rebuilds the
   * chain for the new camera instead of rendering the world through the old one.
   */
  setCamera(camera: Camera): void {
    if (this.camera === camera) return;
    this.camera = camera;
    const quality = this.chainQuality;
    if (quality === undefined) return;
    this.disposeChain();
    if (quality !== 'low') this.chain = this.build(quality);
  }

  get activeCamera(): Camera { return this.camera; }

  private build(quality: QualityName): Chain {
    const preset = QUALITY[quality];
    const pipeline = new RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    let aoPass: ReturnType<typeof ao> | undefined;
    let denoisePass: ReturnType<typeof denoise> | undefined;
    if (preset.ambientOcclusion) {
      const depth = scenePass.getTextureNode('depth');
      aoPass = ao(depth, null as unknown as Node, this.camera);
      aoPass.radius.value = 4;
      aoPass.thickness.value = 8;
      aoPass.samples.value = 16;
      aoPass.resolutionScale = 0.5;
      denoisePass = denoise(aoPass.getTextureNode(), depth, null as unknown as Node, this.camera);
      denoisePass.radius.value = 4;
      // Modulate indirect lighting only; direct sun and painted markings stay crisp.
      scenePass.contextNode = builtinAOContext(mix(float(1), vec4(denoisePass as unknown as Node<'vec4'>).r, 0.72));
    }
    const bloomPass = bloom(color, quality === 'ultra' ? 0.26 : quality === 'high' ? 0.24 : 0.18, 0.55, quality === 'ultra' ? 0.8 : 0.85);
    const d = uv().sub(vec2(0.5)).length();
    const vignette = float(1).sub(smoothstep(0.58, 0.98, d).mul(quality === 'ultra' ? 0.22 : 0.26));
    const output = renderOutput(color.add(bloomPass).mul(vignette));
    pipeline.outputColorTransform = false;
    pipeline.outputNode = fxaa(output);
    return { pipeline, scenePass, bloomPass, aoPass, denoisePass };
  }

  setQuality(quality: QualityName): void {
    if (this.chainQuality !== quality) {
      this.disposeChain();
      this.chainQuality = quality;
      if (quality !== 'low') this.chain = this.build(quality);
    }
    this.enabled = quality !== 'low';
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled && this.chainQuality !== 'low'; }
  get isEnabled(): boolean { return this.enabled && !!this.chain; }

  render(scene: Scene, camera: Camera): void {
    if (this.enabled && this.chain) this.chain.pipeline.render();
    else this.renderer.render(scene, camera);
  }

  private disposeChain(): void {
    if (!this.chain) return;
    this.chain.scenePass.dispose();
    this.chain.bloomPass.dispose();
    this.chain.aoPass?.dispose();
    this.chain.denoisePass?.dispose();
    this.chain.pipeline.dispose();
    this.chain = undefined;
  }
  dispose(): void { this.disposeChain(); }
}
