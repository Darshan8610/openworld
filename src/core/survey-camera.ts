import { PerspectiveCamera, Vector3, Euler } from 'three/webgpu';
import { CONFIG } from '../config';
import { Input } from './input';
import type { FloatingOrigin } from './floating-origin';
import type { TerrainManager } from '../world/terrain-manager';
import type { RoadManager } from '../world/road-manager';
import { createRoadSample } from '../world/road-network';
import { clamp, damp } from '../utils/math';

/** Phase-1 free-flight survey rig, deliberately NOT a placeholder vehicle controller. */
export class SurveyCamera {
  readonly camera = new PerspectiveCamera(CONFIG.camera.fov, innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  readonly position = new Vector3(0, 450, 0);
  readonly previous = new Vector3(0, 450, 0);
  readonly velocity = new Vector3();
  readonly home = new Vector3(0, 450, 0);
  yaw = -0.58;
  pitch = -0.16;
  touring = true;
  /** Phase 3 camera-only route survey; deliberately not a vehicle controller. */
  routeFollowing = false;
  routeCorridor = 0;
  routeStation = 0;
  routeSpeed: number = CONFIG.camera.routeSpeed;
  speed: number = CONFIG.camera.speed;
  private tourTime = 0;
  spawned = false;
  /** Temporary Phase 7 inspection bridge; the Phase 5 human controller remains separate. */
  inspecting = false;
  private inspectionMotion?: (from: Vector3, desired: Vector3) => void;
  private surveySpeed: number = CONFIG.camera.speed;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly interpolated = new Vector3();
  private readonly direction = new Vector3();
  private readonly roadSample = createRoadSample();

  constructor(private readonly input: Input, private readonly origin: FloatingOrigin, private readonly terrain: TerrainManager, private readonly roads: RoadManager) {
    this.input.onActivity = () => { this.touring = false; this.routeFollowing = false; };
  }

  spawn(): void {
    if (this.inspecting) { this.spawned = true; return; }
    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    if (ground === undefined) return;
    this.position.y = ground + (this.routeFollowing ? CONFIG.camera.routeHeight : 55);
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
    if (this.input.wheel) {
      if (this.routeFollowing) this.routeSpeed = clamp(this.routeSpeed * 0.85 ** this.input.wheel, 6, 60);
      else this.speed = clamp(this.speed * 0.85 ** this.input.wheel, this.inspecting ? 1 : 20, this.inspecting ? 12 : 600);
      this.input.wheel = 0;
    }
    if (this.routeFollowing) {
      this.routeStation += this.routeSpeed * dt;
      const point = this.roads.point(this.routeCorridor, this.routeStation);
      this.roads.network.at(this.routeCorridor, this.routeStation, point.z, this.roadSample);
      this.position.x = point.x; this.position.z = point.z;
      const ground = this.terrain.heightAt(point.x, point.z);
      if (ground !== undefined) this.position.y = damp(this.position.y, ground + CONFIG.camera.routeHeight, 2.5, dt);
      this.yaw = Math.atan2(-this.roadSample.tangentX, -this.roadSample.tangentZ);
      this.pitch = damp(this.pitch, -0.055, 1.5, dt);
      this.velocity.set(this.roadSample.tangentX * this.routeSpeed, 0, this.roadSample.tangentZ * this.routeSpeed);
      this.origin.update(this.position);
      return;
    }
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
    const boost = this.input.down('ShiftLeft', 'ShiftRight') ? this.inspecting ? 2 : CONFIG.camera.boost : 1;
    const speed = this.speed * boost;
    this.direction.set(-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * strafe, vertical, -Math.cos(this.yaw) * forward - Math.sin(this.yaw) * strafe);
    if (this.direction.lengthSq() > 1) this.direction.normalize();
    this.direction.multiplyScalar(speed);
    this.velocity.lerp(this.direction, 1 - Math.exp(-dt * 4));
    this.position.addScaledVector(this.velocity, dt);
    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    if (ground !== undefined && !this.inspecting) {
      const floor = ground + CONFIG.camera.clearance;
      if (this.position.y < floor) { this.position.y = floor; this.velocity.y = Math.max(0, this.velocity.y); }
      if (this.touring) this.position.y = damp(this.position.y, ground + 45, 0.45, dt);
    }
    this.inspectionMotion?.(this.previous, this.position);
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

  beginInspection(position: Vector3, yaw: number, constrain: (from: Vector3, desired: Vector3) => void): void {
    if (!this.inspecting) this.surveySpeed = this.speed;
    this.inspecting = true; this.inspectionMotion = constrain;
    this.position.copy(position); this.previous.copy(position); this.velocity.set(0, 0, 0);
    this.speed = 3.5; this.yaw = yaw; this.pitch = -0.04;
    this.routeFollowing = false; this.touring = false; this.spawned = true;
    this.camera.near = 0.08; this.camera.updateProjectionMatrix();
    this.origin.update(this.position);
  }
  endInspection(): void {
    if (!this.inspecting) return;
    this.inspecting = false; this.inspectionMotion = undefined; this.speed = this.surveySpeed;
    this.camera.near = CONFIG.camera.near; this.camera.updateProjectionMatrix();
    this.velocity.set(0, 0, 0); this.spawned = false;
  }
  startRoute(corridor: number, station: number): void {
    this.endInspection();
    this.routeFollowing = true; this.touring = false;
    this.routeCorridor = corridor; this.routeStation = station;
    const point = this.roads.point(corridor, station);
    this.position.x = point.x; this.position.z = point.z;
    this.previous.copy(this.position); this.velocity.set(0, 0, 0);
    this.spawned = false;
  }
  reset(): void {
    this.endInspection();
    this.routeFollowing = false;
    this.position.copy(this.home); this.velocity.set(0, 0, 0);
    this.yaw = -0.58; this.pitch = -0.16; this.tourTime = 0;
    this.spawned = false; this.touring = true;
    this.previous.copy(this.position);
  }
  resize(): void { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }
  get heading(): number { return ((-this.yaw * 180 / Math.PI) % 360 + 360) % 360; }
}
