/**
 * Coverage for the layers between the physics and the player: cameras, audio
 * hooks and the input mapper. These are the parts a "visual-only" vehicle
 * implementation would fake, so each test asserts a behavioural consequence
 * rather than that a field was assigned.
 */
import { describe, expect, it } from 'vitest';
import { makeEnv, simulate, spawn } from './helpers/vehicle-harness';
import { INTERIOR_VIEWS, VEHICLE_VIEWS, VehicleCamera } from '../src/vehicles/vehicle-camera';
import { VehicleAudioHooks } from '../src/vehicles/vehicle-audio';
import { VehicleInputMapper } from '../src/vehicles/vehicle-input';
import { VEHICLE_CLASSES, neutralControls } from '../src/vehicles/types';
import { VEHICLE_CATALOG, vehicleKeys, vehicleSpecOrThrow } from '../src/vehicles/catalog';
import { createController } from '../src/vehicles/controller-factory';
import type { Input } from '../src/core/input';

/** Minimal stand-in for the real Input, which needs a canvas and DOM. */
function fakeInput(held: string[]): Input {
  const keys = new Set(held);
  return { down: (...codes: string[]) => codes.some((code) => keys.has(code)) } as unknown as Input;
}

describe('vehicle camera', () => {
  it('offers six distinct views and cycles through all of them', () => {
    const camera = new VehicleCamera();
    expect(VEHICLE_VIEWS).toHaveLength(6);
    const seen = new Set([camera.view]);
    for (let i = 0; i < VEHICLE_VIEWS.length; i++) seen.add(camera.cycle());
    expect(seen.size).toBe(VEHICLE_VIEWS.length);
    expect(camera.view).toBe(VEHICLE_VIEWS[0]);
  });

  it('places the chase camera behind the vehicle and the cockpit inside it', () => {
    const env = makeEnv();
    const car = spawn('sedan', 1.0);
    simulate(car, env, 1.5);
    const camera = new VehicleCamera();

    camera.setView('chase');
    const chase = camera.update(1 / 60, car, 1, env);
    const behind = chase.eye.z - car.body.position.z;
    // Facing +Z, so the chase rig sits at negative Z and above the roof.
    expect(behind).toBeLessThan(-2);
    expect(chase.eye.y).toBeGreaterThan(car.body.position.y);

    camera.setView('cockpit');
    const cockpit = camera.update(1 / 60, car, 1, env);
    const offset = Math.hypot(
      cockpit.eye.x - car.body.position.x,
      cockpit.eye.z - car.body.position.z,
    );
    expect(offset).toBeLessThan(car.spec.dimensions.length * 0.5);
  });

  it('keeps the exterior camera above the ground but lets interior views sit low', () => {
    const env = makeEnv({ height: 40 });
    const car = spawn('sedan', 41);
    simulate(car, env, 1.5);
    const camera = new VehicleCamera();

    camera.setView('chase');
    // Pose vectors are reused between calls, so read the value out now.
    const chaseY = camera.update(1 / 60, car, 1, env).eye.y;
    expect(chaseY).toBeGreaterThan(40);

    camera.setView('cockpit');
    const cockpitY = camera.update(1 / 60, car, 1, env).eye.y;
    // Inside the cabin, which is below where the chase rig is clamped to.
    expect(cockpitY).toBeLessThan(chaseY);
    expect(INTERIOR_VIEWS.has('cockpit')).toBe(true);
    expect(INTERIOR_VIEWS.has('chase')).toBe(false);
  });

  it('widens the field of view with speed', () => {
    const env = makeEnv();
    const car = spawn('sedan', 1.0);
    simulate(car, env, 1.5);
    const camera = new VehicleCamera();
    const parked = camera.update(1 / 60, car, 1, env).fov;

    car.controls.throttle = 1;
    simulate(car, env, 12);
    const moving = camera.update(1 / 60, car, 1, env).fov;
    expect(car.telemetry.speed).toBeGreaterThan(5);
    expect(moving).toBeGreaterThan(parked);
  });

  it('rolls the cockpit view with the hull but never the chase view', () => {
    const env = makeEnv();
    const bike = spawn('motorcycle', 0.8);
    simulate(bike, env, 1.5);
    bike.body.angularVelocity.set(0, 0, 1.4);
    bike.body.wake();
    simulate(bike, env, 0.3);
    const camera = new VehicleCamera();

    camera.setView('cockpit');
    expect(Math.abs(camera.update(1 / 60, bike, 1, env).roll)).toBeGreaterThan(0.01);
    camera.setView('chase');
    expect(camera.update(1 / 60, bike, 1, env).roll).toBe(0);
  });
});

describe('vehicle audio hooks', () => {
  it('is silent for a parked, dead vehicle', () => {
    const car = spawn('sedan', 1.0);
    const hooks = new VehicleAudioHooks();
    hooks.update(car);
    for (const signal of Object.values(hooks.channels)) expect(signal.gain).toBe(0);
  });

  it('raises engine gain and pitch with revs', () => {
    const env = makeEnv();
    const car = spawn('sedan', 1.0);
    const hooks = new VehicleAudioHooks();
    simulate(car, env, 1.5);
    hooks.update(car);
    const idle = { ...hooks.channels.engine };

    car.controls.throttle = 1;
    simulate(car, env, 10);
    hooks.update(car);
    expect(car.telemetry.engineRpm).toBeGreaterThan(idle.pitch);
    expect(hooks.channels.engine.gain).toBeGreaterThan(idle.gain);
    expect(hooks.channels.engine.pitch).toBeGreaterThan(idle.pitch);
    expect(hooks.channels.tyre.gain).toBeGreaterThan(0);
  });

  it('reports a gear shift exactly once', () => {
    const env = makeEnv();
    const car = spawn('sedan', 1.0);
    const hooks = new VehicleAudioHooks();
    simulate(car, env, 1.5);
    hooks.update(car);
    hooks.drainEvents();

    car.controls.throttle = 1;
    let shifts = 0;
    for (let i = 0; i < 60; i++) {
      simulate(car, env, 0.25);
      hooks.update(car);
      for (const event of hooks.drainEvents()) if (event.kind === 'gear-shift') shifts++;
    }
    expect(car.telemetry.gear).toBeGreaterThan(1);
    expect(shifts).toBeGreaterThanOrEqual(car.telemetry.gear - 1);
    // Not one per frame: an edge-triggered event, not a level.
    expect(shifts).toBeLessThan(15);
  });

  it('skids only when the tyre is genuinely past its peak', () => {
    const env = makeEnv({ surface: 'ice' });
    const car = spawn('sedan', 1.0);
    const hooks = new VehicleAudioHooks();
    simulate(car, env, 1.5);
    car.controls.throttle = 1;
    let peakSkid = 0;
    let peakSlip = 0;
    for (let i = 0; i < 40; i++) {
      simulate(car, env, 0.2);
      hooks.update(car);
      peakSkid = Math.max(peakSkid, hooks.channels.skid.gain);
      peakSlip = Math.max(peakSlip, car.telemetry.slip);
    }
    expect(peakSlip).toBeGreaterThan(0.35);
    expect(peakSkid).toBeGreaterThan(0);

    const grippy = makeEnv({ surface: 'asphalt' });
    const steady = spawn('sedan', 1.0);
    const quiet = new VehicleAudioHooks();
    simulate(steady, grippy, 1.5);
    steady.controls.throttle = 0.12;
    simulate(steady, grippy, 10);
    quiet.update(steady);
    expect(quiet.channels.skid.gain).toBeLessThan(peakSkid);
  });

  it('drives rotor and wind channels for a helicopter', () => {
    const env = makeEnv();
    const heli = spawn('helicopter', 2);
    const hooks = new VehicleAudioHooks();
    heli.controls.collective = 1;
    simulate(heli, env, 12);
    hooks.update(heli);
    expect(hooks.channels.rotor.gain).toBeGreaterThan(0.8);
    expect(hooks.channels.wind.gain).toBeGreaterThan(0);
    // A helicopter has no gearbox to make transmission noise.
    expect(hooks.channels.transmission.gain).toBe(0);
  });

  it('bounds the event queue under pathological input', () => {
    const hooks = new VehicleAudioHooks();
    for (let i = 0; i < 500; i++) hooks.reportImpact(1);
    expect(hooks.drainEvents().length).toBeLessThanOrEqual(16);
  });

  it('clamps every gain to 0..1', () => {
    const env = makeEnv();
    const car = spawn('sports', 1.0);
    const hooks = new VehicleAudioHooks();
    car.controls.throttle = 1;
    for (let i = 0; i < 40; i++) {
      simulate(car, env, 0.5);
      hooks.update(car);
      for (const [name, signal] of Object.entries(hooks.channels)) {
        expect(signal.gain, name).toBeGreaterThanOrEqual(0);
        expect(signal.gain, name).toBeLessThanOrEqual(1);
        expect(Number.isFinite(signal.pitch), name).toBe(true);
      }
    }
  });
});

describe('vehicle input mapping', () => {
  it('maps the same keys to different meanings per class', () => {
    const mapper = new VehicleInputMapper();
    const held = fakeInput(['KeyW']);

    const car = neutralControls();
    for (let i = 0; i < 60; i++) mapper.apply(held, 'wheeled', 1 / 60, car);
    expect(car.throttle).toBeGreaterThan(0.5);
    expect(car.pitch).toBe(0);

    mapper.reset();
    const plane = neutralControls();
    for (let i = 0; i < 60; i++) mapper.apply(held, 'aircraft', 1 / 60, plane);
    // W is "nose down" in an aeroplane, and it does not open the throttle.
    expect(plane.pitch).toBeLessThan(-0.5);
    expect(plane.throttle).toBe(0);
  });

  it('ramps axes over time rather than snapping', () => {
    const mapper = new VehicleInputMapper();
    const held = fakeInput(['KeyD']);
    const out = neutralControls();
    mapper.apply(held, 'wheeled', 1 / 60, out);
    const first = out.steer;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    for (let i = 0; i < 60; i++) mapper.apply(held, 'wheeled', 1 / 60, out);
    expect(out.steer).toBeGreaterThan(first);
  });

  it('returns axes to centre when the key is released', () => {
    const mapper = new VehicleInputMapper();
    const out = neutralControls();
    for (let i = 0; i < 60; i++) mapper.apply(fakeInput(['KeyA']), 'wheeled', 1 / 60, out);
    expect(out.steer).toBeLessThan(-0.5);
    for (let i = 0; i < 60; i++) mapper.apply(fakeInput([]), 'wheeled', 1 / 60, out);
    expect(out.steer).toBe(0);
  });

  it('brakes rather than reverses while rolling forward', () => {
    const mapper = new VehicleInputMapper();
    const out = neutralControls();
    mapper.apply(fakeInput(['Space']), 'wheeled', 1 / 60, out);
    expect(out.brake).toBe(1);
    expect(out.reverse).toBe(false);
  });

  it('handles every vehicle class without throwing', () => {
    const mapper = new VehicleInputMapper();
    const held = fakeInput(['KeyW', 'KeyD', 'ShiftLeft']);
    for (const vehicleClass of VEHICLE_CLASSES) {
      mapper.reset();
      const out = neutralControls();
      expect(() => mapper.apply(held, vehicleClass, 1 / 60, out)).not.toThrow();
      for (const value of [out.throttle, out.steer, out.pitch, out.roll, out.yaw, out.collective, out.ballast]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe('catalogue integrity', () => {
  it('builds a controller for every catalogue entry', () => {
    for (const spec of VEHICLE_CATALOG) {
      const controller = createController(spec);
      expect(controller.kind).toBe(spec.vehicleClass);
    }
  });

  it('covers every vehicle class with at least one vehicle', () => {
    const covered = new Set(VEHICLE_CATALOG.map((spec) => spec.vehicleClass));
    for (const vehicleClass of VEHICLE_CLASSES) expect(covered.has(vehicleClass)).toBe(true);
  });

  it('gives every vehicle a unique key, a driver seat and sane dimensions', () => {
    const keys = vehicleKeys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      const spec = vehicleSpecOrThrow(key);
      expect(spec.seats.some((seat) => seat.role === 'driver'), key).toBe(true);
      expect(spec.mass, key).toBeGreaterThan(0);
      expect(spec.maxHealth, key).toBeGreaterThan(0);
      expect(spec.dimensions.length, key).toBeGreaterThan(0);
      expect(spec.dimensions.width, key).toBeGreaterThan(0);
      expect(spec.dimensions.height, key).toBeGreaterThan(0);
      expect(spec.topSpeed, key).toBeGreaterThan(0);
    }
  });

  it('gives every fuelled vehicle a non-zero burn rate', () => {
    for (const spec of VEHICLE_CATALOG) {
      if (spec.fuelCapacity > 0) expect(spec.fuelBurn, spec.key).toBeGreaterThan(0);
      else expect(spec.fuelBurn, spec.key).toBe(0);
    }
  });

  it('gives every wheeled vehicle wheels and every aircraft an aero spec', () => {
    for (const spec of VEHICLE_CATALOG) {
      if (spec.vehicleClass === 'wheeled' || spec.vehicleClass === 'motorcycle') {
        expect(spec.wheels?.length ?? 0, spec.key).toBeGreaterThan(0);
        expect(spec.drivetrain, spec.key).toBeDefined();
      }
      if (spec.vehicleClass === 'aircraft') expect(spec.aero, spec.key).toBeDefined();
      if (spec.vehicleClass === 'helicopter') expect(spec.rotor, spec.key).toBeDefined();
      if (spec.vehicleClass === 'watercraft' || spec.vehicleClass === 'sailboat' || spec.vehicleClass === 'submarine') {
        expect(spec.hull, spec.key).toBeDefined();
      }
      if (spec.vehicleClass === 'sailboat') expect(spec.sail, spec.key).toBeDefined();
      if (spec.vehicleClass === 'submarine') expect(spec.submarine, spec.key).toBeDefined();
    }
  });
});
