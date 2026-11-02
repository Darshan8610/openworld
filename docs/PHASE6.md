# Wayfarer — Phase 6: World Objects & Interactions

**Status: implemented / unit-verified / browser suite not executed in this sandbox.**
Phase 6 turns the streamed world into a place you can touch: deterministic,
streamed, physics-backed objects with context-sensitive interactions, a typed
game-event layer, a unified world-query facade, and a versioned persistence slice
for object and inventory state.

The survey rig remains the camera. Walking, jumping, swimming and vehicle entry
belong to Phases 4–5 and 10; Phase 6 is the object/interaction/physics-prop layer
those phases plug into.

---

## 1. What Phase 6 adds

| System | Module | Summary |
|---|---|---|
| World coordinates | `src/core/coordinates.ts` | One `WorldPoint` contract; canonical doubles in, origin-relative out. |
| Typed events | `src/core/events.ts` | `GameEventBus` with payload map, `once`, error isolation, bounded history. |
| Spatial index | `src/core/spatial.ts` | Uniform hash grid; radius and box neighbourhood queries. |
| Entity model | `src/core/entities.ts` | Stable ids, kind, canonical position, bounding radius, streaming bands, persistence policy, lifecycle, simulation level. |
| Query facade | `src/world/world-queries.ts` | Height, normal, slope, biome, road space, surface material, ground sample. |
| Physical materials | `src/physics/materials.ts` | 15 surfaces with friction, restitution, density, damping, walkability, speed-dependent grip. |
| Prop rigid bodies | `src/physics/rigid-body.ts` | Fixed-step boxes/spheres, orientation-aware support height, impulses, sleeping. |
| Prop physics world | `src/physics/prop-physics.ts` | Budgeted body registry, substeps, pair contacts, raycast, radial push, stats. |
| Interaction core | `src/interaction/targeting.ts`, `manager.ts`, `types.ts` | Aim-cone + reach targeting, hold-to-confirm actions, conditions, cooldowns, events. |
| Inventory | `src/interaction/inventory.ts`, `src/objects/items.ts` | Generic item catalogue, stacks, slot budget, restore. |
| Object data | `src/objects/archetypes.ts`, `actions.ts` | 16 archetypes across 9 behaviour kinds; actions are data, not per-object code. |
| Placement | `src/objects/placement.ts` | Deterministic per-cell planning: caches, rest areas, utilities, wild scatter. |
| Streaming | `src/objects/object-system.ts` | Budgeted nearest-first streaming, physical bodies, providers, persistence diff. |
| Object renderer | `src/rendering/object-geometry.ts` | Merged vertex-coloured procedural meshes plus animated pivots (door, lid, lever, valve, switch, lamp, sign atlas). |
| Persistence slice | `src/persistence/object-store.ts` | Versioned envelope, strict validation, sanitising load, refuses to overwrite unknown formats. |

---

## 2. Coordinate and origin contract

* **Canonical space** — every entity, body and placement stores absolute world
  metres (`x`, `y`, `z`) in JS doubles. Physics integrates here, so an origin
  rebase cannot change momentum, velocity or any object's world position.
* **Render space** — meshes are positioned as `canonical - origin` every frame
  (`ObjectInstance.syncVisuals`) and immediately after a rebase
  (`ObjectSystem.rebase`). Nothing stores a render-space position.
* **Queries** — `WorldQueries` wraps one `TerrainField` per seed, so height,
  surface and road answers are identical to the worker-generated mesh and are
  independent of LOD.
* **Seeds** — changing the seed rebuilds the queries, physics world, inventory
  session, interaction manager and object system (`Game.rebuildGameplayLayer`),
  keeping one world per set of systems.

Validation: `tests/physics.test.ts` (momentum, long-run stability) and
`tests/object-system.test.ts` (rebase leaves canonical positions untouched;
render transforms equal `canonical - origin`).

---

## 3. Entity and streaming model

`EntityRegistry<D>` stores simulation data only — no meshes, no colliders:

```text
id            stable, seed-derived (e.g. obj.cache.0.12 / obj.rest.1.2.gate)
kind          object | npc | vehicle | building | water | landmark
archetype     data key (supply-crate, field-lamp, access-gate …)
position      canonical WorldPoint (mutable, double)
radius        bounding radius for coarse queries and culling
radii         full / reduced / background streaming bands
persistence   transient | session | world
priority      budget tie-breaker
data          simulation-owned payload
state         active | dormant | disposed
level         full | reduced | background | culled
```

`simulationLevelFor(distance, radii)` bands distance; `updateLevels()` returns only
entities that changed band. Phase 6 uses the registry contract for object
definitions; `ObjectSystem` owns the object instance lifecycle on top of the same
model. NPCs (Phase 8) and vehicles (Phase 10) implement the same record shape and
reuse `SpatialGrid`.

Objects stream per canonical 512 m cell:

* nearest-first cell order, 2 cells in every direction by default (25 cells);
* a fixed per-tick planning budget (6 uncached cells) so a fast camera never
  stalls a frame on noise evaluation;
* placement plans are cached per cell (bounded LRU) and are pure functions of
  `(seed, cell)`;
* a per-preset object budget (`QUALITY[*].objectBudget`: 28 / 56 / 88 / 128)
  truncates the active set; truncation is reported in the stats;
* unloading disposes visuals, unregisters providers and removes rigid bodies.

Every active object registers an `InteractionProvider` and, if dynamic, exactly
one rigid body. Bodies are capped per preset (`physicsBodies`: 20 / 40 / 64 / 96)
and reported as `physicsSkipped` if the cap is hit.

---

## 4. Deterministic placement

`planObjectCell(cellX, cellZ, { seed, queries })` returns objects whose canonical
position lies inside that cell — so each candidate is produced by exactly one
cell owner (no duplicates across borders, no gaps).

Families:

| Source | Rule |
|---|---|
| `road-cache` | Every 384 m along each corridor, off the shoulder at 9.4–12 m lateral, one of eight supply archetypes, plus a secondary item. Every third cache gets a lamp + switch pair. |
| `wild` (posts) | Every 768 m, 17–26 m off the corridor: survey markers. |
| `pullout` | At every 1536 m overlook: bench, trail gate, trail sign, supply crate, medical case. |
| `utility` | Service valve and signal lever at the rest area; lamp/switch at caches. |
| `wild` (scatter) | Up to 5 attempts per cell, filtered by slope and road distance. |

Hard rules enforced by the planner (and tested):

* `|lateral| >= 8.6 m` — never on the carriageway, shoulder or graded formation;
* static props require `slope <= 0.34`, so foundations do not tilt or float;
* minimum spacing of 1.15 m between objects in the same cell;
* props face the road when within 26 m of it.

Authored content coexists: `ObjectSystem.addAuthored([{ id, archetype, x, y?, z, yaw?, state? }])`
accepts stable world coordinates and is merged into the stream every tick.
A missing `y` is resolved from the world height field, so authored landmarks
cannot float above the terrain.

---

## 5. Object catalogue and behaviour

Nine behaviour kinds drive every archetype:

| Kind | Actions | State |
|---|---|---|
| `door` | Open / Close (hold 0.15 s) | `open` |
| `container` | Open (seeds deterministic contents) → Take | `opened`, `contents[]` |
| `pickup` | Take (hold 0.25 s), removed on success | `collected` |
| `switch` | Switch on / off | `on` |
| `lamp` | Turn on / off (emissive + bloom) | `on` |
| `lever` | Pull / Reset | `used` |
| `valve` | Turn (hold 0.6 s, 0–4 positions) | `level` |
| `seat` | Sit / Stand (emits `player:seated` / `player:stood`) | `seated` |
| `sign` | Read (toast with sign text) | `visited` |

Archetypes: supply crate, ration box, medical case, fuel drum, tool kit, spare
parts, water flask, lantern cell, survey post, field lamp, utility switch, service
valve, signal lever, trail gate, bench, trail sign.

Container contents are deterministic per object id (`seededRandom(hashSeed(id))`),
so the same crate always holds the same supplies in the same seeded world.

Every action mutates `ObjectState` only, and every mutation flows through
`ObjectSystem.onInstanceStateChanged` → persistence + `object:stateChanged`.
New archetypes cost one entry in `ARCHETYPES`; new behaviour costs one `case` in
`actionsFor`. No object-specific code lives in the streaming layer.

---

## 6. Interaction pipeline

```text
fixed step (120 Hz)
  rig pose ──► ActorView (eye position, forward, yaw)
  ├─ selectTarget(providers, view, { maxRange, cone, proximity })
  │     aimed:   cos(angle) ≥ cos(cone)  → score = alignment·2 − surfaceDistance·0.12
  │     reach:   surfaceDistance ≤ proximityRadius → usable without aiming
  ├─ InteractionManager.update(dt, actor, { pressed, down })
  │     pick first available action, accumulate hold time, execute once, cooldown 0.15 s
  └─ outcome → toast, typed event, provider state, HUD prompt (progress bar)
```

* Input: `E` (press or hold), read from the existing `Input` layer; `O` toggles
  the object layer.
* Targeting accounts for target radius, so large objects are usable from their
  surface.
* Conditions live on the action (`available(state, inventory)`), so prompts never
  offer impossible actions.
* Providers are an interface, not a class hierarchy: NPCs, vehicles and buildings
  can be targeted by implementing `centre`, `radius`, `range`, `targetLabel`,
  `actions()`, `state()`, `setState()`, `remove()`.

Manual flight ground clearance was reduced from 12 m to 2.6 m so the survey rig
can descend next to props; the scenic tour and route survey still fly at 45 m /
7 m. This is an inspection affordance, not the player controller — Phase 5 brings
the character that will occupy the same interaction contract.

---

## 7. Physics

`PropPhysicsWorld` is the prop solver and the swap-in seam for Phase 4's world
physics. It exposes bodies, impulses, raycasts, radial pushes, ray/contact stats
and a capacity ceiling; nothing in gameplay reads solver internals.

* Fixed 1/120 s substeps with an 8-substep catch-up cap — never tied to FPS.
* Gravity 9.81 m/s², mass from explicit kg or volume × material density.
* Resting contact removes the normal velocity component and keeps the tangential
  one, so gravity on a slope produces real downhill slide; Coulomb friction then
  removes `μ·g·dt` of tangential speed.
* Orientation-aware support height (projected half-extents) means a box landing on
  an edge rests on that edge; sleeping settles near-upright boxes flat.
* Body-body: positional correction plus normal impulse with combined restitution,
  then tangential friction impulse. Only awake bodies initiate pairs.
* Bodies sleep after 0.55 s below 0.16 m/s and 0.5 rad/s, and wake on impulse,
  push, contact or interaction focus.
* Speed is clamped to 70 m/s, which is the CCD substitute for this body class
  (props are small and slow; tunnelling is prevented rather than solved).
* `groundFast` memoises the height/surface sample on a 1.25 m lattice so the
  120 Hz loop does not evaluate terrain noise per body per substep.

Surface response is material-driven: `combineFriction(a, b) = √(μa·μb)`, so a
metal drum on ice (0.17) stops in a fraction of the distance it needs on asphalt
(0.71). `gripFor()` adds speed-dependent grip loss for the vehicle phase.

The physics debug surface is the stats block plus `raycast`, `pose` and
`wakeNear`; there is no physics debug renderer yet (see limitations).

---

## 8. Persistence slice

`ObjectStateStore` writes a versioned envelope:

```json
{ "format": "wayfarer.objects", "version": 1, "seed": "…", "savedAt": 0,
  "objects": { "obj.cache.0.12": { "archetype": "supply-crate", "state": { "opened": true, "contents": [] } } },
  "inventory": [{ "itemId": "tool-kit", "count": 1 }] }
```

* Only non-default state for persistence-eligible objects is stored — the
  deterministic baseline is never written.
* Loading sanitises every field (types, valve range 0–4, valid stack counts);
  unknown fields are dropped rather than trusted.
* Invalid JSON, a foreign format, a missing version or a missing object table
  produces an `invalid` result with a reason; the game surfaces it as a toast and
  keeps running.
* A save with a **newer** version is never overwritten: `save()` returns
  `refused` and the file is left untouched.
* Collected objects are never respawned from a restored save.
* Writes happen on a 4 s debounce after a state change and on teardown
  (`pagehide`/dispose). Storage unavailability is reported, not thrown.

This is deliberately a slice, not the save system: Phase 11 owns save slots, the
player, vehicles, weather and mission state. Its envelope format and validation
approach are the pattern to follow.

---

## 9. Events

`GameEventMap` currently carries: `object:spawned`, `object:despawned`,
`object:stateChanged`, `object:interacted`, `interaction:targetChanged`,
`item:collected`, `inventory:changed`, `player:seated`, `player:stood`,
`player:enteredWater`, `player:exitedWater`, `player:enteredBuilding`,
`player:exitedBuilding`, `world:originRebased`, `world:objectsReset`,
`physics:bodySlept`, `physics:bodyWoke`.

Handlers run synchronously with exceptions isolated; a bounded history (64) is
kept for tooling. Audio (Phase 12), missions (Phase 11) and NPC reactions
(Phase 8) subscribe here instead of calling into gameplay systems.

---

## 10. UI

* Context prompt (`#interaction`): target name, action label, `E`/`HOLD` key chip
  and a hold-progress bar. Updated at 120 Hz but only touches the DOM on change.
* Pack panel in the settings drawer: item label + count, driven by
  `inventory:changed`.
* Settings: “World objects” switch (`O`), plus the existing Phase 1–3 controls.
* Share URL gains `objects=0|1`; `vegetation`, `roads`, `postfx`, `route`, seed,
  position, hour and quality are unchanged.
* Performance overlay adds streamed objects, rigid bodies (awake/asleep),
  inventory total and current interaction target.

---

## 11. Validation

Executed in this sandbox:

| Command | Result |
|---|---|
| `npm run build` (`tsc --noEmit` + `vite build`) | **pass** — 46 modules, ~1.02 MB JS bundle |
| `npm test` (Vitest) | **96 passed / 96** across 12 files (36 pre-existing + 60 new) |

New suites:

* `tests/interaction.test.ts` (15) — aim cone vs proximity, radius-aware reach,
  hold-to-confirm progress and cancellation, cooldown, conditional actions,
  pickup collection, target-change events, deterministic container contents.
* `tests/physics.test.ts` (12) — material ordering/combination, gravity landing,
  momentum under rebase, ice vs asphalt stopping distance, bounce and damping,
  pair separation, budget/truncation, speed clamp, raycast, radial push, 30 s
  stability with no state creep.
* `tests/objects.test.ts` (14) — archetype consistency, deterministic placement,
  cell ownership, road clearance, unique ids across cells, inventory stacking and
  budgets, persistence round-trip, corruption/newer-version refusal, state
  sanitising, unavailable storage.
* `tests/entities.test.ts` (12) — spatial grid radius/box
  queries and re-homing, streaming bands, registry lifecycle, typed events with
  error isolation and bounded history, canonical→render conversion.
* `tests/object-system.test.ts` (7) — headless streaming integration: providers
  and bodies match the active set, budget truncation, origin rebase keeps
  canonical state, collected objects never respawn, disable/enable teardown, a
  real streamed container can be opened and emptied through the interaction
  pipeline and persists as a diff.

**Not executed:** `npm run test:browser`. Playwright's Chromium download is
blocked in this sandbox (`npx playwright install chromium` fails with a download
error), so the three new browser tests added to `tests/browser/world.spec.ts`
(streamed objects + physics + prompt; object toggle; `objects=0` boot) are
**unverified here** and must be run on a machine with Chromium:

```bash
npx playwright install chromium
npm run test:browser
```

No WebGL/WebGPU rendering of the new object meshes has been observed in this
sandbox either; the app was verified by type-check, production build and the
headless streaming tests only.

---

## 12. Known limitations

* **No character yet.** Interaction is driven by the survey rig; range (6.5 m)
  and aim cone (17°) are tuned for a camera that can now descend to 2.6 m.
  Player-owned movement, animation and body collision arrive in Phase 5.
* **Prop physics is not the world physics engine.** Terrain contact is a
  heightfield sphere/box approximation with a normal-up assumption; there is no
  mesh-mesh collision, no joints/constraints and no rigid-body contact with
  buildings (Phase 7) or vehicles (Phase 10). Phase 4's engine should replace the
  internals behind `PropPhysicsWorld`, keeping `add/remove/step/raycast/stats`.
* **Prop visuals are procedural placeholders,** deliberately stylised and clearly
  identified as such; the GLTF/GLB asset pipeline is Phase 13 work.
* **No doors into buildings yet.** `access-gate` is a gate, not a building door;
  interior doors, room connectivity and interior streaming belong to Phase 7, and
  the interaction/state/persistence contract they need already exists.
* **No footstep/impact audio and no interaction animation** — Phase 5 (character)
  and Phase 12 (audio) own those; the events they need are emitted.
* **Sit action is state-only.** It sets persistent `seated` and emits
  `player:seated`; the camera does not yet enter a seated pose.
* **Object state is per seed in `localStorage`;** no slots or export yet (Phase 11).
* **No physics debug renderer.** Bodies are inspectable through `stats`,
  `pose`, `raycast` and the snapshot hook, not drawn.
* **Streaming warm-up:** because planning is budgeted, a just-teleported camera
  fills its object set over a few 0.3 s ticks rather than instantly.

---

## 13. Next phase

The interaction, physics and persistence contracts are now in place for:

* **Phase 5 (character)** — implement `ActorView` from the character controller
  and call `physics.push()` for body shoves.
* **Phase 7 (buildings/interiors)** — doors and containers already have state,
  save slots and actions; interiors should register as streaming cells with their
  own `EntityRegistry` and reuse `InteractionProvider`.
* **Phase 8 (NPCs)** — implement `InteractionProvider` plus the registry/streaming
  bands, and subscribe to `object:*` and `interaction:*` events for reactions.
* **Phase 10 (vehicles)** — register `enter/exit` as actions on a vehicle
  provider; occupant state already has an event channel.
* **Phase 11 (save slots)** — lift the `ObjectSave` envelope into the full save
  format and keep the validation and version-refusal rules.
