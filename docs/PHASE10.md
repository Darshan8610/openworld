# Wayfarer — Phase 10: Universal Vehicle Framework

**Status: implemented / unit- and integration-verified in Node (92 vehicle tests, 273 total).
Browser suite NOT executed — Playwright browsers cannot be downloaded in this sandbox.**

Phase 10 adds land, air and water vehicles to the streamed world: a shared
architecture for identity, seats, control, damage and persistence, with a
genuinely different physical model behind each vehicle category. Nothing here
moves a mesh along a path — every vehicle is a force model over a rigid body.

Phases 7 (buildings), 8 (NPCs) and 9 (water/weather) are owned elsewhere. This
phase consumes their future surfaces through explicit provider seams and works
correctly with those seams empty.

---

## 1. What Phase 10 adds

| System | Module | Summary |
|---|---|---|
| Vehicle data model | `src/vehicles/types.ts` | 7 classes, 3 domains; seat, wheel, drivetrain, aero, rotor, hull, sail and submarine specs; universal control input; telemetry. SI units throughout. |
| Rigid body | `src/vehicles/vehicle-body.ts` | 6-DOF semi-implicit Euler in canonical world doubles, gyroscopic term, sleep, NaN recovery, render interpolation. |
| Tyre model | `src/vehicles/tyre.ts` | Pacejka magic formula, friction ellipse, surface- and speed-dependent grip, low-speed softening. |
| Drivetrain | `src/vehicles/drivetrain.ts` | Torque curve, automatic/sequential gearbox, differential split, engine braking, soft rev limiter, ignition state. |
| Road vehicles | `src/vehicles/controllers/wheeled.ts` | Raycast suspension, anti-roll, weight transfer, steering with speed falloff, brakes, handbrake, chassis contact. |
| Motorcycles | `src/vehicles/controllers/motorcycle.ts` | Countersteer/lean controller and PD balance, distinct from the car model. |
| Aircraft | `src/vehicles/controllers/aircraft.ts` | Dynamic pressure, angle of attack, lift curve with post-stall flat-plate blend, induced + parasitic drag, control surfaces, static stability, flaps, retractable gear, propeller advance-ratio falloff. |
| Rotorcraft | `src/vehicles/controllers/helicopter.ts` | Disc-axis thrust at the hub, rotor spool, cyclic, collective, tail rotor vs reaction torque, translational lift, ground effect, anisotropic drag. |
| Landing gear | `src/vehicles/landing-gear.ts` | Free-rolling sprung legs reusing the road tyre model. |
| Buoyancy | `src/vehicles/buoyancy.ts` | Multi-point displacement, submersion fraction, heave damping. |
| Watercraft | `src/vehicles/controllers/watercraft.ts` | Anisotropic hull drag, submersion-gated propeller, flow-scaled rudder, righting moment, planing lift, seabed contact. |
| Sailing | `src/vehicles/controllers/sailboat.ts` | Apparent wind, no-go zone, sheet trim, heel, keel leeway resistance. |
| Submarines | `src/vehicles/controllers/submarine.ts` | Ballast integration, dive planes, depth reporting, crush depth. |
| Catalogue | `src/vehicles/catalog.ts` | 26 vehicles across all 7 classes; suspension rates derived from mass, not hand-tuned per entry. |
| Vehicle entity | `src/vehicles/vehicle.ts` | Identity, seats, entry/exit, fuel, damage, odometer, recovery, serialise/restore; implements `InteractionProvider`. |
| Streaming & lifecycle | `src/vehicles/vehicle-system.ts` | Deterministic streaming, simulation levels, entry/exit, origin rebasing, persistence diff. |
| Placement | `src/vehicles/placement.ts` | Per-cell deterministic planning on the Phase 3 road network, shoreline and open ground. |
| Environment seam | `src/vehicles/vehicle-environment.ts` | `WorldQueries` terrain plus a swappable water provider and wind vector. |
| Cameras | `src/vehicles/vehicle-camera.ts` | Six distinct rigs: chase, hood, cockpit, first-person, orbit, cinematic. |
| Audio hooks | `src/vehicles/vehicle-audio.ts` | 10 continuous channels and 7 discrete events derived from telemetry; no audio engine dependency. |
| Input mapping | `src/vehicles/vehicle-input.ts` | One control structure, per-class bindings, time-based axis ramping. |
| Persistence slice | `src/persistence/vehicle-store.ts` | Versioned envelope, strict validation, refuses newer formats, drops non-finite poses. |

~4,900 lines of implementation, ~1,400 lines of tests.

---

## 2. Why vehicles do not go through Rapier

Phase 10 runs a dedicated 6-DOF integrator in canonical world doubles, driven by
`WorldQueries` raycasts. This is a deliberate decision, not an omission:

1. **Rapier is lazily loaded WASM** and the world must work without it. A vehicle
   that only exists when a 4 MB optional download succeeds is not a core system.
2. **Rapier's streamed heightfield colliders only exist within ~430 m of the
   player.** A 90 m/s aircraft covers that in under five seconds. `WorldQueries`
   is analytic and unbounded, so terrain answers are correct anywhere.
3. **Raycast-suspension vehicles need a custom controller anyway.** No general
   rigid-body solver gives acceptable car handling without one.
4. **Determinism and testability.** The whole framework runs headless in Node
   with no WASM, which is why 92 tests can assert on real physical outcomes.
5. **Precedent.** `src/physics/rigid-body.ts` already keeps canonical doubles
   beside Rapier for exactly these reasons.

Collision against Rapier solid bodies remains an explicit, documented seam
rather than something faked. Vehicles currently collide with terrain and water.

---

## 3. Contracts this phase establishes

1. **Interaction archetype widened.** `InteractionProvider.archetype` and
   `InteractionContext.archetype` now take `InteractionArchetype { key, label }`
   instead of `ObjectArchetype`. `ObjectArchetype` satisfies it structurally, so
   no object code changed. This is the seam the Phase 6 contract anticipated
   ("NPCs, vehicles and buildings implement the same shape") and it lets
   `Vehicle` be a first-class interaction target without inventing a fake object
   archetype.
2. **Water is a provider, not a dependency.** `VehicleWaterProvider` is a plain
   `(x, z) => sample | undefined`. `NO_VEHICLE_WATER` is a real null provider:
   with it installed there is genuinely no water and boats rest on terrain.
   Phase 9 installs a real one through `VehicleSystem.setWaterProvider` without
   touching physics.
3. **Wind is injected, never invented.** `WorldVehicleEnvironment.setWind` is the
   single entry point. Until Phase 9 drives it the air is still, and sailing
   craft correctly make no way.
4. **Seats are control positions, not furniture.** A remote-piloted drone has a
   `driver` seat so taking control uses the same entry path as climbing in.
5. **A new vehicle class is a compile error, not a silent fallback.**
   `createController` and `VehicleInputMapper.apply` both switch exhaustively
   with a `never` default.
6. **Physics is on the fixed step, always.** `VehicleSystem.fixedUpdate` is
   called only from the game's fixed loop; `update` carries render interpolation
   and streaming and never advances the simulation. A test asserts this.

---

## 4. Per-class models

No two categories share a controller. What *is* shared is shared because it is
genuinely the same physics:

* `solveTyre` serves road wheels **and** aircraft landing gear.
* `BuoyancySolver` serves boats, sailboats and submarines.
* `WatercraftController` is the base for sailboats and submarines, which add
  sail force and ballast respectively.
* `WheeledController` is the base for motorcycles, which override steering,
  add a lean/balance controller, and change the chassis clearance.

### Road vehicles
Raycast suspension per wheel (3-iteration cast, bump stops), spring/damper
derived from corner mass, anti-roll bars, weight transfer through load-dependent
tyre forces, open/locked differential, surface-dependent grip, rolling
resistance, aerodynamic drag, and chassis-to-ground contact resolution.

Driven wheels are spun against their **effective inertia** — the wheel plus the
engine and gearbox reflected through the square of the current ratio. This is
real (it is why first gear resists a bump far more than top), and omitting it
also made the wheel-speed integration oscillate badly at 120 Hz.

### Aircraft
Forces: thrust along the body axis with propeller advance-ratio falloff; lift and
drag from `q = ½ρV²`, angle of attack, and a lift curve that blends to a
flat-plate response past the stall angle; induced, parasitic and stall drag.
Moments: elevator, aileron and rudder authority scaled by dynamic pressure;
static pitch and yaw stability restoring toward a **trim angle of attack**; and
aerodynamic damping about all three axes.

Lift and drag act at the centre of gravity with the pitching moment modelled
explicitly as `Cm(α)`. Applying them at an offset point *as well* double-counts
static margin and pins the trim point at zero lift — which is exactly the bug
that made every aeroplane mush into a permanent descent before it was fixed.

### Helicopters
Thrust along the rotor disc axis applied at the hub, so tilting the disc both
translates the aircraft and creates the correct pendulum moment. Rotor spool-up,
collective, longitudinal and lateral cyclic, main-rotor reaction torque opposed
by the tail rotor and pedals, translational lift, and ground effect. Drag is
anisotropic: the vertical plan area is far larger than the axial area, which is
what limits the rate of climb to a sane figure.

### Watercraft
Multi-point displacement buoyancy, anisotropic quadratic hull drag (a hull
slides forward far more easily than sideways), submersion-gated propeller
thrust, a rudder whose authority scales with the flow past it, a righting moment
from hull stability, planing lift above a threshold speed, and seabed contact.
Sailboats add apparent-wind sail force with a real no-go zone; submarines add
ballast and dive planes.

---

## 5. Streaming, origin and persistence

* **The body integrates about its centre of mass.** `VehicleBody.position` is
  the centre of mass, because that is the only point a free rigid body rotates
  about. Catalogue offsets — wheels, seats, buoyancy samples, the rotor hub,
  the aerodynamic centre — are authored against the *geometric* centre, which
  is where a modeller puts the origin, and `localPoint` bridges the two. One
  number per vehicle therefore moves every lever arm consistently, and
  `renderPosition` returns the geometry rather than the centre of mass, so the
  mesh will sit where it belongs.
* **Canonical coordinates throughout.** Every body lives in world doubles. A
  floating-origin rebase rewrites render transforms only — a test asserts that
  position, orientation and yaw are bit-identical across a 131 km rebase.
* **Simulation levels, not on/off.** Vehicles within `simulateRadius` step at
  the full fixed rate up to `activeBudget`; the rest are frozen but keep their
  state. The vehicle the player is driving is never budgeted out from under them.
* **Deterministic placement.** Vehicles are planned per canonical cell and only
  emitted when their position falls inside that cell, so every candidate has
  exactly one owner — no duplicates across boundaries, no gaps. Road and pullout
  placement walks the Phase 3 road corridors rather than scattering and snapping.
* **Diff-only persistence.** Only vehicles the player has moved, damaged,
  refuelled or occupied are stored. Unloading a changed vehicle banks its state
  first, so driving one somewhere and walking away keeps it there. Occupied
  vehicles are never streamed out.

---

## 6. Controls

| Key | Action |
|---|---|
| `Q` | Enter the nearest vehicle / exit the current one |
| `Y` | Cycle vehicle camera (chase → hood → cockpit → first-person → orbit → cinematic) |
| `W` / `S` | Throttle / brake-reverse (land, water) · nose down / up (air) |
| `A` / `D` | Steer (land, water) · roll (air) |
| `R` / `F` | Collective up / down (helicopter) · throttle trim (aircraft) · dive planes (submarine) |
| `Shift` / `Ctrl` | Handbrake (land) · rudder left/right (air) · ballast flood/blow (submarine) |
| `Space` | Brake |

`W` means "accelerate" in a car and "nose down" in an aeroplane. That difference
lives in `VehicleInputMapper`, not in the controllers.

---

## 7. Tests executed

`npx vitest run` — **273 passed, 24 files**, of which 92 are Phase 10:

| Suite | Tests | Covers |
|---|---|---|
| `tests/vehicle-physics.test.ts` | 22 | Rigid-body integration, tyre curve, drivetrain, road vehicle behaviour, motorcycle balance. |
| `tests/vehicle-aero-marine.test.ts` | 26 | Atmosphere, lift/stall/recovery, takeoff, glide ratio, rotor spool/climb/yaw, buoyancy, flotation, propulsion, rudder, righting, current, sailing, no-go zone, submarine ballast. |
| `tests/vehicle-system.test.ts` | 22 | Placement determinism and cell ownership, streaming budget, fixed-step isolation, entry/exit, origin rebasing, persistence diff and round-trip, save validation. |
| `tests/vehicle-interface.test.ts` | 22 | Camera rigs, audio channels and edge-triggered events, input mapping per class, catalogue integrity. |

Also executed: `npx tsc --noEmit` (clean) and `npm run build` (clean).

**Not executed:** the Playwright browser suite. Chromium cannot be downloaded in
this sandbox, so no claim is made about in-browser rendering. The production
build succeeds and every module transforms through Vite without error, but that
is not the same as a verified frame on screen.

### Defects the tests found and fixed

These were real bugs in the first implementation, caught because the tests
assert physical outcomes rather than that functions were called:

1. **Suspension damper sign inverted** — the car pumped energy in on rebound and
   settled 3.4 m above the ground instead of 0.65 m.
2. **Missing reflected driveline inertia** — wheel speeds oscillated between 8
   and 50 rad/s; the car crawled and shifted erratically.
3. **Tyre curve never fell off after its peak** — `magicFormula(0.8) >
   magicFormula(0.12)`, so there was no sliding regime at all.
4. **Vehicles slept through throttle input** — a parked car ignored the
   accelerator entirely.
5. **Aircraft elevator, rudder and both static-stability terms sign-inverted** —
   every aeroplane was divergently unstable in pitch and yaw.
6. **Aerodynamic static margin double-counted** — trim was pinned at zero lift,
   so no aircraft could hold altitude; the glider managed 2.6:1 instead of 37:1.
7. **No trim angle of attack** — wings restored to zero AoA, where they cannot
   carry their own weight.
8. **Helicopter drag isotropic with a 1.7 thrust margin** — a 74 m/s climb rate.
9. **Free-rolling wheels rang numerically** — undriven wheels oscillated several
   rad/s either side of the correct speed.
10. **Rev limiter never fired** — it compared against `maxRpm`, which the crank
    only approaches asymptotically, so wheelspin on ice ran away unbounded.
11. **`telemetry.slip` averaged all four tyres** — hiding a single lit-up wheel
    from skid audio and tyre smoke.
12. **Skid audio gated on vehicle speed** — a burnout from rest was silent.
13. **A dry tank only zeroed the throttle** — the engine kept idling; it is now
    a real ignition cut, so the engine reads zero rpm and drags on the driveline.
14. **The drone had no control position** and so could never be flown.
15. **`centreOfMass` was authored for all 26 vehicles and read by nothing.**
    The body now integrates about the centre of mass while attachment points
    stay authored against the geometric centre, so the offset changes every
    lever arm at once. This made the motorcycle bank to a realistic 34° in a
    corner instead of 5°, and it tracks its own equilibrium radius exactly
    (yaw rate 0.554 rad/s measured against `v/r` = 0.55 predicted).

---

## 8. Known issues and limitations

* **No vehicle meshes yet.** `VehicleSystem` creates a render anchor per vehicle
  and keeps its transform correct, but no geometry is attached — the renderer
  work belongs with `src/rendering/`. Vehicles are fully simulated, enterable and
  drivable; they are currently invisible. This is stated plainly rather than
  hidden behind a placeholder cube.
* **No vehicle-to-vehicle or vehicle-to-building collision.** Vehicles collide
  with terrain, water and the seabed. Solid-body collision is a declared seam
  waiting on Phase 7 colliders.
* **No in-browser verification.** See §7.
* **Sailboats carry strong weather helm** and will round up into the wind if
  nobody holds the helm. This is real behaviour but is currently untuned.
* **Wheeled vehicles have no ABS or traction control**, so full throttle on ice
  produces sustained wheelspin. Correct, but a driver aid would be kinder.
* **Upgrades are stored but undefined.** `PersistedVehicle.upgrades` round-trips
  a string list; no gameplay assigns meaning to it yet.

## 9. Performance

* Per vehicle per fixed step: one raycast per wheel (3 iterations each), one
  tyre solve per wheel, one body integration. A 4-wheeled car is roughly
  12 terrain samples per step, served by the `groundFast` 1.25 m cache.
* Budgets live in `CONFIG.vehicles`: 24 streamed, 6 simulated at full rate
  within 260 m, 1024 m cells at radius 1. Everything else is frozen — state
  retained, zero cost.
* Streaming plans at most 2 cells per tick, nearest first, so a fast vehicle
  never stalls a frame on world generation. The plan cache is bounded at 48
  cells and the audio event queue at 16 entries.
* The render path allocates nothing: camera poses reuse their vectors, and the
  audio hook mutates a fixed channel record.
* Full vehicle test suite runs in ~1.5 s; whole suite 24 files in ~14 s.

## 10. Next milestone

Vehicle rendering: procedural per-body meshes in `src/rendering/`, wheel and
rotor visual binding to `controller.wheels` / `rotorRate`, and dashboard
telemetry in the UI. After that, Phase 7 colliders unlock vehicle-to-building
collision through the existing `VehicleCollisionQuery` seam.
