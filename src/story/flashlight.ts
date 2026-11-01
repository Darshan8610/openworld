import { Object3D, SpotLight } from 'three/webgpu';

/**
 * Jack's flashlight — the spec's third primary light source (with headlights
 * and interior lamps). A focused warm cone with no shadow cost, toggled with
 * `Y`, dead while a cinematic runs or while driving. The Act II patrol reads
 * the beam: light carries in the dark, so hunting with it on widens its
 * detection envelope.
 */

export interface FlashlightPlayer {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly onFoot: boolean;
  readonly crouched: boolean;
}

export class StoryFlashlight {
  private readonly light: SpotLight;
  private readonly target = new Object3D();
  enabled = false;

  constructor(
    private readonly scene: { add(object: Object3D): void; remove(object: Object3D): void },
    private readonly ground: (x: number, z: number) => number,
  ) {
    // Family-matched to the building practicals (PointLight 32/18/2) but
    // tighter and brighter — a cone, not a room glow.
    this.light = new SpotLight(0xffe6b8, 0, 78, 0.44, 0.52, 2);
    this.light.castShadow = false;
    this.light.visible = false;
    this.scene.add(this.light);
    this.scene.add(this.target);
    this.light.target = this.target;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  update(player: FlashlightPlayer): void {
    if (!player.onFoot || !this.enabled) {
      this.light.visible = false;
      return;
    }
    this.light.visible = true;
    this.light.intensity = 55;
    const headY = this.ground(player.x, player.z) + (player.crouched ? 1.02 : 1.58);
    this.light.position.set(player.x, headY, player.z);
    this.target.position.set(
      player.x + Math.sin(player.yaw) * 14,
      headY - 1.1,
      player.z + Math.cos(player.yaw) * 14,
    );
  }

  dispose(): void {
    this.scene.remove(this.light);
    this.scene.remove(this.target);
    this.light.dispose();
  }
}
