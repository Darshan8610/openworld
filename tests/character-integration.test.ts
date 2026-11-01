import { describe, expect, it } from 'vitest';
import { Scene, Vector3 } from 'three/webgpu';
import { CONFIG } from '../src/config';
import { FloatingOrigin } from '../src/core/floating-origin';
import { CharacterSystem } from '../src/character/character-system';
import type { Input } from '../src/core/input';
import type { TerrainManager } from '../src/world/terrain-manager';

/**
 * Composition test for the character system. It exercises the real controller,
 * sampler, animation controller, camera and floating-origin integration against a
 * synthetic height field — no GPU and no workers, so it runs in CI.
 */

const STEP = CONFIG.physics.fixedStep;

class StubInput {
  keys = new Set<string>();
  lookX = 0;
  lookY = 0;
  wheel = 0;
  down(...codes: string[]): boolean { return codes.some((code) => this.keys.has(code)); }
  consumeLook(): { x: number; y: number } {
    const result = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return result;
  }
  clear(): void { this.keys.clear(); }
}

function stubTerrain(height: (x: number, z: number) => number) {
  return {
    heightAt: (x: number, z: number) => height(x, z),
    biomeAt: () => 0,
    ready: 1,
  } as unknown as TerrainManager;
}

function build(height: (x: number, z: number) => number = () => 0) {
  const scene = new Scene();
  const origin = new FloatingOrigin();
  const input = new StubInput();
  const system = new CharacterSystem({
    scene,
    terrain: stubTerrain(height),
    origin,
    input: input as unknown as Input,
    quality: 'low',
    reducedMotion: true,
  });
  return { scene, origin, input, system };
}

function tick(system: CharacterSystem, input: StubInput, frames: number, keys: string[] = [], dt = STEP): void {
  input.keys = new Set(keys);
  for (let i = 0; i < frames; i++) {
    system.fixedUpdate(dt);
    system.render(dt, 1);
  }
}

describe('character system integration', () => {
  it('spawns on the streamed terrain and installs the placeholder rig', () => {
    const { system, scene } = build(() => 12);
    system.spawnAt(4, -6);
    tick(system, new StubInput(), 1);
    expect(system.ready).toBe(true);
    expect(system.position.x).toBeCloseTo(4, 3);
    expect(system.position.z).toBeCloseTo(-6, 3);
    expect(system.position.y).toBeCloseTo(12, 1);
    const snapshot = system.snapshot();
    expect(snapshot.rig.source).toBe('placeholder');
    expect(snapshot.rig.joints).toBe(19);
    expect(snapshot.rig.clips).toBe(13);
    expect(snapshot.rig.missingClips).toEqual([]);
    expect(scene.children.some((child) => child.name === 'Player / character')).toBe(true);
  });

  it('does not spawn until the ground under the spawn point is streamed', () => {
    const { system } = build(() => Number.NaN);
    system.spawnAt(0, 0);
    const missing = {
      heightAt: () => undefined,
      biomeAt: () => 0,
      ready: 0,
    } as unknown as TerrainManager;
    const blocked = new CharacterSystem({
      scene: new Scene(),
      terrain: missing,
      origin: new FloatingOrigin(),
      input: new StubInput() as unknown as Input,
      quality: 'low',
      reducedMotion: true,
    });
    blocked.spawnAt(0, 0);
    blocked.fixedUpdate(STEP);
    expect(blocked.ready).toBe(false);
    expect(blocked.snapshot().spawned).toBe(false);
    system.dispose();
    blocked.dispose();
  });

  it('walks the character and keeps the camera behind it', () => {
    const { system, input } = build(() => 0);
    system.spawnAt(0, 0);
    tick(system, input, 2);
    tick(system, input, 180, ['KeyW']);
    const snapshot = system.snapshot();
    expect(snapshot.mode).toBe('ground');
    expect(snapshot.speed).toBeGreaterThan(1);
    expect(snapshot.animation === 'jog' || snapshot.animation === 'walk').toBe(true);
    // Camera yaw starts at π (looking +Z), so W walks toward +Z.
    expect(system.position.z).toBeGreaterThan(4);
    const camera = system.camera.position;
    expect(camera.z).toBeLessThan(system.position.z);
    expect(camera.y).toBeGreaterThan(system.position.y);
  });

  it('survives a floating-origin rebase without moving in world space', () => {
    const { system, input, origin, scene } = build(() => 0);
    system.spawnAt(0, 0);
    tick(system, input, 4);
    const body = scene.children.find((child) => child.name === 'Player / character')!;
    expect(origin.shifts).toBe(0);

    // Relocate the player as a world event (teleport, vehicle exit, respawn) would.
    const destination = new Vector3(6000, 0, -6000);
    system.controller.position.copy(destination);
    tick(system, input, 200);

    expect(origin.shifts).toBeGreaterThan(0);
    expect(origin.absolute.x).toBeCloseTo(6144, 0);
    expect(origin.absolute.z).toBeCloseTo(-6144, 0);
    // Canonical position is untouched, and render-space position + origin matches it.
    expect(system.position.x).toBeCloseTo(6000, 0);
    expect(system.position.z).toBeCloseTo(-6000, 0);
    expect(body.position.x + origin.absolute.x).toBeCloseTo(system.position.x, 0);
    expect(body.position.z + origin.absolute.z).toBeCloseTo(system.position.z, 0);
    // The camera settles near the player and stays in render-local space.
    const cameraWorld = system.camera.position.clone().add(origin.absolute);
    expect(cameraWorld.distanceTo(new Vector3(system.position.x, system.position.y, system.position.z))).toBeLessThan(10);
  });

  it('switches to first person at eye height and hides the body', () => {
    const { system, input, scene } = build(() => 0);
    system.spawnAt(0, 0);
    tick(system, input, 2);
    system.setFirstPerson(true);
    tick(system, input, 90);
    const eye = system.camera.position.y;
    expect(eye).toBeGreaterThan(CONFIG.character.eyeHeight - 0.2);
    expect(eye).toBeLessThan(CONFIG.character.eyeHeight + 0.4);
    const body = scene.children.find((child) => child.name === 'Player / character');
    expect(body?.visible).toBe(false);
    system.setFirstPerson(false);
    tick(system, input, 4);
    expect(scene.children.find((child) => child.name === 'Player / character')?.visible).toBe(true);
  });

  it('climbs onto the terrain and jumps on demand', () => {
    const { system, input } = build((_x, z) => (z > 3 ? 0.3 : 0));
    system.spawnAt(0, 1);
    tick(system, input, 2);
    tick(system, input, 240, ['KeyW']);
    expect(system.position.z).toBeGreaterThan(3.4);
    expect(system.position.y).toBeCloseTo(0.3, 2);
    input.keys = new Set(['Space']);
    system.fixedUpdate(STEP);
    expect(system.snapshot().mode).toBe('air');
    tick(system, input, 90, []);
    expect(system.snapshot().mode).toBe('ground');
    expect(system.position.y).toBeCloseTo(0.3, 2);
  });

  it('returns to the spawn point on respawn', () => {
    const { system, input } = build(() => 0);
    system.spawnAt(0, 0);
    tick(system, input, 2);
    tick(system, input, 240, ['KeyW']);
    expect(Math.abs(system.position.z)).toBeGreaterThan(3);
    system.respawn();
    expect(system.position.x).toBeCloseTo(0, 3);
    expect(system.position.z).toBeCloseTo(0, 3);
    expect(system.snapshot().spawned).toBe(true);
  });

  it('reports the player position as the streaming focus while in character mode', () => {
    const { system, input, origin } = build(() => 0);
    system.spawnAt(-3000, 3000);
    tick(system, input, 10);
    // The origin rebases onto the player, so the render-space position stays small.
    expect(origin.absolute.x).toBeCloseTo(-2048, 0);
    expect(origin.absolute.z).toBeCloseTo(2048, 0);
    expect(Math.abs(system.position.x - origin.absolute.x)).toBeLessThan(2048);
    expect(Math.abs(system.position.z - origin.absolute.z)).toBeLessThan(2048);
    const snapshot = system.snapshot();
    expect(snapshot.position[0]).toBeCloseTo(system.position.x, 6);
    expect(snapshot.spawned).toBe(true);
  });
});

describe('building wiring in the motion sampler', () => {
  it('blocks locomotion through solid geometry with wall sliding', () => {
    // A solid plane beyond z = +5: the default camera yaw walks KeyW toward +Z,
    // so the player must stop at the wall instead of passing through.
    const origin = new FloatingOrigin();
    const scene = new Scene();
    const stub = new StubInput();
    const solid = new CharacterSystem({
      scene,
      terrain: stubTerrain(() => 0),
      origin,
      input: stub as unknown as Input,
      quality: 'low',
      reducedMotion: true,
      blocked: (_x, z) => z > 5,
    });
    solid.spawnAt(0, 0);
    tick(solid, stub, 2);
    tick(solid, stub, 240, ['KeyW']);
    expect(solid.ready).toBe(true);
    expect(solid.position.z).toBeLessThan(6);
    expect(solid.position.z).toBeGreaterThan(4); // it really did walk into the wall
    expect(Math.abs(solid.position.x)).toBeLessThan(0.6); // no sideways teleport
    solid.dispose();
  });

  it('stands on a walkable building support above the terrain', () => {
    const origin = new FloatingOrigin();
    const scene = new Scene();
    const stub = new StubInput();
    const system = new CharacterSystem({
      scene,
      terrain: stubTerrain(() => 0),
      origin,
      input: stub as unknown as Input,
      quality: 'low',
      reducedMotion: true,
      supportHeight: () => 0.4, // porch top everywhere, 0.4 m above terrain
    });
    system.spawnAt(0, 0);
    tick(system, stub, 30);
    expect(system.ready).toBe(true);
    expect(system.position.y).toBeCloseTo(0.4, 2);
    system.dispose();
  });

  it('falls back to terrain-only motion when no providers are supplied', () => {
    const { system, input } = build(() => 3);
    system.spawnAt(1, 2);
    tick(system, input, 30);
    expect(system.position.y).toBeCloseTo(3, 1);
    system.dispose();
  });
});
