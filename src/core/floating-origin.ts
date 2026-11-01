import { Vector3 } from 'three/webgpu';
import { CONFIG } from '../config';

/**
 * Simulation addresses stay in JS doubles. GPU addresses never exceed the view radius.
 * Rebasing is a translation of EVERY render object, including camera and light rig.
 */
export class FloatingOrigin {
  readonly absolute = new Vector3();
  private readonly listeners = new Set<(delta: Vector3) => void>();
  shifts = 0;

  get x(): number { return this.absolute.x; }
  get z(): number { return this.absolute.z; }

  onChange(listener: (delta: Vector3) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toLocal(world: Vector3, target = new Vector3()): Vector3 { return target.copy(world).sub(this.absolute); }

  update(world: Vector3): void {
    const threshold = CONFIG.origin.rebaseDistance;
    if (Math.max(Math.abs(world.x), Math.abs(world.y), Math.abs(world.z)) < threshold) return;
    const next = new Vector3(
      Math.round(world.x / threshold) * threshold,
      Math.round(world.y / threshold) * threshold,
      Math.round(world.z / threshold) * threshold,
    );
    const delta = next.clone().sub(this.absolute);
    this.absolute.copy(next);
    this.shifts++;
    for (const listener of this.listeners) listener(delta);
  }

  reset(): void {
    const delta = this.absolute.clone().negate();
    this.absolute.set(0, 0, 0);
    this.shifts = 0;
    for (const listener of this.listeners) listener(delta);
  }
}
