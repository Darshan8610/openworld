import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { CONFIG } from '../src/config';
import { CharacterMotion } from '../src/character/locomotion';
import type { CharacterSampler, CharacterTuning, GroundContact, MoveIntent, WaterQuery } from '../src/character/locomotion';
import { CharacterController } from '../src/character/character-controller';
import type { CharacterEvent } from '../src/character/character-controller';
import { ThirdPersonCamera } from '../src/character/third-person-camera';
import type { CameraProbe } from '../src/character/third-person-camera';
import { createPlaceholderCharacter } from '../src/character/character-assets';
import { AnimationController } from '../src/character/animation-controller';
import { CLIP_TIMING, PLACEHOLDER_CLIP_NAMES } from '../src/character/animation-clips';
import type { AnimState } from '../src/character/animation-controller';
import { normalizeBoneName, RIG_SEMANTICS } from '../src/character/rig';
import { SkinnedMesh } from 'three/webgpu';

const TUNING: CharacterTuning = { ...CONFIG.character };
const STEP = CONFIG.physics.fixedStep;

/** Ground sampler over an analytic height field with optional solid blockers. */
class TestTerrain implements CharacterSampler {
  constructor(
    private readonly height: (x: number, z: number) => number,
    private readonly normalFn: (x: number, z: number, out: Vector3) => void = (_x, _z, out) => out.set(0, 1, 0),
    private readonly blocker: (x: number, z: number) => boolean = () => false,
  ) {}
  contact(x: number, z: number, out: GroundContact): GroundContact {
    out.height = this.height(x, z);
    out.biome = 0;
    this.normalFn(x, z, out.normal);
    return out;
  }
  blocked(x: number, z: number): boolean { return this.blocker(x, z); }
}

const flat = (): TestTerrain => new TestTerrain(() => 0);

function intent(overrides: Partial<MoveIntent> = {}): MoveIntent {
  return { x: 0, z: 0, speed: 0, sprint: false, crouch: false, jumpHeld: false, jumpPressed: false, ...overrides };
}

/** Advance the solver deterministically and collect per-tick results. */
function simulate(motion: CharacterMotion, steps: number, sampler: CharacterSampler, makeIntent: (tick: number) => MoveIntent, water?: WaterQuery) {
  const results = [];
  for (let i = 0; i < steps; i++) results.push(motion.step(STEP, makeIntent(i), sampler, water));
  return results;
}

function slopeTerrain(degrees: number): TestTerrain {
  const tan = Math.tan((degrees * Math.PI) / 180);
  const normal = new Vector3(-tan, 1, 0).normalize();
  return new TestTerrain((x) => Math.max(0, x) * tan, (_x, _z, out) => out.copy(normal));
}

describe('character motion solver', () => {
  it('settles on flat ground without drifting or sinking', () => {
    const motion = new CharacterMotion(TUNING);
    motion.place(0, 3, 0);
    const results = simulate(motion, 240, flat(), () => intent());
    expect(results.some((result) => result.landed)).toBe(true);
    expect(motion.position.y).toBeCloseTo(0, 5);
    expect(motion.grounded).toBe(true);
    expect(motion.velocity.length()).toBeLessThan(1e-6);
  });

  it('accelerates to the requested speed and decelerates with friction', () => {
    const motion = new CharacterMotion(TUNING);
    motion.place(0, 0, 0);
    // The first tick lands on the surface; from then on it can accelerate.
    motion.step(STEP, intent(), flat());
    simulate(motion, 120, flat(), () => intent({ x: 0, z: -1, speed: TUNING.jogSpeed }));
    expect(motion.horizontalSpeed).toBeGreaterThan(TUNING.jogSpeed * 0.98);
    expect(motion.horizontalSpeed).toBeLessThanOrEqual(TUNING.jogSpeed + 1e-6);
    const travel = motion.position.z;
    simulate(motion, 120, flat(), () => intent());
    expect(motion.horizontalSpeed).toBeLessThan(0.05);
    expect(motion.position.z).toBeLessThan(travel);
  });

  it('reaches the configured jump apex and lands again', () => {
    const motion = new CharacterMotion(TUNING);
    motion.place(0, 0, 0);
    motion.step(STEP, intent(), flat());
    const start = motion.position.y;
    let apex = start;
    let landed = false;
    for (let i = 0; i < 240; i++) {
      const result = motion.step(STEP, intent({ jumpHeld: i < 60, jumpPressed: i === 0 }), flat());
      apex = Math.max(apex, motion.position.y);
      if (i > 4 && result.landed) { landed = true; break; }
    }
    expect(landed).toBe(true);
    expect(apex - start).toBeGreaterThan(TUNING.jumpHeight * 0.85);
    expect(apex - start).toBeLessThan(TUNING.jumpHeight * 1.15);
    expect(motion.position.y).toBeCloseTo(0, 3);
  });

  it('cuts a jump short when the button is released early', () => {
    const measure = (holdTicks: number): number => {
      const motion = new CharacterMotion(TUNING);
      motion.place(0, 0, 0);
      motion.step(STEP, intent(), flat());
      let apex = 0;
      for (let i = 0; i < 200; i++) {
        motion.step(STEP, intent({ jumpHeld: i < holdTicks, jumpPressed: i === 0 }), flat());
        apex = Math.max(apex, motion.position.y);
      }
      return apex;
    };
    expect(measure(3)).toBeLessThan(measure(60) * 0.75);
  });

  it('honours coyote time after leaving a ledge', () => {
    const ledge = new TestTerrain((x) => (x < 4 ? 0 : -30));
    const motion = new CharacterMotion(TUNING);
    motion.place(0, 0, 0);
    motion.step(STEP, intent(), ledge);
    let leftGround = -1;
    for (let i = 0; i < 120; i++) {
      motion.step(STEP, intent({ x: 1, z: 0, speed: TUNING.jogSpeed }), ledge);
      if (!motion.grounded && leftGround < 0) { leftGround = i; break; }
    }
    expect(leftGround).toBeGreaterThanOrEqual(0);
    const result = motion.step(STEP, intent({ jumpPressed: true, jumpHeld: true }), ledge);
    expect(result.jumped).toBe(true);
  });

  it('buffers a jump pressed just before landing', () => {
    const motion = new CharacterMotion(TUNING);
    motion.place(0, 2, 0);
    let pressed = false;
    let jumped = false;
    for (let i = 0; i < 200; i++) {
      // Press while still ~0.03 s from the ground.
      const nearGround = motion.position.y > 0 && motion.position.y < 0.08 && motion.velocity.y < -1;
      const jumpPressed = nearGround && !pressed;
      if (jumpPressed) pressed = true;
      const result = motion.step(STEP, intent({ jumpPressed, jumpHeld: true }), flat());
      if (result.jumped) { jumped = true; break; }
    }
    expect(pressed).toBe(true);
    expect(jumped).toBe(true);
  });

  it('climbs a low step but is stopped by a tall wall', () => {
    const stepUp = new TestTerrain((x) => (x > 2 ? 0.3 : 0));
    const climb = new CharacterMotion(TUNING);
    climb.place(1.5, 0, 0);
    climb.step(STEP, intent(), stepUp);
    simulate(climb, 240, stepUp, () => intent({ x: 1, z: 0, speed: TUNING.jogSpeed }));
    expect(climb.position.x).toBeGreaterThan(2.4);
    expect(climb.position.y).toBeCloseTo(0.3, 3);
    expect(climb.grounded).toBe(true);

    const wall = new TestTerrain((x) => (x > 2 ? 1.2 : 0));
    const blocked = new CharacterMotion(TUNING);
    blocked.place(1.5, 0, 0);
    blocked.step(STEP, intent(), wall);
    simulate(blocked, 240, wall, () => intent({ x: 1, z: 0, speed: TUNING.jogSpeed }));
    expect(blocked.position.x).toBeLessThan(2.05);
    expect(blocked.position.y).toBeCloseTo(0, 3);
  });

  it('walks off a cliff, falls and lands on the lower ground', () => {
    const cliff = new TestTerrain((x) => (x < 3 ? 0 : -6));
    const motion = new CharacterMotion(TUNING);
    motion.place(2.5, 0, 0);
    motion.step(STEP, intent(), cliff);
    let airborne = false;
    let landed = false;
    for (let i = 0; i < 300; i++) {
      const result = motion.step(STEP, intent({ x: 1, z: 0, speed: TUNING.jogSpeed }), cliff);
      if (motion.mode === 'air') airborne = true;
      if (airborne && result.landed) { landed = true; break; }
    }
    expect(airborne).toBe(true);
    expect(landed).toBe(true);
    expect(motion.position.y).toBeCloseTo(-6, 3);
  });

  it('refuses to climb terrain steeper than the walkable limit and slides down it', () => {
    const steep = slopeTerrain(62);
    const motion = new CharacterMotion(TUNING);
    motion.place(1, 1.7, 0);
    motion.step(STEP, intent(), steep);
    simulate(motion, 120, steep, () => intent({ x: 1, z: 0, speed: TUNING.jogSpeed }));
    expect(motion.sliding).toBe(true);
    const climbed = motion.position.x - 1;
    expect(climbed).toBeLessThan(1.5);

    const resting = new CharacterMotion(TUNING);
    resting.place(4, 4 * Math.tan((62 * Math.PI) / 180) + 0.05, 0);
    resting.step(STEP, intent(), steep);
    simulate(resting, 180, steep, () => intent());
    expect(resting.position.x).toBeLessThan(3.2);
  });

  it('collides with solid obstacles but slides along them', () => {
    const walls = new TestTerrain(() => 0, (_x, _z, out) => out.set(0, 1, 0), (x) => x > 1.5);
    const motion = new CharacterMotion(TUNING);
    motion.place(0, 0, 0);
    motion.step(STEP, intent(), walls);
    // Push diagonally into the wall: forward motion must stop, lateral must continue.
    simulate(motion, 240, walls, () => intent({ x: 0.7, z: -0.7, speed: TUNING.jogSpeed }));
    expect(motion.position.x).toBeLessThan(1.55);
    expect(motion.position.z).toBeLessThan(-1.5);
  });

  it('holds position when terrain is not streamed yet', () => {
    const motion = new CharacterMotion(TUNING);
    motion.place(0, 0, 0);
    const empty: CharacterSampler = { contact: () => undefined };
    const result = motion.step(STEP, intent({ x: 1, z: 0, speed: 4 }), empty);
    expect(result.mode).toBe('air');
    expect(motion.position.y).toBe(0);
  });

  it('swims toward neutral buoyancy using a water surface query', () => {
    const deep = new TestTerrain(() => -20);
    const water: WaterQuery = () => ({ surfaceY: 0, flowX: 0, flowZ: 0 });
    const motion = new CharacterMotion(TUNING);
    motion.place(0, -2, 0);
    const results = simulate(motion, 480, deep, () => intent(), water);
    expect(results[0]?.mode).toBe('swim');
    expect(results[0]?.waterEntry).toBe(true);
    const neutral = -TUNING.swimFeetDepth;
    expect(motion.position.y).toBeGreaterThan(neutral - 0.3);
    expect(motion.position.y).toBeLessThan(neutral + 0.3);
  });

  it('stops diving at the bed instead of swimming through it', () => {
    const deep = new TestTerrain(() => -20);
    // A 3 m lake: the bed is at -3 and the control asks to dive hard.
    const water: WaterQuery = () => ({ surfaceY: 0, flowX: 0, flowZ: 0, bedY: -3 });
    const motion = new CharacterMotion(TUNING);
    motion.place(0, -1, 0);
    simulate(motion, 600, deep, () => intent({ crouch: true }), water);
    expect(motion.position.y).toBeGreaterThanOrEqual(-3 + 0.89);
    expect(motion.position.y).toBeLessThan(0);
  });

  it('reports water entry and exit transitions once', () => {
    let inWater = true;
    const water: WaterQuery = (x) => (inWater && x < 3 ? { surfaceY: 0, flowX: 0, flowZ: 0 } : undefined);
    const dry = new TestTerrain(() => 0);
    const motion = new CharacterMotion(TUNING);
    motion.place(0, -2, 0);
    const entry = motion.step(STEP, intent(), dry, water);
    expect(entry.waterEntry).toBe(true);
    inWater = false;
    const exit = motion.step(STEP, intent(), dry, water);
    expect(exit.waterExit).toBe(true);
    expect(exit.mode).not.toBe('swim');
  });
});

describe('character controller', () => {
  const input = (overrides = {}) => ({
    forward: 0, right: 0, sprint: false, walk: false, crouch: false,
    strafeLock: false, jumpHeld: false, jumpPressed: false, ...overrides,
  });

  it('moves relative to the camera and turns to face travel', () => {
    const controller = new CharacterController(TUNING);
    controller.spawn(0, 0, 0);
    const terrain = flat();
    controller.fixedUpdate(STEP, input({ forward: 1 }), 0, terrain);
    for (let i = 0; i < 120; i++) controller.fixedUpdate(STEP, input({ forward: 1 }), 0, terrain);
    // Camera yaw 0 looks down -Z, so forward input travels toward -Z.
    expect(controller.position.z).toBeLessThan(-3);
    expect(Math.abs(controller.position.x)).toBeLessThan(0.2);
    expect(Math.abs(Math.atan2(Math.sin(controller.yaw - Math.PI), Math.cos(controller.yaw - Math.PI)))).toBeLessThan(0.2);
  });

  it('selects stances and matching animation states', () => {
    const controller = new CharacterController(TUNING);
    controller.spawn(0, 0, 0);
    const terrain = flat();
    for (let i = 0; i < 8; i++) controller.fixedUpdate(STEP, input(), 0, terrain);
    expect(controller.stance).toBe('run');
    expect(controller.animation).toBe('idle');

    for (let i = 0; i < 40; i++) controller.fixedUpdate(STEP, input({ forward: 1, sprint: true }), 0, terrain);
    expect(controller.stance).toBe('sprint');
    expect(controller.animation).toBe('sprint');

    for (let i = 0; i < 60; i++) controller.fixedUpdate(STEP, input({ crouch: true }), 0, terrain);
    expect(controller.stance).toBe('crouch');
    expect(controller.animation).toBe('crouchIdle');

    for (let i = 0; i < 40; i++) controller.fixedUpdate(STEP, input({ crouch: true, forward: 1 }), 0, terrain);
    expect(controller.animation).toBe('crouchWalk');
  });

  it('plays strafe and backpedal when facing the camera', () => {
    const controller = new CharacterController(TUNING);
    controller.spawn(0, 0, 0);
    const terrain = flat();
    for (let i = 0; i < 60; i++) controller.fixedUpdate(STEP, input({ strafeLock: true, forward: -1 }), 0, terrain);
    expect(controller.animation).toBe('backpedal');
    for (let i = 0; i < 60; i++) controller.fixedUpdate(STEP, input({ strafeLock: true, right: 1 }), 0, terrain);
    expect(controller.animation).toBe('strafe');
  });

  it('emits footstep and landing events', () => {
    const controller = new CharacterController(TUNING);
    controller.spawn(0, 0, 0);
    const events: CharacterEvent[] = [];
    controller.onEvent = (event) => events.push(event);
    const terrain = flat();
    for (let i = 0; i < 480; i++) controller.fixedUpdate(STEP, input({ forward: 1 }), 0, terrain);
    expect(events.filter((event) => event.type === 'character/footstep').length).toBeGreaterThan(2);
    for (let i = 0; i < 200; i++) controller.fixedUpdate(STEP, input({ jumpPressed: i === 0, jumpHeld: i < 40 }), 0, terrain);
    expect(events.some((event) => event.type === 'character/landed')).toBe(true);
  });

  it('faces the camera in strafe mode and turns otherwise', () => {
    const controller = new CharacterController(TUNING);
    controller.spawn(0, 0, 0);
    const terrain = flat();
    for (let i = 0; i < 120; i++) controller.fixedUpdate(STEP, input({ strafeLock: true, right: 1 }), 0, terrain);
    expect(Math.abs(controller.yaw - Math.PI)).toBeLessThan(0.05);
    for (let i = 0; i < 200; i++) controller.fixedUpdate(STEP, input({ right: 1 }), 0, terrain);
    expect(Math.abs(Math.abs(controller.yaw) - Math.PI / 2)).toBeLessThan(0.15);
  });
});

describe('third-person camera', () => {
  const settings = { ...CONFIG.personCamera };
  const origin = new Vector3(0, 0, 0);
  const target = (overrides = {}) => ({ x: 0, y: 0, z: 0, anchorHeight: 1.45, speed: 0, swimming: false, verticalSpeed: 0, ...overrides });
  const ground = (height: number) => ({
    groundHeight: () => height,
  } as CameraProbe);

  it('orbits behind the anchor and clamps pitch and zoom', () => {
    const camera = new ThirdPersonCamera(settings);
    camera.look(0, 100000);
    expect(camera.pitch).toBeCloseTo(settings.pitchMin, 5);
    camera.look(0, -100000);
    expect(camera.pitch).toBeCloseTo(settings.pitchMax, 5);
    camera.look(0, 0);
    camera.pitch = -0.16;
    const local = camera.update(1 / 60, target(), ground(-100), origin, new Vector3());
    expect(local.z).toBeLessThan(-3);
    expect(local.y).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) camera.zoom(1);
    expect(camera.distance).toBeCloseTo(settings.minDistance, 5);
  });

  it('shortens the boom instead of intersecting the ground', () => {
    const camera = new ThirdPersonCamera(settings);
    // A wall of terrain right behind the anchor must pull the camera in.
    const wall: CameraProbe = { groundHeight: () => 40 };
    camera.update(1 / 60, target({ y: 0 }), wall, origin, new Vector3());
    expect(camera.camera.position.y).toBeGreaterThanOrEqual(40);
    const open = new ThirdPersonCamera(settings);
    const openPos = open.update(1 / 60, target({ y: 40 }), wall, origin, new Vector3());
    expect(openPos.y).toBeGreaterThanOrEqual(40);
  });

  it('uses eye height and no boom in first person', () => {
    const camera = new ThirdPersonCamera(settings);
    camera.setFirstPerson(true);
    const local = camera.update(1 / 60, target({ y: 100 }), ground(-100), origin, new Vector3());
    expect(local.y).toBeCloseTo(100 + 1.45, 3);
    expect(local.x).toBeCloseTo(0, 3);
  });

  it('keeps the camera stable when the world origin rebases', () => {
    const camera = new ThirdPersonCamera(settings);
    const first = camera.update(1 / 60, target({ x: 2000, y: 50, z: 2000 }), ground(-100), new Vector3(0, 0, 0), new Vector3());
    const worldX = first.x, worldZ = first.z;
    const rebased = new Vector3(2048, 0, 2048);
    const local = camera.update(1 / 60, target({ x: 2000, y: 50, z: 2000 }), ground(-100), rebased, new Vector3());
    expect(local.x + rebased.x).toBeCloseTo(worldX + 0, 0);
    expect(local.z + rebased.z).toBeCloseTo(worldZ + 0, 0);
  });
});

describe('character rig and animation', () => {
  it('builds a real skinned placeholder rig with every semantic joint', () => {
    const asset = createPlaceholderCharacter();
    expect(asset.source).toBe('placeholder');
    expect(asset.rig.bones.size).toBe(RIG_SEMANTICS.length);
    for (const semantic of RIG_SEMANTICS) expect(asset.rig.bones.has(semantic)).toBe(true);
    const skin = asset.rig.skin as SkinnedMesh;
    expect(skin).toBeInstanceOf(SkinnedMesh);
    expect(skin.geometry.getAttribute('skinIndex')).toBeDefined();
    expect(skin.geometry.getAttribute('skinWeight')).toBeDefined();
    expect(asset.rig.skeleton?.bones.length).toBe(RIG_SEMANTICS.length);
    expect(asset.rig.height).toBeGreaterThan(1.6);
    expect(asset.missingClips).toEqual([]);
    asset.rig.dispose();
  });

  it('authors a full clip set that targets real bones and loops correctly', () => {
    const asset = createPlaceholderCharacter();
    expect(asset.clips.size).toBe(PLACEHOLDER_CLIP_NAMES.length);
    const boneNames = new Set([...asset.rig.bones.values()].map((bone) => bone.name));
    for (const [state, definition] of asset.clips) {
      expect(definition.clip.tracks.length).toBeGreaterThan(0);
      for (const track of definition.clip.tracks) {
        const bone = track.name.split('.')[0] ?? '';
        expect(boneNames.has(bone)).toBe(true);
      }
      expect(definition.clip.duration).toBeCloseTo(CLIP_TIMING[state as keyof typeof CLIP_TIMING].duration, 5);
      expect(definition.loop).toBe(CLIP_TIMING[state as keyof typeof CLIP_TIMING].loop);
    }
    // Non-looping clips must be finite and positive so they cannot hang a state.
    expect(asset.clips.get('land')?.loop).toBe(false);
    expect(asset.clips.get('jump')?.loop).toBe(false);
  });

  it('drives the rig through a real mixer and cross-fades between states', () => {
    const asset = createPlaceholderCharacter();
    const controller = new AnimationController(asset.rig.root, asset.rig.bones, asset.clips.entries());
    const hips = asset.rig.bones.get('hips')!;
    const thigh = asset.rig.bones.get('thighL')!;
    const before = thigh.quaternion.clone();
    const hipsBefore = hips.position.y;
    controller.play('walk', 0, CONFIG.character.walkSpeed);
    for (let i = 0; i < 30; i++) controller.update(1 / 60);
    expect(controller.active).toBe('walk');
    expect(thigh.quaternion.equals(before)).toBe(false);
    expect(Math.abs(hips.position.y - hipsBefore)).toBeGreaterThan(1e-4);

    controller.play('sprint', 0.2, CONFIG.character.sprintSpeed);
    controller.update(0.1);
    expect(controller.active).toBe('sprint');
    expect(controller.playbackRate).toBeGreaterThan(0.9);

    // A one-shot state clamps instead of looping forever.
    controller.restart('land');
    for (let i = 0; i < 120; i++) controller.update(1 / 60);
    expect(controller.active).toBe('land');
    controller.dispose();
    asset.rig.dispose();
  });

  it('normalizes imported bone names to semantic joint names', () => {
    expect(normalizeBoneName('mixamorig:LeftArm')).toBe('leftarm');
    expect(normalizeBoneName('Armature|LeftUpLeg')).toBe('leftupleg');
    expect(normalizeBoneName('DEF-spine')).toBe('spine');
  });
});

describe('character animation state coverage', () => {
  it('maps every controller output state to a clip', () => {
    const asset = createPlaceholderCharacter();
    const states: AnimState[] = ['idle', 'walk', 'jog', 'sprint', 'backpedal', 'strafe', 'crouchIdle', 'crouchWalk', 'jump', 'fall', 'land', 'swim', 'tread'];
    for (const state of states) expect(asset.clips.has(state)).toBe(true);
    asset.rig.dispose();
  });
});
