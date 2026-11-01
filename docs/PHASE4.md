# Wayfarer — Phase 4: Core Game Engine & Physics

**Status: implemented; unit/integration/type-check/build verified. Browser specs written
but not executed in this environment (no Chromium available) — see [Validation](#validation).**

Phase 4 does not add gameplay content. It converts the Phase 1–3 world (terrain, biomes,
vegetation, roads, sky, survey camera) into a **game engine**: a real physics simulation,
a world entity model with multilevel streaming, one authoritative world query service, a
typed event layer, and an ordering contract that every later phase plugs into.

Nothing from Phases 1–3 was replaced. Determinism, floating origin, worker streaming,
WebGPU/WebGL2 fallback and URL sharing are unchanged.

---

## 1. Audit of the pre-Phase-4 repository

Verified against source and tests, not against the README alone.

| Area | State before Phase 4 | Evidence |
|---|---|---|
| Renderer | WebGPURenderer + WebGL2 fallback, probe draw, AgX, post chain (GTAO on Ultra) | `src/rendering/*`, boot works in the existing browser suite |
| Terrain | Deterministic field, quadtree LOD 0–5, worker generation, atomic root swaps, LRU cache, skirts | `src/world/terrain-*`, `tests/streaming.test.ts`, `tests/terrain-generator.test.ts` |
| Biomes / vegetation | Continuous climate field, 10 instanced batches, wind, quality budgets | `src/world/biomes.ts`, `vegetation-*`, `tests/vegetation.test.ts` |
| Roads | Analytic seed-warped corridors, graded earthwork, draped lane/marking strips, 7 prop batches | `src/world/road-*`, `tests/roads.test.ts` |
| Floating origin | 2048 m rebase, listener-driven translation of terrain/vegetation/roads | `src/core/floating-origin.ts`, `tests/streaming.test.ts` |
| Loop | Fixed 120 Hz simulation, bounded catch-up, render interpolation | `src/core/fixed-loop.ts` |
| Player | **Survey camera only** — no character, no collision, no physics | `src/core/survey-camera.ts` |
| Physics | **None** | no engine dependency, no collision shapes anywhere |
| Entities | **None** — terrain tiles, plants and props were the only world objects | — |
| World queries | **Duplicated per subsystem** (terrain manager, road manager, vegetation field each answered their own) | — |
| Events | **None** — `Game` called subsystems directly | — |
| Persistence / audio / water / buildings / NPCs / vehicles | **Not present** (Phases 7–12) | — |

Two concrete findings from the audit that Phase 4 had to respect:

1. `TerrainManager` emits no event when a tile becomes visible; consumers poll
   (`activeTiles`, `revision`). The physics ground streamer therefore polls `revision`
   + a 0.25 s interval instead of requiring a refactor.
2. Road surfaces are *draped on the terrain triangles* (`road-geometry.ts`), so the
   physics ground is the road surface. No separate road collider is needed — a fact
   that matters for Phase 10 vehicle grip.

---

## 2. Physics engine decision

| Candidate | Verdict |
|---|---|
| **Rapier 3D 0.21 (`@dimforge/rapier3d-compat`)** | **Chosen.** Rust→WASM, f32 with double-precision API shims, heightfield + trimesh + convex + CCD + sensors + joints, `DynamicRayCastVehicleController` and `KinematicCharacterController` built in (needed by Phases 5/10), collision groups, deterministic step, runs in Node for tests. WASM is base64-inlined, so no extra asset fetch, no COOP/COEP requirement. |
| cannon-es | Pure JS, no WASM, but no heightfield/trimesh support of this quality, weak CCD, no character/vehicle controllers. Would have to be replaced by Phase 10. |
| ammo.js (Bullet) | Capable, but an emscripten build with an awkward object lifecycle, larger glue cost, no maintained TS types. |
| Jolt (WASM) | Excellent engine, immature JS bindings at the time of writing. |
| Custom | Rejected: writing a solver, broad-phase and CCD is not Phase 4 scope. |

Cost accepted: Rapier's chunk is **4.34 MB / 1.67 MB gzip**, loaded through a dynamic
`import()` after the world starts, so first paint is unaffected. If the load fails, the
game keeps rendering and reports `physics:unavailable` — physics is never a boot blocker.

---

## 3. Coordinate model (the critical part)

- Simulation addresses are **canonical world doubles** (unchanged from Phase 1).
- Rapier only ever sees **physics-local** coordinates: `world - origin.absolute`.
- Conversion happens at the `PhysicsWorld` boundary (`createBody`, `positionOf`,
  `setPosition`, `raycast`, `groundAt`), never inside gameplay code.
- On a floating-origin rebase (`PhysicsWorld.rebase`):
  1. every rigid body is translated by `-delta` with `setTranslation(..., false)` so
     sleeping bodies stay asleep and **velocities, angular velocities, joints and
     canonical poses are untouched**;
  2. kinematic bodies also get `setNextKinematicTranslation` so interpolation continues;
  3. `propagateModifiedBodyPositionsToColliders()` updates collider poses immediately;
  4. the fixed-step accumulator is reset (a teleport must not trigger catch-up).
- Query timing contract: Rapier rebuilds its broad-phase during `step()`. After a
  rebase or a teleport, ray/shape queries observe the **next stepped state**.
  `WorldManager` runs the ground streamer and the physics step in the same frame after
  a rebase, so gameplay never samples a stale query. This is documented in code, in
  `docs/ROADMAP.md`, and asserted by `tests/physics-ground.test.ts`.

`tests/physics.test.ts` proves the contract: after a 2048 m rebase the body's canonical
position is unchanged to 1 cm, linear velocity is unchanged, its local translation moves
by exactly `-2048`, and it keeps resting on the same ground afterwards.

---

## 4. Terrain colliders (`src/physics/ground-streamer.ts`)

- One `heightfield` collider per **finest visible terrain tile** near the player:
  radius **430 m**, `level >= 4`, at most **12 tiles**, 4 builds per update with a 6 ms
  per-frame budget.
- Heights come from the same worker-generated grid the renderer uses, so physics and
  visuals cannot disagree.
- Rapier heightfields are **x-major** (`ix * (nrows + 1) + iz`) while terrain grids are
  z-major (`iz * stride + ix`); the streamer transposes on the way in. This was found by
  a failing test, not by inspection, and is now locked by
  `tests/physics-ground.test.ts` ("matches the rendered terrain grid").
- Collider poses are fixed bodies in the physics frame, so a rebase translates them like
  any other body and no rebuild is needed for an origin shift.
- Colliders are dropped when the observer leaves the radius or the source tile object is
  replaced (seed/quality change).

Measured (Node, same WASM build): building 12 Ultra tiles (36-segment, 16,428 verts)
takes **3.5 ms**; stepping 12 terrain heightfields costs **0.021 ms** per fixed step.
Heightfield-vs-mesh surface agreement measured at **< 1 cm** over sampled cell interiors.

---

## 5. Entity model & streaming (`src/game/entity.ts`, `entity-registry.ts`)

Every future world object — NPCs, buildings, vehicles, pickups, water bodies — shares one
record: stable id, kind, canonical position, bounds, streaming priority, lifecycle,
persistence policy, optional visual / physics / simulation hook, and a serialisable
`state` bag. Nothing is stored twice.

Streaming levels: **0 full**, **1 reduced** (~15 Hz ticks), **2 background**
(data only), **3 dormant** (no visual, still addressable). Distance thresholds
(90 / 280 / 950 m) are applied first, then a nearest-first cascade enforces population
budgets (24 / 72 / 320) by *demoting* to the next coarser level rather than popping.
The player is always level 0 and never hidden. Dormant entities have
`visual.visible = false`.

Queries use a 64 m spatial hash; distance is measured to the entity **footprint**, so a
40 m building is "nearby" from 30 m away. `rebase(delta)` translates attached visuals by
`-delta` while canonical data stays put.

---

## 6. Events (`src/game/events.ts`)

Typed synchronous bus with `on`/`once`/`off`/`emit`, a bounded history ring, and per
handler error isolation (a throwing listener cannot break a dispatch). The event map is
extended by later phases through declaration merging — no bus changes needed.

Events actually emitted in Phase 4: `world:ready`, `world:origin-shifted`, `world:tick`,
`entity:spawned`, `entity:removed`, `physics:ready`, `physics:unavailable`,
`physics:collision`, `physics:budget-exceeded`, `world:seed-changed`,
`world:quality-changed`.

---

## 7. One world query (`src/world/world-query.ts`)

`WorldQuery` is the only place that answers *what is here?*: height, normal, slope,
biome, road formation (corridor/station/lateral/pullout/route name), surface class
(`asphalt | gravel | grass | soil | rock | snow | ice | water`), nearest road point and
the composite sample. Terrain answers come from streamed tiles, road answers from the
analytic network, so no second noise copy can drift.

Water is an explicit extension point (`registerWater`), intentionally empty until Phase 9
— `waterAt()` returns `undefined` rather than a painted fake.

`src/physics/materials.ts` maps every surface class to density, friction, restitution,
tyre grip and an impact id, giving Phases 9–12 one shared table.

---

## 8. Integration

| File | Change |
|---|---|
| `src/core/game.ts` | Creates the event bus and `WorldManager`; delegates per-frame streaming to `world.update()`; loads physics asynchronously and degrades gracefully; new `K` (collider debug) and `C` (test crate) developer shortcuts; world stats in `snapshot()`; `physics=0` URL parameter. |
| `src/ui/interface.ts` | New "SIMULATION" section: physics toggle (disabled with an explanation when unavailable), collider debug, "Drop test crate"; performance overlay now reports physics bodies/colliders/step time, streamed ground tiles and entity levels. |
| `src/config.ts` | `physics` (gravity, caps, ground streaming, budgets) and `entities` (distances, population caps) blocks. |
| `src/game/world-manager.ts` | Ordering: terrain → vegetation → roads → physics ground → physics → entity streaming → entity ticks → visual sync. Its dependencies are expressed as narrow interfaces (`TerrainStreamSource`, `RoadStreamSource`, `WorldStreamLayer`) so the whole frame can be integration-tested with real Rapier bodies and a stub renderer. |
| `src/physics/*` | Engine wrapper, materials, ground streamer, debug renderer. |
| `src/game/*` | Entity model, registry/streaming, event bus, world manager. |

Preserved exactly: seed determinism, quadtree streaming, worker pool, floating origin,
vegetation/road budgets, sky, post-processing, share URLs, WebGL2 fallback, existing
keyboard shortcuts and tests.

---

## 9. Developer tools

- **`K`** — collider wireframes (Rapier debug buffers → line segments; alpha dropped,
  fixed vertex budget, no allocation per frame).
- **`C`** — drop a real rigid-body crate in front of the survey camera. It is a physics
  body *and* a registered entity with a visual; capped at 24 and destroyed on seed change.
  This exists to prove terrain physics, contact response and rebasing in-app; it is a
  developer sandbox, not gameplay content.
- **`F3`** overlay now includes physics and entity budgets.

---

## 10. Validation

Executed in this environment:

```
npx tsc --noEmit          clean (strict, noUncheckedIndexedAccess, noUnusedLocals)
npm test                  12 files, 83 tests, all passing
npm run build             success (main 999.6 kB / 279 kB gzip; rapier chunk 4.34 MB / 1.67 MB gzip, lazy)
```

New tests (47 of the 83; the other 36 are the unchanged Phase 1–3 suite):

| File | Tests | Covers |
|---|---|---|
| `tests/physics.test.ts` | 12 | gravity/rest, fixed-step catch-up, ice-vs-asphalt friction, sensors excluded from rays, ground probe, **origin rebase preserves pose+momentum+rest**, body budget cap + event, collision events, CCD tunnelling, non-finite pose rejection, collision-group packing, debug buffers + disposal |
| `tests/physics-ground.test.ts` | 7 | heightfield build, **grid agreement < 1 cm**, mesh-triangle agreement, body lands on streamed terrain, **collider alignment through rebase**, collider eviction, nearest-tile cap |
| `tests/entities.test.ts` | 15 | registry CRUD, footprint queries, cell re-indexing, level cascade, player always full, dormant visual hiding, 15 Hz reduced ticks, visual rebase, stats, event bus semantics |
| `tests/world-query.test.ts` | 6 | height/normal/slope/biome authority, undefined outside streaming, surface classification (asphalt/gravel/off-road), road snapping, composite sample, water extension point |
| `tests/world-manager.test.ts` | 7 | one ordered update per frame, no stepping before the world is ready, crate = body + entity + visual with a pose-locked visual that lands on the terrain, sandbox cap with removal events, seed reset clearing entities/bodies/collider bookkeeping, physics disable freezing simulation without unloading, origin rebase keeping canonical position and re-framing visuals |

**Not executed here:** `tests/browser/phase4.spec.ts` (4 specs: physics boot on streamed
terrain, crate spawn, collider overlay toggle, rebase stability). Playwright requires a
Chromium binary that this sandbox cannot download, so these were written to the existing
harness but not run. They must be run with `npm run test:browser` before release.

Also unverified here: WebGPU-specific behaviour. Physics is renderer-agnostic (WASM +
CPU), but the WebGPU path itself was only exercised by the Phase 3 suite previously.

---

## 11. Known limitations (explicit, by design)

- **No playable character** — the survey camera remains the only player view until Phase 5.
- **No collision geometry for vegetation, props or buildings** — only terrain is solid
  until those systems exist (a physics collider without a gameplay owner would be a fake).
- Physics bodies are not streamed by distance yet; the cap (640) plus Rapier sleeping is
  the Phase 4 guard. Entity streaming will own body lifecycle in Phase 7+.
- The heightfield represents terrain, not water; buoyancy and swimming are Phase 9.
- Reduced-fidelity ticks run at ~15 Hz; there is no background-state simulation loop yet
  (level 2 is data-only until Phase 8 defines what "background" means per entity kind).
- Rapier's broad-phase refresh means queries after a teleport are one step stale; the
  frame ordering guarantees this is invisible to gameplay, and it is documented above.
- No persistence yet, so entity `state` is populated but not saved (Phase 11).

---

## 12. Next milestone — Phase 5 (Playable Character)

Rapier's `KinematicCharacterController` is available and already exercised by the wrapper
API surface needed for it (`raycast`, `groundAt`, capsule colliders, collision layers).
Phase 5 will add: a character capsule controller on the fixed step, coyote time/jump
buffering, slope + step handling, a third-person camera with collision avoidance, and the
animation/asset pipeline (GLTF) — with the first real consumer of entity level 0 and
`WorldQuery.surfaceAt()` for surface-dependent movement.
