# Wayfarer — Infinite Open-World Game

**Phases 1–9 combined: a seeded, infinite world you can walk, swim, inspect and touch.** Five climate-blended biomes, ten instanced vegetation/rock layers, graded scenic highways, streamed terrain physics, a playable animated character, interactive world objects with persistent state, carved lakes and rivers with a shared wave surface and buoyancy, a seeded weather front, and an Ultra graphics preset — over a chunk-streamed landscape with a floating origin and a fixed 120 Hz simulation.

Built on Three.js r187, TypeScript, Vite, WebGPU + WebGL2 fallback, Web Workers and Rapier 3D.

> This branch carries the Phase 4 (engine/physics), Phase 5 (playable character), Phase 6 (objects/interaction) and Phase 9 (water & environment) lines. Vehicles, buildings, NPCs, audio, missions and the story layer remain later phases — see [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed by Vite (default `http://localhost:5173`). WebGPU requires HTTPS or localhost; the app automatically falls back to WebGL2 when WebGPU is unavailable or fails a probe draw.

```bash
npm run build         # type-check + production build
npm run preview       # serve the production build
npm test              # 225 unit/integration tests across 27 files
npm run test:browser  # Playwright browser tests (requires Chromium)
```

For browser tests, install Chromium once:

```bash
npx playwright install chromium
```

## Controls

**On foot (default view)**

| Input | Action |
|---|---|
| WASD / arrows | Move, camera relative |
| Mouse drag | Look around (Esc releases pointer lock) |
| Shift | Sprint |
| Alt | Walk |
| Ctrl | Crouch |
| X | Strafe lock (face the camera) |
| Space | Jump |
| F | First / third person |
| Z | Swap shoulder |
| C | Switch to the survey camera |
| E | Interact / hold to confirm |
| Mouse wheel | Camera zoom |

**Survey camera (inspection)**

| Input | Action |
|---|---|
| WASD / arrows | Fly horizontally |
| Q / E | Descend / ascend |
| Shift | Boost |
| Mouse wheel | Adjust cruise speed |
| T | Toggle scenic auto-flight |
| G | Start/stop the nearest scenic route survey |
| C | Switch back to the character |

**Both views**

| Input | Action |
|---|---|
| R | Reset viewpoint / return to spawn |
| P | Pause/resume day cycle |
| V | Toggle vegetation |
| O | Toggle interactive world objects |
| B | Toggle biome overlay |
| L | Toggle LOD debug colors |
| H | Hide/show HUD |
| F3 | Performance overlay |
| K | Physics collider wireframes (developer) |
| X | Drop a physics test crate (developer, while using the Rapier sandbox) |
| J | Toggle the water surface |
| N | Cycle the weather override (auto → clear → cloudy → rain → storm → fog → snow → blizzard) |

The settings panel exposes the world seed, time-of-day slider, day-cycle toggle, graphics preset (Low / Balanced / High / Ultra), player view (on foot / survey camera), first-person camera, look sensitivity, shoulder swap, respawn, vegetation, roads, interactive objects with the player pack readout, wind, surface detail, water surfaces with a live status line, weather selection (auto + ten conditions), cinematic post-processing, scenic route travel, biome overlook travel, physics simulation + collider debug, the developer test-crate spawn, biome/LOD/wireframe debug, performance overlay, and a shareable world link.

Share URLs include `seed`, player position, `hour`, `quality`, `mode=character|survey`, `vegetation=0|1`, `roads=0|1`, `objects=0|1`, `water=0|1`, `weather=auto|clear|cloudy|overcast|rain|heavy-rain|storm|fog|snow|blizzard|windy`, `postfx=0|1`, `physics=0`, `route=cedar|golden|snowline` and an optional `character=<glb-url>`.

## What Phase 9 adds

- **Real water bodies:** seeded lakes, ponds, reservoirs, wetlands, seas and downhill rivers carved into the same deterministic terrain — one water field answers "is there water here, how deep, which way does it flow" for terrain generation, queries, rendering, physics and placement alike.
- **A shared wave surface:** the drawn surface evaluates the same three wave trains the physics reads, with depth fading, shoreline foam, fresnel sky mixing, sun glitter, rain pockmarks and an underwater fog response. TSL node material, so WebGPU and WebGL2 run the same graph.
- **Buoyancy on the fixed step:** props and Rapier bodies float, sink, drag and drift with currents inside the physics substep loops, and survive floating-origin rebases; entering the water reports a splash.
- **Swimming and diving:** the character swims to neutral buoyancy, is pushed by river currents, and cannot dive through the lake bed.
- **Weather:** eleven conditions from a seeded advecting front, eased over tens of seconds, driving sun, ambient, clouds, fog, wind, sea state, ground wetness, snow cover and grip; rain turns to snow with altitude and temperature.
- **Bounded particles:** one pooled system with rain, snow, splash and spray layers, per-particle ground/water collision, and a hard per-preset budget.

See [docs/PHASE9.md](docs/PHASE9.md) for the hydrology model, contracts, measurements and known gaps.

## What Phase 6 adds

- **Interactive world objects:** roadside caches, containers, gates, lamps, valves, benches and pickups, placed deterministically in canonical cells, streamed around the player with a per-preset budget, and driven by a shared archetype table.
- **Context interaction:** a targeting pass resolves the nearest object inside the aim cone and reach, shows one prompt, supports hold-to-confirm progress, and dispatches typed actions through the inventory and event bus.
- **Prop physics:** a dedicated `PropPhysicsWorld` steps grounded rigid bodies (crates, drums, salvage) on the fixed step against the same world queries the renderer uses, with sleeping, pushes and ray casts.
- **Persistence:** object and inventory state is saved per seed in a versioned, validated, diff-only envelope; unknown or newer formats are refused instead of overwritten.
- **Player pack:** a generic item model with stacking, labels and a HUD readout — no story content.

See [docs/PHASE6.md](docs/PHASE6.md) for the object model, archetypes, actions, persistence format and validation.

## What Phase 5 adds

- **Playable character:** a 19-joint skinned rig with 13 animation clips driven through a real `AnimationMixer`, a collision-aware locomotion controller (momentum, slope handling, step climbing, ledge detection, gravity, coyote time, jump buffering, variable jump height) and stance-aware movement (walk / jog / sprint / crouch / strafe / backpedal).
- **Third-person camera:** smooth orbit boom with terrain and solid-geometry avoidance, shoulder swap, zoom, speed FOV, landing shake, and a first-person mode.
- **Asset pipeline:** GLTF/GLB humanoids load via `?character=<url>`, bones resolve semantically, animation names map to locomotor states, and unmatched states are back-filled with procedural clips. The built-in rig is a clearly labelled placeholder, and a failed load never breaks the game.
- **World integration:** the player drives the floating origin and streaming focus, the post chain follows the active camera, the HUD adapts to the view, and the survey camera remains available for inspection.
- **Extensible seams:** `CharacterSampler.blocked()` for world colliders, `WaterQuery` for Phase 9 water, typed `CharacterEvent`s for the event layer.

See [docs/PHASE5.md](docs/PHASE5.md) for the architecture, movement model, validation and limitations.

## What Phase 4 adds

- **Physics engine:** Rapier 3D 0.21 (WASM) in its own lazily imported chunk. Fixed 120 Hz stepping with bounded catch-up, so simulation never depends on frame rate. If the engine cannot load, the world still runs and the UI explains why.
- **Floating-origin-safe physics:** every body lives in a physics-local frame and is translated on each 2048 m rebase with velocities, orientation and sleep state intact; ray casts and ground probes always speak canonical world coordinates.
- **Streamed terrain colliders:** each finest visible tile within 430 m becomes a Rapier heightfield built from the same worker grid the renderer draws, capped at 12 tiles with a per-frame build budget.
- **Physical materials:** asphalt, gravel, grass, soil, rock, snow, ice, wood, metal, concrete, glass, rubber, fabric and water with density, friction, restitution and a tyre-grip factor, plus collision layers, sensors and typed collision events.
- **World entity model:** one record type for every future world object with stable id, bounds, streaming priority, persistence policy, visual/physics/simulation attachments, and four simulation levels (full, reduced ~15 Hz, background, dormant) governed by nearest-first population budgets.
- **Unified world query:** height, normal, slope, biome, road formation, surface class, nearest road point and a composite sample — one authority instead of per-subsystem answers.
- **Typed event bus:** the cross-system layer later phases (missions, dialogue, audio, UI) subscribe to, with bounded history and handler-level error isolation.
- **Developer tools:** `K` collider wireframes straight from Rapier's debug buffers, `X` a real simulated crate (body + entity + visual), and physics/entity budgets in the `F3` overlay and the settings panel.

See [docs/PHASE4.md](docs/PHASE4.md) for the engine, physics decision, coordinate model and validation.

## What Phase 3 adds

- **Scenic roads:** an infinite, seed-warped corridor network graded into the terrain, with two asphalt lanes, gravel shoulders, double-yellow and white edge markings, crown/crossfall, and periodic widened overlook pullouts. Road ribbons are worker-built and draped on the same streamed tiles as the ground.
- **Routes & survey travel:** three launch routes (Cedar Pass, Golden Ridge, Snowline Run) into the same infinite network. `G` follows the nearest corridor; the settings panel jumps between named routes. This is a camera survey, not driving physics.
- **World props:** guardrails, reflector posts, scenic-route shields, direction signs, benches, overlook kiosks and bollards, packed into seven bounded nearest-first instance batches with range fade.
- **Richer vegetation & cliffs:** pine, spruce, aspen, birch, shrub, fern, grass, wildflowers, weathered rock and stratified cliff outcrops in ten global instanced batches. Plants are kept clear of the carriageway, shoulders and pullouts.
- **Ultra graphics:** denser terrain tessellation, extended horizons, 4096px soft shadows, higher plant/prop budgets, ultra-detail silhouettes, and a GTAO ambient-occlusion + denoise pass on top of bloom, FXAA and vignette. Lower presets never pay for Ultra-only passes.

## What Phase 2 adds

- **Biomes:** valley meadows, conifer highlands, golden steppe, alpine tundra, and snowline peaks. Seeded temperature/moisture fields blend continuously with altitude and slope; rock and snow masks expose cliffs and summits. The HUD names the live biome, and `B` shows a climate overlay.
- **Surface detail:** three seamless 256×256 procedural textures (grass, rock, snow) are triplanar-projected in world space, blended by biome/slope/snow, and faded with distance. Texture periods divide the floating-origin wrap so rebasing does not slide the ground pattern. Macro albedo adds forest-duff and steppe-curing variation.
- **Vegetation:** pine, spruce, aspen, birch, shrub, fern, grass, wildflowers, rock and cliff outcrops are placed in canonical world cells by workers, grounded on the actual terrain mesh, and packed into ten global instanced batches. A seeded cover field clusters plants into groves and meadow patches instead of a uniform scatter. Quality presets bound density, range, and capacity; nearest-first budgeting keeps the foreground stable, wind phase is origin-invariant, and range edges fade/scale instead of popping.
- **Lifecycle:** vegetation rebuilds on terrain revision, camera movement, origin shift, or settings change; all geometries, materials, instance buffers, and textures are disposed on teardown. `prefers-reduced-motion` starts with wind disabled.
- **Biome overlooks:** deterministic seed-local survey jumps to each climate region; the default spawn prefers a forest overlook so the living terrain is visible immediately.

## What Phase 1 still provides

- **Renderer:** `WebGPURenderer` with AgX tone mapping, MSAA, PBR terrain material, sky-derived environment lighting, directional sun/moon, hemisphere fill, soft shadow maps, and a WebGL2 fallback path with a probe draw and runtime device-loss fallback. Balanced/High add a cinematic post chain (threshold bloom, FXAA, subtle vignette); Ultra adds GTAO ambient occlusion with denoising; Low bypasses post for software/mobile GPUs.
- **Sky:** analytic Rayleigh/Mie atmosphere, procedural layered clouds, seeded star sphere with a galactic band, procedural moon, and a 12-minute day/night cycle.
- **Terrain:** deterministic seeded simplex fBm + ridged multifractal + domain warping + valley carving, streamed as a quadtree of chunks around the camera. Six LOD levels, exact shared borders, vertical skirts, frustum culling, bounded LRU cache, and transferable worker-generated buffers.
- **Floating origin:** simulation coordinates stay in JS doubles; GPU coordinates are re-centered every 2048 m so precision does not degrade at large distances.
- **Cameras:** fixed 120 Hz update with render interpolation, terrain clearance, scenic auto-flight, manual free flight, and the on-foot third-person rig.
- **UI shell:** loading progress, minimal HUD, settings panel, seed input, time control, graphics presets, debug toggles, performance overlay, interaction prompt, pack readout and URL sharing.

## Architecture

```text
src/
  config.ts               central tuning, quality presets, physics/entity/object budgets
  main.ts                 bootstrap
  core/                   game loop, fixed clock, input, floating origin, survey camera,
                          coordinates, typed events, entity/spatial primitives
  character/              locomotion solver, character controller, skinned rig,
                          animation controller + clips, third-person camera, assets,
                          world sampler, character system
  game/                   world manager, entity model + registry/streaming, typed event bus
  physics/                Rapier world wrapper, physical materials, streamed terrain
                          ground colliders, collider debug renderer, prop rigid bodies,
                          prop physics world, surface material table (surfaces.ts)
  objects/                object archetypes, placement, actions, items, object system
  interaction/            targeting, prompts, inventory, interaction manager
  persistence/            versioned object/inventory save store
  world/                  noise, terrain field, biomes, quadtree tiles, worker pool,
                          generator, vegetation field/manager, road network/geometry/manager,
                          viewpoints, sky, world query services
  rendering/              renderer factory, post-processing (GTAO/bloom/FXAA), terrain,
                          road, object and prop materials/geometry, surface/foliage textures
  ui/                     HUD/settings shell and styles
  workers/                terrain worker entry
  utils/                  seeded RNG and math
tests/                    unit, integration + browser regression tests
```

See [docs/ROADMAP.md](docs/ROADMAP.md) for the open-world plan and the Phase 4/6 contracts later phases must honour, [docs/PHASE6.md](docs/PHASE6.md) for interactive objects and persistence, [docs/PHASE5.md](docs/PHASE5.md) for the playable character, [docs/PHASE4.md](docs/PHASE4.md) for the engine and physics, [docs/PHASE3.md](docs/PHASE3.md) for roads/routes/props, [docs/PHASE2.md](docs/PHASE2.md) for biomes/surfaces/vegetation, and [docs/PHASE1.md](docs/PHASE1.md) for the world foundation.

## Merge notes

The three phase lines were developed against the same Phase 3 base, so this branch reconciles them explicitly:

- **Two physics systems coexist by design.** Rapier (`physics/physics-world.ts`) owns streamed terrain colliders, large bodies and the developer sandbox; `PropPhysicsWorld` (`physics/prop-physics.ts`) owns light interactive props. `WorldManager` steps Rapier, the game loop steps prop physics, both on the same fixed step.
- **Two query services coexist.** `world/world-query.ts` (`WorldQuery`) answers for the world manager and Rapier ground streamer; `world/world-queries.ts` (`WorldQueries`) answers for objects, interaction and prop physics. Both read the same terrain.
- **Two material tables.** Phase 4's `physics/materials.ts` (`PhysicsMaterialId`, collision/friction response, tyre grip) and Phase 6's `physics/surfaces.ts` (`SurfaceKind`, object/prop response) both exist; keeping them separate avoided silently changing either system's tuning.
- **Two event buses.** `game/events.ts` (`EventBus`) carries world/physics signals; `core/events.ts` (`GameEventBus`) carries gameplay/object/inventory signals.
- **One focus, one camera.** The on-foot character drives streaming, the floating origin, the post chain and interaction targeting while walking; the survey rig does so while flying. `C` swaps views without teleporting.
- **Colliding filenames were split, not overwritten:** `tests/physics.test.ts` (Rapier) vs `tests/prop-physics.test.ts` (props); `tests/entities.test.ts` (world entities) vs `tests/object-entities.test.ts` (object entities).

## Performance notes

- Terrain and vegetation placement run in 2–4 Web Workers depending on preset; the main thread only uploads finished buffers and packs instances.
- Pixel ratio is capped per preset and by a total-pixel budget to protect 4K/retina displays.
- Vegetation uses ten instanced draw batches and roadside props use seven more, all with fixed capacities and nearest-first budgeting. Low/Balanced/High/Ultra budgets are documented in [docs/PHASE3.md](docs/PHASE3.md); budget truncation is reported in debug stats.
- Physics runs on a fixed 120 Hz step with a bounded substep count; the ground streamer rebuilds at most four heightfields per update under a 6 ms budget. Rigid bodies are capped (640 bodies / 1280 colliders) and the cap emits an event instead of growing.
- Entity streaming enforces population budgets per simulation level (24 full / 72 reduced / 320 background) and only ticks reduced-fidelity entities at ~15 Hz.
- Interactive objects stream in canonical 512 m cells with per-preset budgets (28/56/88/128) and prop body caps (20/40/64/96); prop bodies sleep when settled.
- Chunk geometry, materials, instance buffers, textures and object geometry caches are disposed on eviction, seed change, quality change, and teardown.
- The performance overlay reports FPS, draw calls, triangles, geometries, cached/queued tiles, origin rebases, LOD distribution, plant count/capacity, instanced batch count, physics bodies/colliders/step time, streamed ground colliders, entity simulation levels, object counts, prop bodies and the interaction target.
- Browser validation in this repository's sandbox uses Chromium/SwiftShader (software WebGL2). It is functional coverage, not a hardware-GPU benchmark; a real WebGPU adapter was not available there. The merged branch was verified with `tsc --noEmit`, `npm run build` and 181 unit/integration tests; run `npm run test:browser` on a machine with Chromium for the end-to-end pass.

## Assets and licenses

No paid assets. Terrain, sky, stars, moon, biomes, surface/road textures, vegetation, cliffs, road signs, props, objects and materials are procedural. Fonts are self-hosted via Fontsource (SIL OFL). Three.js and its examples are MIT/BSD licensed; Rapier 3D is Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
