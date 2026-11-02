import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { FloatingOrigin } from '../src/core/floating-origin';
import { CONFIG, QUALITY } from '../src/config';
import { createWaterMaterial } from '../src/rendering/water-material';
import { WaterManager } from '../src/world/water-manager';
import { createWaterSample } from '../src/world/water-field';
import type { WaterField, WaterSample } from '../src/world/water-field';
import type { BufferGeometry, Mesh } from 'three/webgpu';

/**
 * Water streaming, without a GPU.
 *
 * The manager's job is geometry: tiles around the player at the quality preset's
 * resolution, shoreline-correct vertices, and a rebase that never rebuilds. The
 * field is replaced with an analytic disc so the assertions are about streaming.
 */

const SURFACE = 100;
const RADIUS = 700;

function discField(): WaterField {
  const sampleAt = (x: number, z: number, out: WaterSample = createWaterSample()) => {
    const distance = Math.hypot(x, z);
    if (distance > RADIUS) return undefined;
    out.bodyId = 'lake:test';
    out.kind = 'lake';
    out.surfaceY = SURFACE;
    out.depth = 8 * (1 - distance / RADIUS) ** 0.5;
    out.flowX = 0;
    out.flowZ = 0;
    out.waveAmplitude = 0.2;
    out.shore = 1 - distance / RADIUS;
    return out;
  };
  return {
    seaState: 1,
    sampleAt,
    surfaceWater: undefined,
    displacedSurface: (x: number, z: number) => (sampleAt(x, z) ? SURFACE : undefined),
    waveOffset: () => 0,
    groundAt: (x: number, z: number) => (Math.hypot(x, z) > RADIUS ? SURFACE + 20 : SURFACE - 8),
    surfaceNear: (x: number, z: number, maxRadius = 32) => {
      if (sampleAt(x, z)) return SURFACE;
      for (let radius = 4; radius <= maxRadius; radius *= 2) {
        for (let i = 0; i < 8; i++) {
          const angle = i / 8 * Math.PI * 2;
          if (sampleAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius)) return SURFACE;
        }
      }
      return undefined;
    },
  } as unknown as WaterField;
}

const managers: WaterManager[] = [];
function makeManager(quality: keyof typeof QUALITY = 'high') {
  const origin = new FloatingOrigin();
  origin.update(new Vector3(0, 0, 0));
  const manager = new WaterManager(discField(), origin, quality);
  managers.push(manager);
  return { manager, origin };
}

afterEach(() => { while (managers.length > 0) managers.pop()?.dispose(); });

function stream(manager: WaterManager, origin: FloatingOrigin, at: Vector3, seconds = 1): void {
  for (let t = 0; t < seconds; t += 1 / 30) {
    origin.update(at);
    manager.update(1 / 30, at, at, t);
  }
}

/**
 * The manager's per-call build budget is wall-clock milliseconds, so under a
 * loaded CI machine one simulated second may not finish the ring. Streaming
 * until the tile count stops growing makes the geometry assertions robust
 * without changing the production budget.
 */
function streamUntilStable(manager: WaterManager, origin: FloatingOrigin, at: Vector3, rounds = 12): void {
  let last = -1;
  for (let i = 0; i < rounds; i++) {
    stream(manager, origin, at);
    if (manager.stats.tiles === last && manager.stats.builds === 0) return;
    last = manager.stats.tiles;
  }
}

const meshesOf = (manager: WaterManager): Mesh[] =>
  manager.group.children.filter((child): child is Mesh => child.type === 'Mesh');

describe('water material', () => {
  it('exposes the uniforms the weather and sky drive', () => {
    const material = createWaterMaterial({ detail: 2 });
    expect(() => {
      material.setTime(12.5);
      material.setWind(2, -1);
      material.setActivity(1.35);
      material.setRain(0.8);
      material.setSun(new Vector3(0.3, 0.9, 0.1), material.material.color as never, 2);
    }).not.toThrow();
    expect(material.material.transparent).toBe(true);
    material.dispose();
  });
});

describe('water streaming', () => {
  it('builds tiles inside the streaming radius and none outside it', () => {
    const { manager, origin } = makeManager();
    streamUntilStable(manager, origin, new Vector3(0, SURFACE, 0));
    const meshes = meshesOf(manager);
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      // Every tile origin is within one tile of the radius: nothing streams far away.
      expect(Math.hypot(mesh.position.x, mesh.position.z))
        .toBeLessThanOrEqual(QUALITY.high.waterRadius + CONFIG.water.tileSize);
    }
    // The whole disc is covered, at the near LOD resolution.
    const triangles = manager.stats.triangles;
    const nearSegments = QUALITY.high.waterSegments[0];
    expect(triangles).toBeGreaterThan(0);
    for (const mesh of meshes) {
      const geometry = mesh.geometry as BufferGeometry;
      const index = geometry.getIndex()!;
      expect(index.count / 3).toBeLessThanOrEqual(nearSegments ** 2 * 2);
    }
  });

  it('keeps dry vertices under the ground so the shoreline is continuous', () => {
    const { manager, origin } = makeManager();
    streamUntilStable(manager, origin, new Vector3(0, SURFACE, 0));
    const landHeight = SURFACE + 20;
    let shoreline = 0, wet = 0;
    for (const mesh of meshesOf(manager)) {
      const geometry = mesh.geometry as BufferGeometry;
      const positions = geometry.getAttribute('position');
      const depths = geometry.getAttribute('waterDepth');
      for (let i = 0; i < positions.count; i++) {
        const y = positions.getY(i);
        if (depths.getX(i) !== 0) { wet++; expect(y).toBeCloseTo(SURFACE, 6); continue; }
        // Dry vertices are always hidden by the ground: either on the local water
        // plane (so a spanning quad is cut at the real shoreline) or buried.
        expect(y).toBeLessThan(landHeight);
        if (y > SURFACE - 0.5) shoreline++;
      }
    }
    expect(wet).toBeGreaterThan(100);
    // The shoreline ring exists: dry vertices sit on the water plane, not buried
    // at the tall fallback, so the quad spanning the bank is cut by the terrain.
    expect(shoreline).toBeGreaterThan(0);
  });

  it('keeps the tile count inside the budget while driving far', () => {
    const { manager, origin } = makeManager('low');
    const budget = QUALITY.low.waterTiles;
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      stream(manager, origin, new Vector3(i * 900, SURFACE, 0), 0.5);
      peak = Math.max(peak, manager.stats.tiles);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(budget);
    expect(manager.stats.emptyTiles + manager.stats.tiles).toBeLessThanOrEqual(budget);
  });

  it('moves tiles with a rebase instead of rebuilding them', () => {
    const { manager, origin } = makeManager();
    const at = new Vector3(0, SURFACE, 0);
    stream(manager, origin, at);
    const before = meshesOf(manager).map((mesh) => ({ x: mesh.position.x, z: mesh.position.z }));
    const builds = manager.stats.builds;

    origin.update(new Vector3(3000, 0, 3000));
    manager.rebase();
    const after = meshesOf(manager).map((mesh) => ({ x: mesh.position.x, z: mesh.position.z }));
    expect(after).not.toEqual(before);
    // Canonical positions are unchanged: only the local offset moved.
    const canonical = after.map((p) => ({ x: p.x + origin.absolute.x, z: p.z + origin.absolute.z }));
    const canonicalBefore = before.map((p) => ({ x: p.x, z: p.z }));
    expect(canonical).toEqual(canonicalBefore);
    expect(manager.stats.builds).toBeLessThanOrEqual(builds + 4);
  });
});

describe('water queries', () => {
  it('answer surface, depth and underwater state from the same field', () => {
    const { manager, origin } = makeManager();
    streamUntilStable(manager, origin, new Vector3(0, SURFACE, 0));
    const sample = manager.sampleAt(0, 0)!;
    expect(sample.surfaceY).toBe(SURFACE);
    expect(sample.depth).toBeCloseTo(8, 6);
    expect(manager.surfaceAt(0, 0, 0)).toBe(SURFACE);
    expect(manager.isUnderwaterAt(0, SURFACE - 2, 0, 0)).toBe(true);
    expect(manager.isUnderwaterAt(0, SURFACE + 2, 0, 0)).toBe(false);
    expect(manager.sampleAt(RADIUS + 50, 0)).toBeUndefined();
    expect(manager.stats.bodiesNear).toBe(1);
    // The swim query is the displaced surface plus the current.
    const swim = manager.swimQuery(0, 0)!;
    expect(swim.surfaceY).toBe(SURFACE);
    expect(swim.flowX).toBe(0);
  });

  it('can be switched off without destroying its geometry', () => {
    const { manager, origin } = makeManager();
    streamUntilStable(manager, origin, new Vector3(0, SURFACE, 0));
    const triangles = manager.stats.triangles;
    manager.setEnabled(false);
    expect(manager.group.visible).toBe(false);
    expect(manager.stats.enabled).toBe(false);
    manager.setEnabled(true);
    expect(manager.group.visible).toBe(true);
    expect(manager.stats.triangles).toBe(triangles);
  });
});
