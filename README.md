# Wayfarer — Infinite Open-World Game

**Phases 1–6, 8 and 12 combined: a seeded, infinite world you can walk, hear, inspect, touch and share with other people.** Five climate-blended biomes, ten instanced vegetation/rock layers, graded scenic highways, streamed terrain physics, a playable animated character, interactive world objects with persistent state, a scheduled NPC population that paths over streamed terrain and holds conversations, synthesised spatial audio with ambience zones, a title/pause menu shell with a real mix and accessibility options, and an Ultra graphics preset — over a chunk-streamed landscape with a floating origin and a fixed 120 Hz simulation.

Built on Three.js r187, TypeScript, Vite, WebGPU + WebGL2 fallback, Web Workers and Rapier 3D.

> This branch merges the Phase 4 (engine/physics), Phase 5 (playable character), Phase 6 (objects/interaction), Phase 8 (NPCs & life simulation) and Phase 12 (audio/UX/accessibility) lines. Buildings/interiors (Phase 7) are being built on a separate line; water and weather (9), vehicles (10), discovery/gameplay infrastructure (11) and the story layer remain later phases — see [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed by Vite (default `http://localhost:5173`). WebGPU requires HTTPS or localhost; the app automatically falls back to WebGL2 when WebGPU is unavailable or fails a probe draw.

```bash
npm run build         # type-check + production build
npm run preview       # serve the production build
npm test              # 300 unit/integration tests across 29 files
npm run test:browser  # 23 Playwright browser tests (requires Chromium)
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
| E | Interact / hold to confirm / talk |
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
| Esc | Pause (from the world) / step out of settings |
| Tab / Shift+Tab | Move focus inside the open dialog |
| 1–4 | Pick a conversation topic (while talking) |
| R | Reset viewpoint / return to spawn |
| P | Pause/resume day cycle |
| V | Toggle vegetation |
| O | Toggle interactive world objects |
| N | Toggle the NPC population |
| B | Toggle biome overlay |
| L | Toggle LOD debug colors |
| H | Hide/show HUD |
| F3 | Performance overlay |
| K | Physics collider wireframes (developer) |
| X | Drop a physics test crate (developer, while using the Rapier sandbox) |

The title screen exposes the world seed (with a random-seed button), the graphics preset and a shareable link before you commit to a walk. The pause menu (`Esc`) freezes the simulation and the audio and offers resume, settings, copy link, mute, restart and back-to-title, plus a controls list.

The settings panel exposes the world seed, time-of-day slider, day-cycle toggle, graphics preset (Low / Balanced / High / Ultra), player view (on foot / survey camera), first-person camera, look sensitivity, shoulder swap, respawn, vegetation, roads, interactive objects with the player pack readout, wind, surface detail, cinematic post-processing, scenic route travel, biome overlook travel, physics simulation + collider debug, the developer test-crate spawn, biome/LOD/wireframe debug, performance overlay, a shareable world link, a four-bus sound mix (master / ambience / world & footsteps / interface, mute, sound captions) and accessibility controls (reduce motion, high contrast, larger interface text, hold-to-confirm). Preferences persist locally under `wayfarer.preferences` and apply immediately.

Share URLs include `seed`, player position, `hour`, `quality`, `mode=character|survey`, `vegetation=0|1`, `roads=0|1`, `objects=0|1`, `npcs=0|1`, `postfx=0|1`, `physics=0`, `route=cedar|golden|snowline` and an optional `character=<glb-url>`.

## What Phase 12 adds

- **Synthesised spatial audio, no samples:** 27 procedural sound recipes built from one generated noise buffer and oscillators, rendered through ambience/effects/UI buses into a master limiter — the repository ships no audio files at all.
- **Budgeted voices:** 24 simultaneous voices with per-bus caps (4/16/6). The mixer steals the weakest lower-priority voice and counts every refusal, so a crowd cannot blow the audio budget; state, voice count, capacity, drops, dominant zone and step count are reported in the performance overlay.
- **Ambience zones:** wind, foliage, ridge and hush beds derived from biome cover, altitude exposure, time of day and the wind setting, resampled at 4 Hz and cross-faded over 2.5 s, with a short transition cue and caption.
- **Footsteps and landings from real motion:** distance-cadenced steps on the actual `SurfaceKind` underfoot (grass, gravel, rock, snow, hard, wood, metal, water), stance-dependent stride and loudness, soft/hard landings from impact speed, and swim splashes — with no new coupling to gameplay.
- **Spatial events:** object interactions and NPC conversations play through typed events with distance attenuation and stereo pan, resolved to canonical world positions.
- **A real front end:** a title screen (seed, preset, enter, settings, share), a pause menu that freezes simulation *and* suspends the audio context, a settings dialog that returns where it came from, focus trapping, `inert` HUD while paused, and keyboard-free cheating of the simulation while a menu is open.
- **Accessibility as a feature:** sound captions in a polite live region, high contrast, larger interface text, reduce motion (also honoured automatically from the OS setting) and hold-to-confirm interactions, all persisted and applied without a reload.

See [docs/PHASE12.md](docs/PHASE12.md) for the audio graph, mixing policy, zones, menu transitions, preferences and validation.

## What Phase 8 adds

- **A real population:** NPCs are placed deterministically per 512 m canonical cell (roadside verge and wild country), get home/work/leisure anchors, and stream nearest-first inside a per-preset budget with four simulation levels and a pooled rig cap. Their identity and state survive streaming out and back in.
- **Navigation over the live world:** a demand-built 4 m walkable grid over the same streamed terrain the player uses, with slope, water and solid-object constraints, a globally budgeted A* (8 searches/s, 1200 expansions), goal snapping that refuses unreachable goals, line-of-sight path smoothing and cross-chunk paths.
- **Reusable perception:** 110° vision cone, terrain line-of-sight, hearing, decaying memory and a startle flag — enough for curiosity, avoidance and later mission logic.
- **Data-driven life:** three schedules over four activities with per-NPC phase offsets and an extensible behaviour tree producing 19 real simulated states (idle, walk, wander, run, look, travel, work, sit, eat, rest, sleep, follow, wait, investigate, react, avoid, talk, return, flee). Conversations and startles preempt a walk in progress.
- **Conversation hooks, not story:** NPCs implement the Phase 6 interaction contract, so the existing prompt/targeting pipeline opens a panel whose answers are composed from live world data (biome, surface, grade, road distance, compass, current activity). No plot, quest or invented dialogue.
- **Persistence:** a versioned, validated, diff-only per-seed NPC slice that refuses newer or unknown formats instead of overwriting them.

See [docs/PHASE8.md](docs/PHASE8.md) for the placement model, navigation and perception contracts, the full state table, budgets and validation.

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
  npc/                    roles, deterministic placement, nav grid + A*, perception,
                          schedules, behaviour trees, dialogue hooks, NPC entity,
                          two-tier visuals, population manager
  persistence/            versioned object/inventory/NPC save stores
  world/                  noise, terrain field, biomes, quadtree tiles, worker pool,
                          generator, vegetation field/manager, road network/geometry/manager,
                          viewpoints, sky, world query services
  rendering/              renderer factory, post-processing (GTAO/bloom/FXAA), terrain,
                          road, object and prop materials/geometry, surface/foliage textures
  audio/                  sound vocabulary, recipes, mixer policy, ambience zones,
                          footstep cadence, Web Audio engine, audio director
  ui/                     HUD/settings shell, menu state machine, preferences,
                          captions and styles
  workers/                terrain worker entry
  utils/                  seeded RNG and math
tests/                    unit, integration + browser regression tests
```

See [docs/ROADMAP.md](docs/ROADMAP.md) for the open-world plan and the Phase 4/6/8/12 contracts later phases must honour, [docs/PHASE12.md](docs/PHASE12.md) for audio, menus and accessibility, [docs/PHASE8.md](docs/PHASE8.md) for the NPC population, navigation, perception and behaviour states, [docs/PHASE6.md](docs/PHASE6.md) for interactive objects and persistence, [docs/PHASE5.md](docs/PHASE5.md) for the playable character, [docs/PHASE4.md](docs/PHASE4.md) for the engine and physics, [docs/PHASE3.md](docs/PHASE3.md) for roads/routes/props, [docs/PHASE2.md](docs/PHASE2.md) for biomes/surfaces/vegetation, and [docs/PHASE1.md](docs/PHASE1.md) for the world foundation.

## Merge notes

The phase lines were developed against the same Phase 3 base, so this branch reconciles them explicitly:

- **Two physics systems coexist by design.** Rapier (`physics/physics-world.ts`) owns streamed terrain colliders, large bodies and the developer sandbox; `PropPhysicsWorld` (`physics/prop-physics.ts`) owns light interactive props. `WorldManager` steps Rapier, the game loop steps prop physics, both on the same fixed step.
- **Two query services coexist.** `world/world-query.ts` (`WorldQuery`) answers for the world manager and Rapier ground streamer; `world/world-queries.ts` (`WorldQueries`) answers for objects, interaction and prop physics. Both read the same terrain.
- **Two material tables.** Phase 4's `physics/materials.ts` (`PhysicsMaterialId`, collision/friction response, tyre grip) and Phase 6's `physics/surfaces.ts` (`SurfaceKind`, object/prop response) both exist; keeping them separate avoided silently changing either system's tuning.
- **Two event buses.** `game/events.ts` (`EventBus`) carries world/physics signals; `core/events.ts` (`GameEventBus`) carries gameplay/object/inventory signals.
- **One focus, one camera.** The on-foot character drives streaming, the floating origin, the post chain and interaction targeting while walking; the survey rig does so while flying. `C` swaps views without teleporting.
- **Colliding filenames were split, not overwritten:** `tests/physics.test.ts` (Rapier) vs `tests/prop-physics.test.ts` (props); `tests/entities.test.ts` (world entities) vs `tests/object-entities.test.ts` (object entities).
- **The interaction contract is structural.** `InteractionProvider.archetype` was `ObjectArchetype`, which made non-object providers impossible; it is now `InteractionArchetype`, so NPCs share the same targeting, prompt and dispatch path as objects without importing object data.
- **NPC motion is intent-driven.** Behaviour nodes never write positions: they call `walkTo`/`stop`/`face`, and the same `CharacterMotion` solver and fixed 120 Hz step that move the player move the population.

## Performance notes

- Terrain and vegetation placement run in 2–4 Web Workers depending on preset; the main thread only uploads finished buffers and packs instances.
- Pixel ratio is capped per preset and by a total-pixel budget to protect 4K/retina displays.
- Vegetation uses ten instanced draw batches and roadside props use seven more, all with fixed capacities and nearest-first budgeting. Low/Balanced/High/Ultra budgets are documented in [docs/PHASE3.md](docs/PHASE3.md); budget truncation is reported in debug stats.
- Physics runs on a fixed 120 Hz step with a bounded substep count; the ground streamer rebuilds at most four heightfields per update under a 6 ms budget. Rigid bodies are capped (640 bodies / 1280 colliders) and the cap emits an event instead of growing.
- Entity streaming enforces population budgets per simulation level (24 full / 72 reduced / 320 background) and only ticks reduced-fidelity entities at ~15 Hz.
- Interactive objects stream in canonical 512 m cells with per-preset budgets (28/56/88/128) and prop body caps (20/40/64/96); prop bodies sleep when settled.
- NPCs stream in canonical 512 m cells with per-preset population budgets (8/14/20/28) and pooled rig caps (2/4/6/8); full-fidelity NPCs (≤ 95 m) think on the fixed step, reduced (≤ 230 m) at ~15 Hz, background (≤ 640 m) only reschedule. A* is globally capped at 8 searches/second with a 1200-expansion ceiling and a 6000-node cache.
- Chunk geometry, materials, instance buffers, textures and object geometry caches are disposed on eviction, seed change, quality change, and teardown.
- Audio is hard-capped at 24 voices (per-bus 4/16/6) with a single shared 2-second generated noise buffer; ambience decisions run at 4 Hz, footsteps are distance-driven, and a paused game suspends the audio context entirely.
- The performance overlay reports FPS, draw calls, triangles, geometries, cached/queued tiles, origin rebases, LOD distribution, plant count/capacity, instanced batch count, physics bodies/colliders/step time, streamed ground colliders, entity simulation levels, object counts, prop bodies, the interaction target, and audio state/voices/capacity/drops/zone/steps.
- Browser validation in this repository's sandbox uses Chromium/SwiftShader (software WebGL2). It is functional coverage, not a hardware-GPU benchmark; a real WebGPU adapter was not available there. The merged branch was verified with `tsc --noEmit`, `npm run build` and 300 unit/integration tests across 29 files; run `npm run test:browser` on a machine with Chromium for the end-to-end pass.

## Assets and licenses

No paid assets. Terrain, sky, stars, moon, biomes, surface/road textures, vegetation, cliffs, road signs, props, objects, materials and **all sound** are procedural — audio is synthesised at runtime from a generated noise buffer and oscillators, so there are no sample files or licences. Fonts are self-hosted via Fontsource (SIL OFL). Three.js and its examples are MIT/BSD licensed; Rapier 3D is Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Phase 11 — first discovery/persistence milestone

Press **M** or **Map · M** for the local world chart. Click to place a waypoint,
zoom, or use the three manual save/load slots. Slots restore the world seed,
character XZ via grounded respawn, time, discovery, waypoint, objects and inventory.
The existing per-seed object autosave remains separate. Corrupt/newer game slots
are refused rather than overwritten. Phase 11 is **in progress**: routing, minimap,
mission infrastructure and other-phase entity adapters are not yet implemented.
See [Phase 11 engineering notes](docs/PHASE11.md).
