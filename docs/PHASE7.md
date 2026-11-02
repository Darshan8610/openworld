# Phase 7 — Buildings & Interiors

## Baseline audit and scope

This work starts from `295f6e2`, the actual Phase 3 implementation, not from assumed
Phase 4–6 APIs. Before changes: 36 Vitest tests pass; TypeScript + Vite build pass.
The existing road field is a collection of analytic parallel corridors, not an
intersection graph. Terrain, ten vegetation batches, seven roadside prop batches,
worker generation, floating origin, URL sharing and both rendering backends exist.
There is **no** rigid-body engine, human controller, central entity registry,
interaction framework, or asset loader on this branch. Those belong to the agents
implementing Phases 4–6 and must not be duplicated here.

## Incremental integration design

```text
Existing Game composition root
  TerrainManager / terrain workers (unchanged ownership)
    TerrainField.buildings -> deterministic site reservations
    VegetationField -> excludes reserved building/entrance footprints
  BuildingManager
    BuildingPlacementField -> seed-local, canonical descriptors + bounded cache
    templates -> modular shell, rooms, furniture, stair and portal definitions
    BuildingVisuals -> shared merged geometry / PBR materials / hinged door views
    BuildingCollisionIndex -> canonical OBB queries + swept inspection camera
    navigation -> room/portal/stair graph in canonical coordinates
    BuildingState -> versioned door modifications only
    BuildingPorts -> physics / interaction / navigation / typed event adapters
  BuildingExperience -> optional development inspection UI / existing survey rig
```

The building manager is an actual scene subsystem, not a detached demonstration.
It streams around the same canonical observer as terrain, shares the existing
origin, receives fixed simulation ticks, and disposes resources explicitly. It
exports data and collision shapes without importing another agent's physics or
entity implementation. Its query index is not a replacement rigid-body engine.
The optional interior inspection camera is **not** the Phase 5 playable character.

## Migration sequence

1. Add pure template, placement, coordinate and navigation contracts, with tests.
2. Add bounded shell/interior streaming, collision queries and adapter lifecycle.
3. Add shared visuals, doors, transitions and inspection into the real world loop.
4. Test seed/quality/origin changes, room navigation, persistence and disposal.
5. Verify browser interaction on WebGL2, document remaining hardware validation.

## Ownership and integration contracts

`src/world/buildings/types.ts` defines canonical world-space adapter payloads.
All positions are metres in JS doubles; building-local geometry stays small.
Physics adapters create static/kinematic shapes and convert world coordinates to
their own physics-local origin. The central physics system, **not** this module,
rebases its bodies, so a rebase must never be applied twice. Rendering roots are
repositioned from canonical descriptors after each origin shift. Navigation nodes,
door identity and modification records never change during a rebase.

The Phase 4 registry can register each descriptor as a stable `building` entity.
The Phase 4 physics adapter consumes `upsertCollider` / `removeCollider`.
Phase 5 uses `roomAt`, `supportHeight`, collision queries, and navigation portals
rather than reading scene meshes. Phase 6 consumes door interaction bindings and
can replace the small namespaced browser persistence adapter with its save service.
Phase 8 consumes the explicit room/entrance/stair graph; no NPC AI is claimed here.
Audio zones are room metadata and transition events; there is no invented audio.

## Content and scope boundaries

The initial templates are generic, procedural architectural assets, not licensed
production building scans: a cabin, a workshop and a two-storey lodge. They are
enterable modular structures with genuine apertures, floors, solid walls, furniture,
stairs, roofs, and per-door collision. Template registration and authored canonical
placements are supported. Other building categories are future content, not empty
implementations. There is no invented story, character, settlement lore or dialogue.

## Implemented in this milestone

- **Modular content:** a 12 × 10 m cabin, 14 × 12 m workshop and 16 × 14 m,
  two-storey lodge. Walls are split around real door/window apertures; glazing,
  floor slabs, ceilings, roof meshes and furniture use the same material library.
  Doors rotate around actual hinges, not a visual-only state flag. The lodge has
  seventeen 0.2 m risers, a cut-out stairwell, upper landing and guard rails.
- **Canonical placement:** stable, versioned generated IDs at 640 m road stations,
  with seed-based station jitter and side/setback selection. Doors face the road.
  Road footprint checks and a conservative footprint/entrance terrain survey reject
  unsafe lots. Foundations extend below the surveyed ground; entry steps and porch
  share their render/collision definitions. The survey includes every graphics
  preset's finest terrain-grid vertices. Terrain height/noise is not rewritten.
- **Authored placement:** bounded, validated template IDs and canonical positions;
  duplicate, overlapping, buried and road-intersecting sites are rejected.
  Authored floors may rise at most 4 m above the site minimum, within the
  twenty-four-step external-access budget; road checks include footprint interiors. Worker
  vegetation excludes deterministic reservations. Runtime authored reservations
  filter the instance packer, invalidated even for a stationary observer.
- **Streaming/lifecycle:** shells, interiors, nearby collision and indoor lights
  have separate budgets. Hysteresis prevents doorway flicker. Loaded terrain's
  revision refreshes stationary observers. Seed reset, quality change, repeated
  origin shifts and teardown preserve or release the appropriate state/resources.
- **Usable simulation data:** canonical static/kinematic boxes, continuous
  conservative sweeps, sliding, explicit walkable support, door-gated room/entrance
  graphs, seventeen stair nodes, indoor/outdoor and acoustic-zone events. This is
  real collision/navigation data; a rigid-body backend and NPC navigator remain
  owned by the other phases.
- **Doors:** range/line-of-sight/cooldown validation; fixed-tick mesh and collider
  updates; navigation opening only after the leaf clears; observer anti-crush
  protection and an optional host occupancy test. Initial contact can move away;
  closing into an occupant reopens, while an opening leaf can wait for clearance.
  Rotated leaves and either swing direction are supported.
- **State:** versioned, seed-separated door deltas only. Corrupt/newer saves are
  reported and protected from overwrite; malformed IDs, types, duplicates and
  over-capacity records are rejected. Quota failures warn without crashing the
  world. Export/restore allows the Phase 6 save owner to take over.
- **Rendering:** shared geometry merged by material/stage, eleven PBR node
  materials, transparent windows, night-lit panes, bounded unshadowed indoor point
  lights and a pooled collision overlay. No new runtime dependency or art download.

## Controls and integration

Use **World settings → Inspect a nearby building**, or **F7** while the world canvas
is focused. In the explicitly labelled developer inspector: **WASD** move, drag to
look, **F** or the prompt button operates a door, **Q/E** inspect vertically, and
**F7** returns to survey. A normal horizontal approach also climbs the lodge's
stairs using explicit support; the inspector does not introduce a human model,
gravity solver or character animation. Closed leaves, walls, glazing and furniture
participate in its conservative camera collision. Exact-contact inward sweeps are
blocked while tangent movement and retreat remain possible.

A `building=<stable-id>` URL visits a generated porch while preserving the existing
seed, graphics, time, vegetation and renderer parameters. Normal route, biome,
quality and seed controls remain available. The optional `BuildingExperience`
bridge is removable without removing templates, simulation or public host ports.
See [BUILDING_INTEGRATION.md](BUILDING_INTEGRATION.md) for concrete adapter contracts,
[PHASE7-CHANGELOG.md](PHASE7-CHANGELOG.md) for the file inventory and
[ROADMAP.md](ROADMAP.md) for the parallel-agent boundaries and next phases.

## Resource and performance envelope

| Quality | Exterior range | Shells | Interiors | Indoor lights |
|---|---:|---:|---:|---:|
| Low | 1,100 m | 10 | 1 | 1 |
| Balanced | 1,600 m | 18 | 2 | 2 |
| High | 2,200 m | 28 | 3 | 3 |
| Ultra | 2,800 m | 36 | 4 | 4 |

Additional limits: 26 m interior entry / 42 m retention, 90 m collision activation,
0.4 s streaming refresh, 256 cached procedural site results, 64 authored sites,
512 saved door deltas and 6,000 pooled debug boxes. Custom content is limited to
32 templates, each at most 512 parts, 16 rooms, 16 doors and 128 navigation nodes.
Materials are validated; solid boxes support Y rotation only. The original fixed
120 Hz clock and bounded catch-up are unchanged. Scene roots convert canonical
coordinates to the shared GPU origin; the host physics owner rebases its own bodies
once, not through a second building-world rebase.

Latest production output: **61 transformed modules**, main JS **1,009.78 kB /
283.01 kB gzip**, worker JS **32.82 kB**, CSS **21.61 kB / 7.52 kB gzip**. Main JS at
baseline was 966.30 kB: approximately 43.48 kB uncompressed growth. Vite's measured
bundle stage was 522 ms in this environment; this is **not** a runtime FPS benchmark.
No package manifest or lockfile change is needed. Local browser tooling,
screenshots and diagnostic scripts are ignored, not shipped in Git.

## Validation

Executed in the actual repository (Chromium 153 software WebGL2 for browser work):

| Check | Actual result |
|---|---|
| Baseline `npm test` before implementation | 36/36 passed in 7 files |
| Final `npm test` | **69/69 passed in 11 files**, 7.05 s (33 new + 36 baseline) |
| Final `npm run build` | TypeScript `--noEmit` and Vite production bundle passed |
| Explicit `npx tsc --noEmit` | Passed during implementation; also runs in the final build |
| `git diff --check` | Passed; staged new files checked before commit |
| New building browser file | **5/5 passed**, 7.4 min, including keyboard stair ascent |
| Latest post-placement-hardening browser check | Entry/closed-contact/door passage passed again, 2.0 min |
| Existing world browser scenarios | **All 11 passed** in each of the two full-suite executions |
| Lint | No lint task configured; none claimed |

Browser coverage includes deterministic launch, closed-door collision and operation,
indoor entry, storage reload, interior unload/reload, large-origin rendering,
collision debug, normal settings entry, and actual ground-to-gallery ascent without
Q/E or test code moving the camera. The existing world scenarios exercise seed,
time, repeated streaming, quality, vegetation, biomes, wind/detail, routes, origin
shifts and Ultra post-processing. Manual WebGL2 screenshots of the common room and
upper gallery were also captured/reviewed; no page errors appeared in successful
building runs.

**Test history and timing caveat:** the two full 16-scenario runs each finished
15/16, with all existing regressions passing. An overstrict 45 s stair endpoint
expired although the UI had reached the gallery; a later run expired at the door
swing wait. That contact test had requested opening before momentum settled. The
browser tests now settle momentum before asserting an unobstructed swing, check the actual gallery
landing, and allow software-rendering-appropriate waits. Review also found and
fixed an exact-contact sweep boundary; it has a dedicated unit regression, as do
opening away from an observer, occupied-door recovery and rotated/negative-swing
leaves. The final complete building-file rerun was green, followed by the additional
entry rerun after authored-site hardening. **A single final all-green 16-scenario
run is not claimed**; the results above distinguish the full and focused runs.

Unit/integration coverage also checks deterministic/query-order/negative/far-world
placement, road-spanning authored footprints, unsafe foundation rejection,
vegetation reservations, seventeen stair supports, door-gated paths, stationary
terrain refresh, authored reservation invalidation, streaming hysteresis, repeated
rebases, port registration/cleanup, cache limits, shared buffer disposal, seed
separation, atomic restore validation and storage failure handling.

## Known limitations / not claimed complete

1. **Phases 4–6 are absent here.** Mock-port registration/cleanup and canonical data
   are tested, but no external rigid-body engine, central entity manager, playable
   human or generic interaction/save service has been attached. The optional
   `canMoveKinematic` host occupancy hook requires validation against that engine;
   without it, door anti-crush protection covers the passed observer only.
2. **Procedural architectural placeholder assets.** These are functional modular
   structures, not final scanned or commissioned building art. Only the three
   described categories ship. There is no animated furniture, elevators,
   destructibility, exterior district generator, inventory or NPC behaviour.
3. **Graphics matrix remains open.** Browser execution used Chromium + SwiftShader
   **WebGL2**, not hardware WebGPU. Existing WebGPU node-material compatibility and
   fallback ownership are retained; real-GPU WebGPU, shadows and long-run memory
   profiling are still required. Software rendering was slow/variable and is not a
   playable-hardware performance result. Indoor lights have no extra shadow maps;
   window illumination and acoustic metadata are not GI or an audio engine.
4. **Local foundations, not terrain terraforming.** Relief over 2.8 m is rejected.
   The near/fine-grid envelope is surveyed for all presets, but distant coarse
   terrain LOD appearance still needs a hardware visual pass. Other agents' future
   water, exclusion volumes, central entities and road intersections must be added
   to the site-validation adapter; the current road network has no intersections.
5. **Graph, not full NPC navigation.** There is explicit inside/entrance/stair
   connectivity and door gating, but no world navmesh, agent radius solver, crowd
   steering or route scheduler. The inspection sweep expands boxes conservatively;
   the Phase 5 controller must use host-engine capsule queries.
6. **Small modification store, not the full save game.** Door state is bounded and
   versioned; no general slot UI, cloud sync or arbitrary-object migration is
   supplied. Authored placements come from content registration, not door saves.
   Baseline layout/content changes require deliberately versioning generated IDs.

## Next integration milestone

Attach the Phase 4 canonical collider/entity adapter, drive streaming and door
occupancy from the Phase 5 player transform, and register door actions/save deltas
with Phase 6. Remove the developer inspection controls once those controls exist.
Then verify actual capsule passage, stair traversal, occupied doors and momentum
across repeated rebases with all agents' systems connected, followed by real-GPU
WebGPU/WebGL2 profiling and Phase 8 world-to-building NPC navigation.
