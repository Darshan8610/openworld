import { PerspectiveCamera, Vector3, Euler } from 'three/webgpu';
import { CONFIG } from '../config';
import { Input } from './input';
import type { FloatingOrigin } from './floating-origin';
import type { TerrainManager } from '../world/terrain-manager';
import { clamp, damp } from '../utils/math';

/** Phase-1 free-flight survey rig, deliberately NOT a placeholder vehicle controller. */
export class SurveyCamera {
  readonly camera = new PerspectiveCamera(CONFIG.camera.fov, innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  readonly position = new Vector3(0, 450, 0);
  readonly previous = new Vector3(0, 450, 0);
  readonly velocity = new Vector3();
  yaw = -0.58;
  pitch = -0.12;
  touring = true;
  speed: number = CONFIG.camera.speed;
  private tourTime = 0;
  private spawned = false;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly interpolated = new Vector3();
  private readonly direction = new Vector3();

  constructor(private readonly input: Input, private readonly origin: FloatingOrigin, private readonly terrain: TerrainManager) {
    this.input.onActivity = () => { this.touring = false; };
  }

  spawn(): void {
    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    if (ground === undefined) return;
    this.position.y = ground + 210;
    this.previous.copy(this.position);
    this.origin.update(this.position);
    this.spawned = true;
  }

  fixedUpdate(dt: number): void {
    this.previous.copy(this.position);
    if (!this.spawned) { this.spawn(); return; }
    const look = this.input.consumeLook();
    this.yaw -= look.x * 0.0025;
    this.pitch = clamp(this.pitch - look.y * 0.0025, -1.42, 1.42);
    if (this.input.wheel) { this.speed = clamp(this.speed * 0.85 ** this.input.wheel, 20, 600); this.input.wheel = 0; }
    let forward = Number(this.input.down('KeyW', 'ArrowUp')) - Number(this.input.down('KeyS', 'ArrowDown'));
    let strafe = Number(this.input.down('KeyD')) - Number(this.input.down('KeyA'));
    const vertical = Number(this.input.down('KeyE')) - Number(this.input.down('KeyQ'));
    if (this.input.down('ArrowLeft')) this.yaw += dt * 0.8;
    if (this.input.down('ArrowRight')) this.yaw -= dt * 0.8;
    if (this.touring) {
      this.tourTime += dt;
      forward = 0.28;
      this.yaw += Math.sin(this.tourTime * 0.026) * dt * 0.016;
      this.pitch = damp(this.pitch, -0.09, 0.5, dt);
    }
    const boost = this.input.down('ShiftLeft', 'ShiftRight') ? CONFIG.camera.boost : 1;
    const speed = this.speed * boost;
    this.direction.set(-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * strafe, vertical, -Math.cos(this.yaw) * forward - Math.sin(this.yaw) * strafe);
    if (this.direction.lengthSq() > 1) this.direction.normalize();
    this.direction.multiplyScalar(speed);
    this.velocity.lerp(this.direction, 1 - Math.exp(-dt * 4));
    this.position.addScaledVector(this.velocity, dt);
    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    if (ground !== undefined) {
      const floor = ground + CONFIG.camera.clearance;
      if (this.position.y < floor) { this.position.y = floor; this.velocity.y = Math.max(0, this.velocity.y); }
      if (this.touring) this.position.y = damp(this.position.y, ground + 210, 0.45, dt);
    }
    this.origin.update(this.position);
  }

  render(alpha: number): void {
    this.interpolated.lerpVectors(this.previous, this.position, alpha);
    this.origin.toLocal(this.interpolated, this.camera.position);
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    const targetFov = CONFIG.camera.fov + clamp(this.velocity.length() / 600, 0, 1) * 7;
    this.camera.fov = damp(this.camera.fov, targetFov, 3, 1 / 60);
    this.camera.updateProjectionMatrix();
  }

  reset(): void {
    this.position.set(0, 450, 0); this.velocity.set(0, 0, 0);
    this.yaw = -0.58; this.pitch = -0.12; this.tourTime = 0;
    this.spawned = false; this.touring = true;
    this.previous.copy(this.position);
  }
  resize(): void { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }
  get heading(): number { return ((-this.yaw * 180 / Math.PI) % 360 + 360) % 360; }
}
