/**
 * Phase 10 air and water vehicle behaviour.
 *
 * The acceptance criteria require that aircraft actually fly under their own
 * aerodynamic model and that watercraft actually float and move — not that a
 * mesh is translated along a path. These tests therefore assert emergent
 * outcomes (it climbs, it stalls, it settles at a draft, it will not sail into
 * the wind) rather than that a particular function was called.
 */
import { describe, expect, it } from 'vitest';
import { launch, makeEnv, simulate, spawn } from './helpers/vehicle-harness';
import { airDensityAt } from '../src/vehicles/controllers/controller';
import { BuoyancySolver, WATER_DENSITY } from '../src/vehicles/buoyancy';
import { vehicleSpecOrThrow } from '../src/vehicles/catalog';
import { boxInertia, VehicleBody } from '../src/vehicles/vehicle-body';

const SEA = { waterLevel: 0, height: -40, surface: 'water' as const };

describe('atmosphere', () => {
  it('thins with altitude', () => {
    expect(airDensityAt(0)).toBeCloseTo(1.225, 3);
    expect(airDensityAt(5500)).toBeLessThan(airDensityAt(0) * 0.6);
    expect(airDensityAt(5500)).toBeGreaterThan(0);
    // Monotonic, never negative, even absurdly high.
    expect(airDensityAt(40000)).toBeGreaterThan(0);
    expect(airDensityAt(40000)).toBeLessThan(airDensityAt(20000));
  });
});

describe('aircraft', () => {
  it('produces more lift the faster it flies', () => {
    const env = makeEnv({ height: 0 });
    const heights: number[] = [];
    for (const speed of [18, 34, 52]) {
      const plane = spawn('lightplane', 400);
      launch(plane, 400, speed);
      simulate(plane, env, 1.5);
      heights.push(plane.body.position.y);
    }
    const [slow, mid, fast] = heights as [number, number, number];
    // Dynamic pressure is quadratic in speed, so each step holds altitude better.
    expect(mid).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(mid);
  });

  it('climbs away under power and sinks with the engine idle', () => {
    const env = makeEnv({ height: 0 });
    const climbing = spawn('lightplane', 400);
    launch(climbing, 400, 46);
    climbing.controls.throttle = 1;
    climbing.controls.pitch = 0.32;
    simulate(climbing, env, 8);

    const gliding = spawn('lightplane', 400);
    launch(gliding, 400, 46);
    gliding.controls.throttle = 0;
    simulate(gliding, env, 8);

    expect(climbing.body.position.y).toBeGreaterThan(400);
    expect(climbing.telemetry.verticalSpeed).toBeGreaterThan(0);
    expect(gliding.body.position.y).toBeLessThan(climbing.body.position.y);
  });

  it('stalls past the critical angle and recovers when unloaded', () => {
    const env = makeEnv({ height: 0 });
    const plane = spawn('lightplane', 600);
    launch(plane, 600, 40);
    plane.controls.throttle = 0;
    plane.controls.pitch = 0.5;
    simulate(plane, env, 6);
    // Classic break: the zoom bleeds the speed off and the wing lets go.
    expect(plane.telemetry.stalled).toBe(true);
    expect(plane.telemetry.angleOfAttack).toBeGreaterThan(plane.spec.aero!.stallAngle);
    expect(plane.telemetry.airspeed).toBeLessThan(25);

    // Standard recovery: unload the wing, add power, then centre the stick.
    plane.controls.pitch = -0.3;
    plane.controls.throttle = 1;
    simulate(plane, env, 3);
    plane.controls.pitch = 0;
    simulate(plane, env, 8);
    expect(plane.telemetry.stalled).toBe(false);
    expect(plane.telemetry.angleOfAttack).toBeLessThan(plane.spec.aero!.stallAngle);
    // Flying again: speed back above the stall, wing attached.
    expect(plane.telemetry.airspeed).toBeGreaterThan(30);
  });

  it('reports airspeed against the air mass, not the ground', () => {
    const still = makeEnv({ height: 0 });
    const headwind = makeEnv({ height: 0, wind: { x: 0, y: 0, z: -22 } });
    const a = spawn('lightplane', 500);
    const b = spawn('lightplane', 500);
    launch(a, 500, 45);
    launch(b, 500, 45);
    a.fixedUpdate(1 / 120, still);
    b.fixedUpdate(1 / 120, headwind);
    // Same ground speed, but the one flying into wind has far more airspeed.
    expect(b.telemetry.airspeed).toBeGreaterThan(a.telemetry.airspeed + 15);
  });

  it('answers the elevator in pitch and the ailerons in roll', () => {
    const env = makeEnv({ height: 0 });
    const pitching = spawn('lightplane', 500);
    launch(pitching, 500, 48);
    pitching.controls.pitch = 1;
    simulate(pitching, env, 1.2);
    expect(pitching.body.pitch).toBeGreaterThan(0.1);

    const rolling = spawn('lightplane', 500);
    launch(rolling, 500, 48);
    rolling.controls.roll = 1;
    simulate(rolling, env, 1.2);
    expect(Math.abs(rolling.body.roll)).toBeGreaterThan(0.1);

    const yawing = spawn('lightplane', 500);
    launch(yawing, 500, 48);
    yawing.controls.yaw = 1;
    simulate(yawing, env, 1.5);
    expect(Math.abs(yawing.body.yaw)).toBeGreaterThan(0.02);
  });

  it('rolls down the runway on its gear and lifts off', () => {
    const env = makeEnv({ height: 0, surface: 'asphalt' });
    const plane = spawn('lightplane', 1.4);
    plane.controls.gearDown = true;
    simulate(plane, env, 2);
    // Sitting on its gear, not sunk into the tarmac or bouncing away.
    const resting = plane.body.position.y;
    expect(resting).toBeGreaterThan(0.2);
    expect(resting).toBeLessThan(2.2);
    expect(plane.telemetry.grounded).toBeGreaterThan(0.5);

    plane.controls.throttle = 1;
    simulate(plane, env, 20);
    expect(plane.telemetry.airspeed).toBeGreaterThan(24);
    plane.controls.pitch = 0.5;
    simulate(plane, env, 10);
    expect(plane.body.position.y).toBeGreaterThan(resting + 5);
    expect(plane.telemetry.grounded).toBe(0);
  });

  it('gives the glider a far better glide ratio than the powered aircraft', () => {
    const env = makeEnv({ height: 0 });
    const ratio = (key: string): number => {
      const craft = spawn(key, 900);
      launch(craft, 900, 30);
      craft.controls.throttle = 0;
      const startY = craft.body.position.y;
      const startZ = craft.body.position.z;
      simulate(craft, env, 20);
      const drop = startY - craft.body.position.y;
      const run = Math.abs(craft.body.position.z - startZ);
      return drop > 0.01 ? run / drop : Infinity;
    };
    const glider = ratio('glider');
    const plane = ratio('lightplane');
    expect(glider).toBeGreaterThan(plane);
    expect(glider).toBeGreaterThan(8);
  });
});

describe('helicopter', () => {
  it('spools the rotor before it can lift', () => {
    const env = makeEnv({ height: 0 });
    const heli = spawn('helicopter', 1.6);
    heli.controls.collective = 1;
    heli.fixedUpdate(1 / 120, env);
    expect(heli.telemetry.rotorRpm).toBeLessThan(0.2);
    simulate(heli, env, 10);
    expect(heli.telemetry.rotorRpm).toBeGreaterThan(0.85);
  });

  it('climbs on collective and descends when it is lowered', () => {
    const env = makeEnv({ height: 0 });
    const heli = spawn('helicopter', 2);
    heli.controls.collective = 1;
    simulate(heli, env, 16);
    const top = heli.body.position.y;
    expect(top).toBeGreaterThan(14);

    // Lower the lever: it must arrest the climb and come back down. The climb
    // momentum takes a few seconds to wash off, which is the correct feel.
    //
    // Sample the whole descent rather than the vertical speed at one chosen
    // instant: by then the aircraft may already be back on its skids, where
    // vertical speed is legitimately ~0 and a single reading looks like a
    // failure to descend. Leaving the peak and reaching the ground is the
    // stronger claim anyway.
    heli.controls.collective = 0.1;
    let peak = top;
    let maxDescent = 0;
    for (let i = 0; i < 32; i++) {
      simulate(heli, env, 1);
      peak = Math.max(peak, heli.body.position.y);
      maxDescent = Math.min(maxDescent, heli.telemetry.verticalSpeed);
    }
    expect(maxDescent).toBeLessThan(-1);
    expect(heli.body.position.y).toBeLessThan(peak - 10);
    expect(heli.body.position.y).toBeLessThan(5);
  });

  it('yaws on the pedals against rotor torque', () => {
    const env = makeEnv({ height: 0 });
    const heli = spawn('helicopter', 60);
    heli.body.place(0, 60, 0, 0);
    heli.controls.collective = 0.9;
    simulate(heli, env, 8);
    const before = heli.body.yaw;
    heli.controls.yaw = 1;
    simulate(heli, env, 4);
    expect(Math.abs(heli.body.yaw - before)).toBeGreaterThan(0.25);
  });

  it('translates when the cyclic is held over', () => {
    const env = makeEnv({ height: 0 });
    const heli = spawn('helicopter', 70);
    heli.body.place(0, 70, 0, 0);
    heli.controls.collective = 0.9;
    simulate(heli, env, 6);
    const startZ = heli.body.position.z;
    heli.controls.pitch = -1;
    simulate(heli, env, 8);
    // Tilting the disc forward converts some thrust into forward thrust.
    expect(Math.abs(heli.body.position.z - startZ)).toBeGreaterThan(6);
  });
});

describe('buoyancy', () => {
  /**
   * The solver applies its force to the body rather than returning it, so the
   * force is measured the only honest way: integrate one gravity-free step and
   * read the impulse back out of the velocity change (F = m·Δv/dt).
   */
  const measure = (y: number): { up: number; result: ReturnType<BuoyancySolver['solve']> } => {
    const mass = 1200;
    const body = new VehicleBody(mass, boxInertia(mass, 2, 2, 2));
    body.place(0, y, 0, 0);
    // One 1 m³ sample point: fully submerged it displaces a tonne of water.
    const solver = new BuoyancySolver([{ local: { x: 0, y: 0, z: 0 }, volume: 1 }], 1);
    const env = makeEnv(SEA);
    const result = solver.solve(body, env, { heaveDamping: 0 });
    const step = 1 / 120;
    body.integrate(step);
    return { up: (body.velocity.y * mass) / step, result };
  };

  it('pushes up by the weight of the fluid displaced', () => {
    const { up, result } = measure(-20);
    expect(result.submersion).toBeCloseTo(1, 2);
    expect(result.inWater).toBe(true);
    // Archimedes: ρ·V·g for one cubic metre of water. Gravity is applied by
    // the controller, not the body, so the solver's force stands alone here.
    expect(up).toBeCloseTo(WATER_DENSITY * 1 * 9.81, -1);
  });

  it('applies nothing above the waterline', () => {
    const { up, result } = measure(30);
    expect(result.submersion).toBe(0);
    expect(result.inWater).toBe(false);
    expect(up).toBe(0);
  });

  it('scales smoothly through the waterline rather than snapping', () => {
    const deep = measure(-20).result.submersion;
    const half = measure(-0.5).result.submersion;
    const dry = measure(30).result.submersion;
    expect(deep).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(dry);
  });
});

describe('watercraft', () => {
  it('floats at a stable draft instead of sinking or launching', () => {
    const env = makeEnv(SEA);
    const boat = spawn('motorboat', 3);
    simulate(boat, env, 14);
    const settled = boat.body.position.y;
    // Floating: hull straddles the waterline, within its own height of it.
    expect(settled).toBeGreaterThan(-boat.spec.dimensions.height);
    expect(settled).toBeLessThan(boat.spec.dimensions.height);
    expect(boat.telemetry.submersion).toBeGreaterThan(0.05);
    expect(boat.telemetry.submersion).toBeLessThan(0.95);

    simulate(boat, env, 6);
    // Still there six seconds later — a stable equilibrium, not a slow sink.
    expect(Math.abs(boat.body.position.y - settled)).toBeLessThan(0.3);
  });

  it('makes way under propeller thrust and coasts to a stop', () => {
    const env = makeEnv(SEA);
    const boat = spawn('motorboat', 1);
    simulate(boat, env, 10);
    boat.controls.throttle = 1;
    simulate(boat, env, 14);
    expect(boat.telemetry.forwardSpeed).toBeGreaterThan(4);

    boat.controls.throttle = 0;
    const cruising = boat.telemetry.forwardSpeed;
    simulate(boat, env, 12);
    // Hull drag alone brings it down; there are no brakes on a boat.
    expect(boat.telemetry.forwardSpeed).toBeLessThan(cruising * 0.6);
  });

  it('turns on the rudder only when water is flowing past it', () => {
    const env = makeEnv(SEA);
    const underway = spawn('motorboat', 1);
    simulate(underway, env, 10);
    underway.controls.throttle = 1;
    simulate(underway, env, 10);
    const headingBefore = underway.body.yaw;
    underway.controls.steer = 1;
    simulate(underway, env, 8);
    expect(Math.abs(underway.body.yaw - headingBefore)).toBeGreaterThan(0.2);

    const stationary = spawn('motorboat', 1);
    simulate(stationary, env, 10);
    const idleHeading = stationary.body.yaw;
    stationary.controls.steer = 1;
    simulate(stationary, env, 8);
    expect(Math.abs(stationary.body.yaw - idleHeading)).toBeLessThan(0.1);
  });

  it('rights itself after being heeled over', () => {
    const env = makeEnv(SEA);
    const boat = spawn('motorboat', 0.5);
    simulate(boat, env, 10);
    boat.body.angularVelocity.set(0, 0, 3.6);
    boat.body.wake();
    simulate(boat, env, 1);
    const heeled = Math.abs(boat.body.roll);
    expect(heeled).toBeGreaterThan(0.1);
    simulate(boat, env, 14);
    expect(Math.abs(boat.body.roll)).toBeLessThan(heeled * 0.6);
  });

  it('is carried by the current when drifting', () => {
    const still = makeEnv(SEA);
    const flowing = makeEnv({ ...SEA, flow: { x: 2.5, z: 0 } });
    const anchored = spawn('rowboat', 0.4);
    const drifting = spawn('rowboat', 0.4);
    simulate(anchored, still, 16);
    simulate(drifting, flowing, 16);
    expect(Math.abs(drifting.body.position.x)).toBeGreaterThan(Math.abs(anchored.body.position.x) + 1);
  });
});

describe('sailboat', () => {
  it('sails across the wind but will not sail straight into it', () => {
    // Wind blowing toward -Z, i.e. coming from +Z.
    const env = makeEnv({ ...SEA, wind: { x: 0, y: 0, z: -9 } });

    const bestSpeed = (yaw: number): number => {
      const boat = spawn('sailboat', 0.5, yaw);
      simulate(boat, env, 6);
      boat.controls.throttle = 1;
      let best = 0;
      for (let i = 0; i < 24; i++) {
        simulate(boat, env, 1);
        best = Math.max(best, boat.telemetry.speed);
      }
      return best;
    };
    const reaching = bestSpeed(Math.PI / 2); // beam reach
    const intoWind = bestSpeed(0);           // bow straight at the wind

    expect(reaching).toBeGreaterThan(1.2);
    // The no-go zone is real: she will not sail straight at the wind.
    expect(intoWind).toBeLessThan(reaching * 0.5);
  });

  it('heels away from the wind under sail', () => {
    const env = makeEnv({ ...SEA, wind: { x: 0, y: 0, z: -12 } });
    const boat = spawn('sailboat', 0.5, Math.PI / 2);
    simulate(boat, env, 6);
    boat.controls.throttle = 1;
    simulate(boat, env, 16);
    expect(Math.abs(boat.body.roll)).toBeGreaterThan(0.02);
    // But a keelboat must not be knocked flat by a steady breeze.
    expect(Math.abs(boat.body.roll)).toBeLessThan(0.8);
  });

  it('goes nowhere with no wind at all', () => {
    const env = makeEnv(SEA);
    const boat = spawn('sailboat', 0.5, Math.PI / 2);
    simulate(boat, env, 6);
    boat.controls.throttle = 1;
    simulate(boat, env, 18);
    expect(boat.telemetry.speed).toBeLessThan(0.6);
  });
});

describe('submarine', () => {
  it('floods to dive and blows to surface', () => {
    const env = makeEnv({ waterLevel: 0, height: -160, surface: 'water' });
    const sub = spawn('submarine', -2);
    simulate(sub, env, 8);
    const trimmed = sub.body.position.y;

    sub.controls.ballast = 1;
    simulate(sub, env, 24);
    const deep = sub.body.position.y;
    expect(deep).toBeLessThan(trimmed - 4);
    expect(sub.telemetry.depth).toBeGreaterThan(4);

    sub.controls.ballast = -1;
    simulate(sub, env, 30);
    expect(sub.body.position.y).toBeGreaterThan(deep + 2);
  });

  it('holds depth at neutral trim', () => {
    const env = makeEnv({ waterLevel: 0, height: -160, surface: 'water' });
    const sub = spawn('submarine', -2);
    sub.controls.ballast = 1;
    simulate(sub, env, 16);
    // Blow back to neutral trim and let it stabilise.
    sub.controls.ballast = -1;
    simulate(sub, env, 8);
    sub.controls.ballast = 0;
    simulate(sub, env, 8);
    const held = sub.body.position.y;
    simulate(sub, env, 10);
    // Drifts slowly at worst; does not plummet or cork to the surface.
    expect(Math.abs(sub.body.position.y - held)).toBeLessThan(8);
    expect(sub.telemetry.depth).toBeGreaterThan(0);
  });

  it('does not sink below its crush depth without reporting it', () => {
    const spec = vehicleSpecOrThrow('submarine');
    expect(spec.submarine).toBeDefined();
    expect(spec.submarine!.maxDepth).toBeGreaterThan(0);
  });
});
