import { WebGPURenderer, AgXToneMapping, PCFShadowMap, Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshBasicNodeMaterial } from 'three/webgpu';
import { QUALITY } from '../config';
import type { QualityName } from '../config';

export type BackendName = 'WebGPU' | 'WebGL2';
export interface RenderingContext {
  renderer: WebGPURenderer;
  canvas: HTMLCanvasElement;
  backend: BackendName;
  fallbackReason?: string;
}

/** Keep pixels bounded on 4K/retina displays. Adaptive quality is Phase 9. */
export function resizeRenderer(context: RenderingContext, quality: QualityName): void {
  const { renderer } = context;
  const maxPixels = quality === 'low' ? 1_500_000 : quality === 'high' ? 4_000_000 : 2_600_000;
  const width = window.innerWidth, height = window.innerHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, QUALITY[quality].pixelRatio, Math.sqrt(maxPixels / (width * height)));
  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height);
}

/**
 * WebGPURenderer also implements the WebGL2 fallback. A fresh canvas is essential
 * if initialization fails: a canvas cannot switch from a webgpu to a webgl context.
 */
export async function createRenderer(host: HTMLElement, quality: QualityName, forceWebGL = false): Promise<RenderingContext> {
  const errors: string[] = [];
  const secure = window.isSecureContext;
  for (const force of forceWebGL || !secure || !navigator.gpu ? [true] : [false, true]) {
    const canvas = document.createElement('canvas');
    canvas.className = 'world-canvas';
    canvas.setAttribute('aria-label', 'Interactive 3D alpine world. Drag to look; WASD to fly.');
    canvas.tabIndex = 0;
    const renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', forceWebGL: force });
    try {
      await renderer.init();
      // Some drivers expose WebGPU but fail on the first real buffer allocation.
      // Probe a tiny PBR-free draw before committing the world to this backend.
      const probeScene = new Scene();
      const probeCamera = new PerspectiveCamera(50, 1, 0.1, 10);
      probeCamera.position.z = 3;
      const probeGeometry = new BoxGeometry(1, 1, 1);
      const probeMaterial = new MeshBasicNodeMaterial({ color: 0xffffff });
      probeScene.add(new Mesh(probeGeometry, probeMaterial));
      try {
        renderer.render(probeScene, probeCamera);
      } finally {
        probeGeometry.dispose(); probeMaterial.dispose();
      }
      host.prepend(canvas);
      renderer.info.autoReset = false;
      renderer.toneMapping = AgXToneMapping;
      renderer.toneMappingExposure = 0.82;
      renderer.shadowMap.enabled = QUALITY[quality].shadows;
      renderer.shadowMap.type = PCFShadowMap;
      const isGPU = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
      const context: RenderingContext = { renderer, canvas, backend: isGPU ? 'WebGPU' : 'WebGL2', fallbackReason: errors.join('; ') || (!secure ? 'WebGPU requires HTTPS or localhost' : undefined) };
      resizeRenderer(context, quality);
      return context;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      renderer.dispose();
      canvas.remove();
    }
  }
  throw new Error(`Unable to initialize a 3D renderer. Enable hardware acceleration and use a current browser. ${errors.join('; ')}`);
}
