import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { Vehicle } from '../src/vehicles/vehicle';
import { vehicleSpecOrThrow } from '../src/vehicles/catalog';
import { airDensityAt } from '../src/vehicles/controllers/controller';
import { magicFormula, solveTyre, LONGITUDINAL } from '../src/vehicles/tyre';
import { torqueFraction } from '../src/vehicles/drivetrain';
import { boxInertia, VehicleBody } from '../src/vehicles/vehicle-body';
import type { SurfaceKind } from '../src/physics/surfaces';
import type { VehicleEnvironment, VehicleGroundSample, VehicleWaterSample } from '../src/vehicles/types';

const STEP = 1 / 120;

interface EnvOptions {
  height?: number | ((x: number, z: number) => number);
  surface?: SurfaceKind;
  waterLevel?: number;
  wind?: { x: number; y: number; z: number };
  flow?: { x: number; z: number };
}

/** Analytic test world: flat or sloped ground, optional water plane and wind. */
function makeEnv(options: EnvOptions = {}): VehicleEnvironment {
  const { height = 0, surface = 'asphalt', waterLevel, wind = { x: 0, y: 0, z: 0 }, flow } = options;
  const heightAt = typeof height === 'function' ? height : () => height;
  return {
    gravity: -9.81,
    ground(x: number, z: number, out: VehicleGroundSample): VehicleGroundSample {
      out.height = heightAt(x, z);
      // Central-difference normal so slopes produce a correct contact normal.
      const e = 0.5;
      const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
      const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const len = Math.hypot(dx, 1, dz);
      out.nx = -dx / len; out.ny = 1 / len; out.nz = -dz / len;
      out.surface = surface;
      return out;
    },
    water(x: number, z: number): VehicleWaterSample | undefined {
      if (waterLevel === undefined) return undefined;
      const bed = heightAt(x, z);
      if (bed >= waterLevel) return undefined;
      return {
        surfaceY: waterLevel, nx: 0, ny: 1, nz: 0,
        flowX: flow?.x ?? 0, flowZ: flow?.z ?? 0, depth: waterLevel - bed,
      };
    },
    airDensity: airDensityAt,
    wind,
  };
}

function spawn(key: string, y = 0.9, yaw = 0): Vehicle {
  const spec = vehicleSpecOrThrow(key);
  return new Vehicle(`test-${key}`, spec, { x: 0, y, z: 0 }, yaw);
}

function simulate(vehicle: Vehicle, env: VehicleEnvironment, seconds: number): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) vehicle.fixedUpdate(STEP, env);
}

describe('rigid body', () => {
  it('conserves a free body under gravity with no contacts', () => {
    const body = new VehicleBody(1000, boxInertia(1000, 2, 1.5, 4));
    body.place(0, 100, 0);
    for (let i = 0; i < 120; i++) {
      body.addForce(0, -9.81 * 1000, 0);
      body.integrate(STEP);
    }
    // Semi-implicit Euler over 1 s: v = -g·t exactly.
    expect(body.velocity.y).toBeCloseTo(-9.81, 2);
    expect(body.position.y).toBeLessThan(100);
    expect(body.position.y).toBeGreaterThan(94);
  });

  it('produces torque from an off-centre force', () => {
    const body = new VehicleBody(500, boxInertia(500, 2, 1.5, 4));
    body.place(0, 0, 0);
    const force = new Vector3(0, 1000, 0);
    const point = new Vector3(1, 0, 0);
    body.addForceAtPoint(force, point);
    body.integrate(STEP);
    // Upward force to the right rolls the body about its forward (+Z) axis.
    expect(body.angularVelocity.z).toBeGreaterThan(0);
    expect(Math.abs(body.angularVelocity.y)).toBeLessThan(1e-9);
  });

  it('reports point velocity including the rotational component', () => {
    const body = new VehicleBody(100, boxInertia(100, 1, 1, 1));
    body.place(0, 0, 0);
    body.velocity.set(1, 0, 0);
    body.angularVelocity.set(0, 1, 0); // 1 rad/s about +Y
    const out = new Vector3();
    body.pointVelocity(new Vector3(0, 0, 1), out);
    // ω × r = (0,1,0) × (0,0,1) = (1,0,0); plus the linear 1 m/s.
    expect(out.x).toBeCloseTo(2, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });

  it('keeps canonical coordinates in doubles far from the origin', () => {
    const body = new VehicleBody(1200, boxInertia(1200, 2, 1.5, 4));
    body.place(1_000_000, 300, -2_500_000);
    body.velocity.set(10, 0, 0);
    body.integrate(STEP);
    expect(body.position.x).toBeCloseTo(1_000_000 + 10 * STEP, 6);
    expect(body.position.z).toBeCloseTo(-2_500_000, 6);
  });

  it('recovers from a non-finite force instead of poisoning the pose', () => {
    const body = new VehicleBody(900, boxInertia(900, 2, 1.5, 4));
    body.place(0, 10, 0);
    body.addForce(Number.NaN, 0, 0);
    body.integrate(STEP);
    expect(Number.isFinite(body.position.x)).toBe(true);
    expect(Number.isFinite(body.velocity.x)).toBe(true);
  });
});

describe('tyre model', () => {
  it('rises to a peak then falls away into the sliding regime', () => {
    const peak = magicFormula(0.12, LONGITUDINAL);
    const small = magicFormula(0.02, LONGITUDINAL);
    const sliding = magicFormula(0.8, LONGITUDINAL);
    expect(small).toBeLessThan(peak);
    expect(sliding).toBeLessThan(peak);
    expect(peak).toBeGreaterThan(0.9);
  });

  it('is antisymmetric about zero slip', () => {
    expect(magicFormula(-0.15, LONGITUDINAL)).toBeCloseTo(-magicFormula(0.15, LONGITUDINAL), 10);
  });

  it('grips far less on ice than on asphalt at the same load', () => {
    const base = { load: 4000, longitudinalSpeed: 12, lateralSpeed: 1.6, rimSpeed: 12, gripLong: 1, gripLat: 1 };
    const asphalt = solveTyre({ ...base, surface: 'asphalt' });
    const ice = solveTyre({ ...base, surface: 'ice' });
    expect(Math.abs(ice.lateral)).toBeLessThan(Math.abs(asphalt.lateral) * 0.3);
  });

  it('clamps combined slip to the friction ellipse', () => {
    const forces = solveTyre({
      load: 4000, longitudinalSpeed: 20, lateralSpeed: 14, rimSpeed: 32,
      surface: 'asphalt', gripLong: 1, gripLat: 1,
    });
    const peak = 4000 * 0.86;
    // Neither axis may exceed the available friction once combined.
    expect(Math.hypot(forces.longitudinal, forces.lateral)).toBeLessThanOrEqual(peak * 1.05);
    expect(forces.saturation).toBeGreaterThan(1);
  });

  it('produces no force without load', () => {
    const forces = solveTyre({
      load: 0, longitudinalSpeed: 10, lateralSpeed: 5, rimSpeed: 0,
      surface: 'asphalt', gripLong: 1, gripLat: 1,
    });
    expect(forces.longitudinal).toBe(0);
    expect(forces.lateral).toBe(0);
  });
});

describe('drivetrain', () => {
  it('peaks the torque curve at the rated engine speed', () => {
    const spec = vehicleSpecOrThrow('sedan').drivetrain!;
    const atPeak = torqueFraction(spec.peakTorqueRpm, spec);
    expect(atPeak).toBeGreaterThan(torqueFraction(spec.idleRpm + 200, spec));
    expect(atPeak).toBeGreaterThan(torqueFraction(spec.maxRpm - 100, spec));
    expect(atPeak).toBeCloseTo(1, 2);
  });

  it('cuts torque at the limiter', () => {
    const spec = vehicleSpecOrThrow('sedan').drivetrain!;
    expect(torqueFraction(spec.maxRpm, spec)).toBeLessThan(0.3);
  });
});

describe('road vehicle', () => {
  it('settles on its suspension at a stable ride height', () => {
    const env = makeEnv();
    const car = spawn('sedan', 1.4);
    simulate(car, env, 4);
    const height = car.body.position.y;
    expect(height).toBeGreaterThan(0.2);
    expect(height).toBeLessThan(1.2);
    // Settled, not still falling or bouncing.
    expect(Math.abs(car.body.velocity.y)).toBeLessThan(0.25);
    expect(car.telemetry.grounded).toBe(1);
  });

  it('accelerates under throttle and stops under braking', () => {
    const env = makeEnv();
    const car = spawn('sedan', 1.0);
    simulate(car, env, 2);
    car.controls.throttle = 1;
    simulate(car, env, 6);
    const cruising = car.telemetry.forwardSpeed;
    expect(cruising).toBeGreaterThan(8);
    expect(car.body.position.z).toBeGreaterThan(5);

    car.controls.throttle = 0;
    car.controls.brake = 1;
    simulate(car, env, 6);
    expect(Math.abs(car.telemetry.forwardSpeed)).toBeLessThan(0.6);
  });

  it('takes longer to stop on snow than on asphalt', () => {
    const run = (surface: SurfaceKind): number => {
      const env = makeEnv({ surface });
      const car = spawn('sedan', 1.0);
      simulate(car, env, 2);
      car.body.velocity.set(0, 0, 22);
      for (const wheel of car.controller.wheels) wheel.omega = 22 / 0.33;
      car.controls.brake = 1;
      const start = car.body.position.z;
      for (let i = 0; i < 120 * 12 && car.body.velocity.z > 0.4; i++) car.fixedUpdate(STEP, env);
      return car.body.position.z - start;
    };
    const dry = run('asphalt');
    const snow = run('snow');
    expect(snow).toBeGreaterThan(dry * 1.5);
  });

  it('climbs the engine through the gears under full throttle', () => {
    const env = makeEnv();
    const car = spawn('sedan', 1.0);
    simulate(car, env, 1.5);
    car.controls.throttle = 1;
    simulate(car, env, 12);
    expect(car.telemetry.gear).toBeGreaterThan(1);
    expect(car.telemetry.engineRpm).toBeGreaterThan(900);
  });

  it('turns when steered and holds a straight line when not', () => {
    const env = makeEnv();
    const straight = spawn('sedan', 1.0);
    simulate(straight, env, 1.5);
    straight.controls.throttle = 0.6;
    simulate(straight, env, 6);
    expect(Math.abs(straight.body.position.x)).toBeLessThan(1.6);

    const turning = spawn('sedan', 1.0);
    simulate(turning, env, 1.5);
    turning.controls.throttle = 0.6;
    turning.controls.steer = 1;
    simulate(turning, env, 6);
    expect(Math.abs(turning.body.position.x)).toBeGreaterThan(3);
    expect(Math.abs(turning.body.yaw)).toBeGreaterThan(0.2);
  });

  it('rolls downhill on a slope with no throttle', () => {
    const env = makeEnv({ height: (_x, z) => -z * 0.18 });
    const car = spawn('sedan', 1.4);
    simulate(car, env, 6);
    // Downhill is +z here, so gravity should carry the car forward.
    expect(car.body.position.z).toBeGreaterThan(1.5);
  });

  it('keeps the chassis above the terrain', () => {
    const env = makeEnv({ height: 120 });
    const car = spawn('suv', 126);
    simulate(car, env, 5);
    expect(car.body.position.y).toBeGreaterThan(120);
  });

  it('burns fuel under load and makes no power when dry', () => {
    const env = makeEnv();
    const car = spawn('hatchback', 1.0);
    simulate(car, env, 1.5);
    car.controls.throttle = 1;
    simulate(car, env, 4);
    expect(car.fuel).toBeLessThan(car.spec.fuelCapacity);

    // Dry tank, properly at rest: full throttle must not move the car. Reset
    // the whole vehicle first, otherwise the driveline is still spinning at
    // the speed it reached above and would coast on its own stored inertia.
    car.resetToSpawn();
    car.controls.throttle = 0;
    simulate(car, env, 1.5);
    car.fuel = 0;
    car.controls.throttle = 1;
    const before = car.body.position.z;
    simulate(car, env, 4);
    expect(Math.abs(car.body.position.z - before)).toBeLessThan(0.8);
    // Dead engine: no idle floor, only whatever the barely-creeping wheels turn.
    expect(car.telemetry.engineRpm).toBeLessThan(car.spec.drivetrain!.idleRpm * 0.25);
  });
});

describe('motorcycle', () => {
  it('stays upright while riding in a straight line', () => {
    const env = makeEnv();
    const bike = spawn('motorcycle', 0.8);
    simulate(bike, env, 2);
    bike.controls.throttle = 0.5;
    simulate(bike, env, 6);
    expect(Math.abs(bike.body.roll)).toBeLessThan(0.35);
  });

  it('leans into a turn rather than staying level', () => {
    const env = makeEnv();
    const bike = spawn('motorcycle', 0.8);
    simulate(bike, env, 2);
    bike.controls.throttle = 0.7;
    simulate(bike, env, 4);
    bike.controls.steer = 1;
    simulate(bike, env, 3);
    expect(Math.abs(bike.body.roll)).toBeGreaterThan(0.08);
  });
});
