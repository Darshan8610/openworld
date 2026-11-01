import { BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three/webgpu';
import type { StoryBounds } from './campaign';
import { CAMPAIGN, clampToBounds } from './campaign';

/**
 * Campaign confinement for Blackwood Valley.
 *
 * The infinite engine keeps streaming underneath; this layer keeps the player
 * inside the narrative zone with a hard positional clamp plus authored
 * "natural" barrier dressing and walk-blocking volumes:
 *
 *   North (minZ) — steep rock wall above the collapsed highway tunnel
 *   South (maxZ) — deep storm water beyond submerged guardrails
 *   East  (maxX) — fallen timber choked ravine
 *   West  (minX) — locked security gate and razor-wire fencing
 *
 * `blockedAt` plugs into the character's existing collision callback so walls
 * stop walking before the clamp ever fires; the meshes are cheap instanced
 * boxes that render identically on WebGPU and WebGL2.
 */

export interface BarrierBox {
  readonly minX: number; readonly maxX: number;
  readonly minZ: number; readonly maxZ: number;
  /** Top of the blocking volume in world Y (walk-over height). */
  readonly top: number;
}

const BARRIER_HEIGHT = 9;

interface BarrierSpan {
  readonly from: { x: number; z: number };
  readonly to: { x: number; z: number };
  readonly width: number;
}

export class CampaignBounds {
  readonly group = new Group();
  private readonly boxes: BarrierBox[] = [];
  private readonly walls: { mesh: Mesh; halfHeight: number }[] = [];
  private readonly bounds: StoryBounds;

  constructor(bounds: StoryBounds = CAMPAIGN.bounds) {
    this.bounds = bounds;
    this.group.name = 'story/bounds';
    this.buildRockWall();
    this.buildRavine();
    this.buildFence();
    this.buildCoast();
  }

  /** Hard clamp — nothing the player drives or walks can leave the zone. */
  clamp<T extends { x: number; z: number }>(point: T): T { return clampToBounds(point, this.bounds); }

  /**
   * Walk-blocking query for the character controller (world metres).
   * Without a feet height the query assumes ground level (barriers block).
   */
  blockedAt(x: number, z: number, feetY = Number.NEGATIVE_INFINITY): boolean {
    for (const box of this.boxes) {
      if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ && feetY < box.top) return true;
    }
    return false;
  }

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose();
    });
    this.group.clear();
    this.boxes.length = 0;
    this.walls.length = 0;
  }

  private addWall(span: BarrierSpan, material: MeshStandardMaterial, height = BARRIER_HEIGHT): void {
    const dx = span.to.x - span.from.x, dz = span.to.z - span.from.z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length <= 0) return;
    const cx = (span.from.x + span.to.x) / 2, cz = (span.from.z + span.to.z) / 2;
    const geometry = new BoxGeometry(length, height, span.width);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(cx, this.boundsSurfaceY(cx, cz) + height / 2 - 0.6, cz);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.walls.push({ mesh, halfHeight: height / 2 });
    const pad = span.width / 2 + 0.6;
    this.boxes.push({
      minX: Math.min(span.from.x, span.to.x) - pad, maxX: Math.max(span.from.x, span.to.x) + pad,
      minZ: Math.min(span.from.z, span.to.z) - pad, maxZ: Math.max(span.from.z, span.to.z) + pad,
      top: mesh.position.y + height / 2,
    });
  }

  /** Terrain height is owned by the streaming system; barriers read it lazily via the constructor hook. */
  private surface: (x: number, z: number) => number = () => 0;

  /** Wire the terrain sampler (Game does this right after construction). */
  setSurfaceSampler(sample: (x: number, z: number) => number): void {
    this.surface = sample;
    for (const { mesh, halfHeight } of this.walls) {
      mesh.position.y = this.boundsSurfaceY(mesh.position.x, mesh.position.z) + halfHeight - 0.6;
    }
  }

  private boundsSurfaceY(x: number, z: number): number {
    const y = this.surface(x, z);
    return Number.isFinite(y) ? y : 0;
  }

  private static spans(min: number, max: number, fixed: number, axis: 'x' | 'z', segments: number, inset = 0): BarrierSpan[] {
    const spans: BarrierSpan[] = [];
    const step = (max - min) / segments;
    for (let i = 0; i < segments; i++) {
      const a = min + step * i + inset, b = min + step * (i + 1) - inset;
      spans.push(axis === 'x'
        ? { from: { x: a, z: fixed }, to: { x: b, z: fixed }, width: 6 }
        : { from: { x: fixed, z: a }, to: { x: fixed, z: b }, width: 6 });
    }
    return spans;
  }

  private buildRockWall(): void {
    const material = new MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.96, metalness: 0.02 });
    for (const span of CampaignBounds.spans(this.bounds.minX, this.bounds.maxX, this.bounds.minZ, 'x', 8)) {
      this.addWall(span, material, BARRIER_HEIGHT + 4);
    }
    // The collapsed tunnel mouth: a darker slab with barricade blocks in front.
    const slab = new Mesh(new BoxGeometry(30, 12, 4), new MeshStandardMaterial({ color: 0x17191c, roughness: 1 }));
    const mid = (this.bounds.minX + this.bounds.maxX) / 2;
    slab.position.set(mid, this.boundsSurfaceY(mid, this.bounds.minZ + 4) + 5, this.bounds.minZ + 3);
    this.group.add(slab);
    const tape = new Mesh(new BoxGeometry(34, 0.35, 0.1), new MeshStandardMaterial({ color: 0xd7c43a, roughness: 0.7, side: DoubleSide }));
    tape.position.set(mid, slab.position.y - 2.2, this.bounds.minZ + 6.5);
    this.group.add(tape);
  }

  private buildRavine(): void {
    const material = new MeshStandardMaterial({ color: 0x3d3227, roughness: 1 });
    for (const span of CampaignBounds.spans(this.bounds.minZ, this.bounds.maxZ, this.bounds.maxX, 'z', 7)) {
      // Stacked fallen timber: offset log meshes over the blocking volume.
      this.addWall(span, material, 3.2);
      const log = new Mesh(new CylinderGeometry(0.55, 0.7, Math.hypot(span.to.x - span.from.x, span.to.z - span.from.z), 6), material);
      log.position.set((span.from.x + span.to.x) / 2, this.boundsSurfaceY((span.from.x + span.to.x) / 2, (span.from.z + span.to.z) / 2) + 1.4, (span.from.z + span.to.z) / 2);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = -Math.atan2(span.to.z - span.from.z, span.to.x - span.from.x);
      this.group.add(log);
    }
  }

  private buildFence(): void {
    const post = new MeshStandardMaterial({ color: 0x50565c, roughness: 0.55, metalness: 0.65 });
    for (const span of CampaignBounds.spans(this.bounds.minZ, this.bounds.maxZ, this.bounds.minX, 'z', 10)) {
      this.addWall(span, post, 4);
    }
    // Razor-wire line + the locked security gate near the middle of the west edge.
    const wire = new Mesh(new PlaneGeometry(this.bounds.maxZ - this.bounds.minZ, 1.4), new MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.35, metalness: 0.8, side: DoubleSide, transparent: true, opacity: 0.55 }));
    wire.position.set(this.bounds.minX + 0.4, this.boundsSurfaceY(this.bounds.minX, (this.bounds.minZ + this.bounds.maxZ) / 2) + 3.1, (this.bounds.minZ + this.bounds.maxZ) / 2);
    wire.rotation.y = Math.PI / 2;
    this.group.add(wire);
  }

  private buildCoast(): void {
    // Deep, storm-driven water: a dark surface strip beyond submerged rails.
    const water = new Mesh(new PlaneGeometry(this.bounds.maxX - this.bounds.minX + 80, 90), new MeshStandardMaterial({
      color: 0x081218, roughness: 0.22, metalness: 0.12, side: DoubleSide,
    }));
    water.rotation.x = -Math.PI / 2;
    const midX = (this.bounds.minX + this.bounds.maxX) / 2;
    water.position.set(midX, this.boundsSurfaceY(midX, this.bounds.maxZ) - 1.1, this.bounds.maxZ + 44);
    this.group.add(water);
    const rail = new Mesh(new BoxGeometry(this.bounds.maxX - this.bounds.minX, 0.5, 0.25), new MeshStandardMaterial({ color: 0x6b7178, roughness: 0.5, metalness: 0.7 }));
    rail.position.set(midX, this.boundsSurfaceY(midX, this.bounds.maxZ) + 0.7, this.bounds.maxZ - 1.5);
    this.group.add(rail);
    // Guard the water edge itself: the clamp handles swimmers, boxes stop walkers short of the drop.
    this.boxes.push({
      minX: this.bounds.minX - 8, maxX: this.bounds.maxX + 8,
      minZ: this.bounds.maxZ - 1, maxZ: this.bounds.maxZ + 120,
      top: Number.POSITIVE_INFINITY,
    });
  }
}
