import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Points, PointsNodeMaterial, Vector3,
  DynamicDrawUsage,
} from 'three/webgpu';
import { CONFIG } from '../config';
import type { FloatingOrigin } from '../core/floating-origin';
import { clamp } from '../utils/math';

/**
 * One bounded particle system for every environmental effect.
 *
 * Rain, snow, splashes, spray, dust and impact debris are *emitters* feeding one
 * pre-allocated pool — there is no per-effect subsystem and no allocation during
 * play. The pool is a fixed array; when it is full the oldest, least important
 * particle is recycled, so the budget can never be exceeded.
 *
 * Rendering: point sprites in two layers (a fine layer for rain/dust/spray and a
 * coarse layer for snow/splash droplets). Both are single draw calls. Per-particle
 * size variation is approximated by layer and by alpha, which keeps the material
 * a portable `PointsNodeMaterial` that compiles on WebGPU and WebGL2 alike.
 *
 * Simulation is CPU-side because these particles need gameplay collisions
 * (ground height, water surface) and wind, which a GPU-only path cannot provide
 * without readback. Everything that does not need collision handling is budgeted
 * by distance: particles far from the camera are recycled first.
 */

export type ParticleLayer = 'fine' | 'coarse';
export type ParticleKind = 'rain' | 'snow' | 'splash' | 'spray' | 'dust' | 'debris';

interface LayerBuffers {
  points: Points<BufferGeometry, PointsNodeMaterial>;
  positions: Float32Array;
  colors: Float32Array;
  geometry: BufferGeometry;
  attribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  capacity: number;
  count: number;
  size: number;
}

interface Particle {
  /** Index in the pool, so release() is O(1). */
  index: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  gravity: number;
  drag: number;
  /** 0 = ignore ground, 1 = die on the ground, 2 = splash on water/ground. */
  collide: 0 | 1 | 2;
  layer: ParticleLayer;
  alpha: number;
  alpha0: number;
  r: number; g: number; b: number;
  active: boolean;
  kind: ParticleKind;
}

export interface ParticleStats {
  active: number;
  capacity: number;
  rain: number;
  snow: number;
  splashes: number;
  dropped: number;
  drawCalls: number;
}

export interface SplashOptions {
  strength?: number;
  spray?: boolean;
  color?: Color;
}

export interface PrecipitationOptions {
  rain: number;
  snow: number;
  windX: number;
  windZ: number;
  /** Camera/canonical eye position: the box follows the player. */
  x: number;
  y: number;
  z: number;
}

const FINE_LAYER_SIZE = 0.16;
const COARSE_LAYER_SIZE = 0.34;

export class ParticleSystem {
  readonly group = new Group();
  private readonly pool: Particle[] = [];
  /**
   * Free indices per layer. Allocation is O(1); a scan only happens when a layer
   * is genuinely saturated, and then only over a bounded window.
   */
  private readonly freeFine: number[] = [];
  private readonly freeCoarse: number[] = [];
  private readonly recycleCursor = { fine: 0, coarse: 0 };
  private readonly fine: LayerBuffers;
  private readonly coarse: LayerBuffers;
  private readonly origin: FloatingOrigin;
  private readonly rainColor = new Color(0.62, 0.72, 0.82);
  private readonly snowColor = new Color(0.94, 0.96, 1);
  private readonly gravity = 9.81;
  private accumulator = 0;
  private rainTarget = 0;
  private snowTarget = 0;
  private rainActive = 0;
  private snowActive = 0;
  private dropped = 0;
  private disposed = false;
  /** Ground and water probes supplied by the world (canonical coordinates). */
  private groundAt: (x: number, z: number) => number = () => 0;
  private waterAt: (x: number, z: number) => number | undefined = () => undefined;

  constructor(origin: FloatingOrigin, capacity: number) {
    this.origin = origin;
    const fineCapacity = Math.max(64, Math.round(capacity * 0.72));
    const coarseCapacity = Math.max(32, capacity - fineCapacity);
    this.fine = this.createLayer(fineCapacity, FINE_LAYER_SIZE);
    this.coarse = this.createLayer(coarseCapacity, COARSE_LAYER_SIZE);
    this.group.name = 'Phase 9 / particles';
    this.group.add(this.fine.points, this.coarse.points);
    this.group.frustumCulled = false;
    for (let i = 0; i < fineCapacity + coarseCapacity; i++) {
      this.pool.push(blankParticle(i));
      if (i < fineCapacity) this.freeFine.push(i);
      else this.freeCoarse.push(i);
    }
  }

  private createLayer(capacity: number, size: number): LayerBuffers {
    const positions = new Float32Array(capacity * 3);
    const colors = new Float32Array(capacity * 4);
    const geometry = new BufferGeometry();
    const attribute = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
    const colorAttribute = new BufferAttribute(colors, 4).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setDrawRange(0, 0);
    // Keep the geometry alive when everything is hidden: one allocation, reused.
    const material = new PointsNodeMaterial({
      size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: true,
    });
    material.name = `Particles / ${size < 0.2 ? 'fine' : 'coarse'}`;
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 10;
    return { points, positions, colors, geometry, attribute, colorAttribute, capacity, count: 0, size };
  }

  /** Wire the world probes used for particle collisions. */
  setColliders(ground: (x: number, z: number) => number, water: (x: number, z: number) => number | undefined): void {
    this.groundAt = ground;
    this.waterAt = water;
  }

  get stats(): ParticleStats {
    let active = 0, rain = 0, snow = 0, splashes = 0;
    for (const particle of this.pool) {
      if (!particle.active) continue;
      active++;
      if (particle.kind === 'rain') rain++;
      else if (particle.kind === 'snow') snow++;
      else if (particle.kind === 'splash' || particle.kind === 'spray') splashes++;
    }
    return {
      active, capacity: this.pool.length, rain, snow, splashes, dropped: this.dropped,
      drawCalls: 2,
    };
  }

  /** Precipitation intensities from the weather system (0..1 each). */
  setPrecipitation(rain: number, snow: number): void {
    this.rainTarget = clamp(rain, 0, 1);
    this.snowTarget = clamp(snow, 0, 1);
  }

  /**
   * Burst of droplets. Used for water entry/exit, footstep splashes, boat wakes
   * and impacts; the count scales with strength and the remaining budget.
   */
  splash(x: number, y: number, z: number, options: SplashOptions = {}): void {
    const strength = clamp(options.strength ?? 1, 0.15, 4);
    const count = Math.round(6 + strength * 10);
    const color = options.color ?? new Color(0.82, 0.9, 0.95);
    for (let i = 0; i < count; i++) {
      const particle = this.allocate('fine');
      if (!particle) return;
      const angle = Math.random() * Math.PI * 2;
      const spread = 0.6 + Math.random() * 2.4 * strength;
      particle.x = x + Math.cos(angle) * 0.25;
      particle.z = z + Math.sin(angle) * 0.25;
      particle.y = y + 0.05;
      particle.vx = Math.cos(angle) * spread;
      particle.vz = Math.sin(angle) * spread;
      particle.vy = 1.4 + Math.random() * 3.2 * strength;
      particle.maxLife = 0.5 + Math.random() * 0.9;
      particle.life = particle.maxLife;
      particle.gravity = 0.9;
      particle.drag = 1.6;
      particle.collide = 1;
      particle.layer = 'fine';
      particle.kind = options.spray ? 'spray' : 'splash';
      particle.alpha0 = options.spray ? 0.35 : 0.7;
      particle.alpha = particle.alpha0;
      particle.r = color.r; particle.g = color.g; particle.b = color.b;
      particle.active = true;
    }
  }

  /**
   * Advance the simulation. Runs at a fixed presentation rate, not per render
   * frame, and never lets a long frame spawn unbounded precipitation.
   */
  update(dt: number, view: Vector3, windX: number, windZ: number): void {
    if (this.disposed) return;
    this.accumulator = Math.min(this.accumulator + dt, 0.1);
    const step = 1 / 60;
    while (this.accumulator >= step) {
      this.simulate(step, view, windX, windZ);
      this.accumulator -= step;
    }
    this.upload();
  }

  private simulate(dt: number, view: Vector3, windX: number, windZ: number): void {
    this.spawnPrecipitation(dt, view, windX, windZ);
    for (const particle of this.pool) {
      if (!particle.active) continue;
      particle.life -= dt;
      if (particle.life <= 0) { this.release(particle); continue; }
      particle.vy -= this.gravity * particle.gravity * dt;
      // Rain and snow are pushed by the wind; splashes are only nudged.
      const windScale = particle.kind === 'rain' ? 0.42 : particle.kind === 'snow' ? 0.62 : 0.05;
      particle.vx += (windX * windScale - particle.vx * particle.drag * 0.12) * dt;
      particle.vz += (windZ * windScale - particle.vz * particle.drag * 0.12) * dt;
      particle.vx *= 1 - clamp(particle.drag * 0.18 * dt, 0, 0.5);
      particle.vz *= 1 - clamp(particle.drag * 0.18 * dt, 0, 0.5);
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;

      if (particle.collide === 1) {
        const ground = this.groundAt(particle.x, particle.z);
        const water = this.waterAt(particle.x, particle.z);
        const floor = water !== undefined && water > ground ? water : ground;
        if (particle.y <= floor) { this.release(particle); continue; }
      }
      // Precipitation lives in a box around the camera; recycle what leaves it.
      if (particle.kind === 'rain' || particle.kind === 'snow') {
        const box = CONFIG.particles.precipitationBox;
        if (Math.abs(particle.x - view.x) > box || Math.abs(particle.z - view.z) > box) {
          this.release(particle);
        } else if (particle.y < view.y - CONFIG.particles.precipitationHeight * 0.6) {
          this.release(particle);
        }
      }
      // Fade out over the last 30 % of a short lifetime (splashes, debris).
      const fade = clamp(particle.life / Math.max(0.001, particle.maxLife * 0.3), 0, 1);
      particle.alpha = particle.alpha0 * (0.3 + 0.7 * fade);
    }
    this.rainActive = this.countKind('rain');
    this.snowActive = this.countKind('snow');
  }

  private countKind(kind: ParticleKind): number {
    let count = 0;
    for (const particle of this.pool) if (particle.active && particle.kind === kind) count++;
    return count;
  }

  private spawnPrecipitation(dt: number, view: Vector3, windX: number, windZ: number): void {
    const box = CONFIG.particles.precipitationBox;
    const height = CONFIG.particles.precipitationHeight;
    // Rain: dense, fast, thin streaks. Wanted counts are clamped to the layer
    // capacity so a downpour thins out instead of thrashing the recycler.
    const rainWanted = Math.min(this.fine.capacity * 0.9, Math.round(this.rainTarget * 900));
    const rainRate = 620 * this.rainTarget;
    if (rainWanted > this.rainActive) {
      const spawn = Math.min(rainRate * dt, rainWanted - this.rainActive);
      const whole = Math.floor(spawn) + (Math.random() < spawn % 1 ? 1 : 0);
      for (let i = 0; i < whole; i++) {
        const particle = this.allocate('fine');
        if (!particle) return;
        particle.x = view.x + (Math.random() * 2 - 1) * box;
        particle.z = view.z + (Math.random() * 2 - 1) * box;
        particle.y = view.y + height * (0.55 + Math.random() * 0.45);
        particle.vx = windX * 0.35;
        particle.vz = windZ * 0.35;
        particle.vy = -14 - Math.random() * 6;
        particle.maxLife = 2.4;
        particle.life = particle.maxLife;
        particle.gravity = 0.35;
        particle.drag = 0.35;
        particle.collide = 1;
        particle.layer = 'fine';
        particle.kind = 'rain';
        particle.alpha0 = 0.34 + Math.random() * 0.2;
        particle.alpha = particle.alpha0;
        particle.r = this.rainColor.r; particle.g = this.rainColor.g; particle.b = this.rainColor.b;
        particle.active = true;
      }
    }
    // Snow: sparse, slow, drifting. 700 particles at intensity 1.
    const snowWanted = Math.min(this.coarse.capacity * 0.9, Math.round(this.snowTarget * 700));
    const snowRate = 320 * this.snowTarget;
    if (snowWanted > this.snowActive) {
      const spawn = Math.min(snowRate * dt, snowWanted - this.snowActive);
      const whole = Math.floor(spawn) + (Math.random() < spawn % 1 ? 1 : 0);
      for (let i = 0; i < whole; i++) {
        const particle = this.allocate('coarse');
        if (!particle) return;
        particle.x = view.x + (Math.random() * 2 - 1) * box;
        particle.z = view.z + (Math.random() * 2 - 1) * box;
        particle.y = view.y + height * (0.4 + Math.random() * 0.6);
        particle.vx = windX * 0.4 + (Math.random() - 0.5) * 0.6;
        particle.vz = windZ * 0.4 + (Math.random() - 0.5) * 0.6;
        particle.vy = -1.1 - Math.random() * 0.9;
        particle.maxLife = 9;
        particle.life = particle.maxLife;
        particle.gravity = 0.035;
        particle.drag = 1.4;
        particle.collide = 1;
        particle.layer = 'coarse';
        particle.kind = 'snow';
        particle.alpha0 = 0.5 + Math.random() * 0.4;
        particle.alpha = particle.alpha0;
        particle.r = this.snowColor.r; particle.g = this.snowColor.g; particle.b = this.snowColor.b;
        particle.active = true;
      }
    }
  }

  /**
   * Claim a slot in a layer. O(1) from the free list; if the layer is saturated,
   * the oldest particle within a bounded window is recycled, so the hard budget
   * is respected without a pool-wide scan per spawn.
   */
  private allocate(layer: ParticleLayer): Particle | undefined {
    const free = layer === 'fine' ? this.freeFine : this.freeCoarse;
    const index = free.pop();
    if (index !== undefined) {
      const particle = this.pool[index];
      if (particle) { particle.active = false; particle.layer = layer; return particle; }
    }
    const buffers = layer === 'fine' ? this.fine : this.coarse;
    const window = 32;
    let victim: Particle | undefined;
    for (let attempt = 0; attempt < window; attempt++) {
      this.recycleCursor[layer] = (this.recycleCursor[layer] + 1) % this.pool.length;
      const candidate = this.pool[this.recycleCursor[layer]!];
      if (!candidate || candidate.layer !== layer) continue;
      if (!victim || candidate.life < victim.life) victim = candidate;
    }
    if (victim && buffers.capacity > 0) {
      this.dropped++;
      return victim;
    }
    return undefined;
  }

  /** Return a finished particle to its layer's free list. */
  private release(particle: Particle): void {
    if (!particle.active) return;
    particle.active = false;
    const free = particle.layer === 'fine' ? this.freeFine : this.freeCoarse;
    free.push(particle.index);
  }

  /** Push the pool into the two point clouds, relative to the floating origin. */
  private upload(): void {
    const originX = this.origin.absolute.x;
    const originY = this.origin.absolute.y;
    const originZ = this.origin.absolute.z;
    let fineCount = 0, coarseCount = 0;
    for (const particle of this.pool) {
      if (!particle.active) continue;
      const buffers = particle.layer === 'fine' ? this.fine : this.coarse;
      const index = particle.layer === 'fine' ? fineCount++ : coarseCount++;
      if (index >= buffers.capacity) continue;
      buffers.positions[index * 3] = particle.x - originX;
      buffers.positions[index * 3 + 1] = particle.y - originY;
      buffers.positions[index * 3 + 2] = particle.z - originZ;
      buffers.colors[index * 4] = particle.r;
      buffers.colors[index * 4 + 1] = particle.g;
      buffers.colors[index * 4 + 2] = particle.b;
      buffers.colors[index * 4 + 3] = particle.alpha;
    }
    for (const buffers of [this.fine, this.coarse]) {
      const count = buffers === this.fine ? fineCount : coarseCount;
      buffers.count = Math.min(count, buffers.capacity);
      buffers.attribute.needsUpdate = true;
      buffers.colorAttribute.needsUpdate = true;
      buffers.geometry.setDrawRange(0, buffers.count);
    }
  }

  setVisible(visible: boolean): void { this.group.visible = visible; }

  /** Positions are stored canonically; every upload converts to origin-local. */
  rebase(): void { /* no state to move: see upload() */ }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffers of [this.fine, this.coarse]) {
      buffers.geometry.dispose();
      buffers.points.material.dispose();
    }
    this.group.removeFromParent();
  }
}

function blankParticle(index = 0): Particle {
  return {
    index,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1,
    gravity: 1, drag: 0, collide: 0, layer: 'fine', alpha: 0, alpha0: 0,
    r: 1, g: 1, b: 1, active: false, kind: 'rain',
  };
}
