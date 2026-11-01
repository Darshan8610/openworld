# Wayfarer — Infinite Open-World Game

**Phases 4–5: the engine underneath the world, and the player on foot.** A seeded, infinite, chunk-streamed landscape with five climate-blended biomes, ten instanced vegetation/rock layers, graded scenic highways, roadside props, streamed terrain physics, a world entity model with multilevel simulation streaming, one authoritative world query service, a typed gameplay event bus — explored **on foot** by a skinned, animated, collision-aware human character with a third-person camera.

Built on Three.js r187, TypeScript, Vite, WebGPU + WebGL2 fallback, Web Workers, floating origin, fixed 120 Hz simulation, dynamic day/night sky, the Phase 3 road network and Rapier 3D.

> Vehicles, missions, buildings, NPCs, water, audio and the story layer remain later phases.

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed by Vite (default `http://localhost:5173`). WebGPU requires HTTPS or localhost; the app automatically falls back to WebGL2 when WebGPU is unavailable or fails a probe draw.

```bash
npm run build         # type-check + production build
npm run preview       # serve the production build
npm test              # unit + integration tests (world, physics, entities, queries, events,
                      # character motion/rig/animation, character system, UI markup integrity)
npm run test:browser  # Playwright browser specs (requires Chromium)
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
| R | Reset viewpoint |
| P | Pause/resume day cycle |
| V | Toggle vegetation |
| B | Toggle biome overlay |
| L | Toggle LOD debug colors |
| H | Hide/show HUD |
| F3 | Performance overlay |
| K | Physics collider wireframes (developer) |
| X | Drop a physics test crate (developer) |

The settings panel exposes the world seed, time-of-day slider, day-cycle toggle, graphics preset (Low / Balanced / High / Ultra), player view (on foot / survey camera), first-person camera, look sensitivity, shoulder swap, respawn, vegetation, roads, wind, surface detail, cinematic post-processing, scenic route travel, biome overlook travel, physics simulation + collider debug, the developer test-crate spawn, biome/LOD/wireframe debug, performance overlay, and a shareable world link. Share URLs include `mode=character|survey`, `vegetation=0|1`, `roads=0|1`, `postfx=0|1`, `physics=0`, `route=cedar|golden|snowline` and optional `character=<glb-url>` alongside seed, player position, hour, quality and renderer.

## What Phase 4 adds

- **Physics engine:** Rapier 3D 0.21 (WASM) in its own lazily imported chunk. Fixed 120 Hz stepping with bounded catch-up, so simulation never depends on frame rate. If the engine cannot load, the world still runs and the UI explains why.
- **Floating-origin-safe physics:** every body lives in a physics-local frame and is translated on each 2048 m rebase with velocities, orientation and sleep state intact; ray casts and ground probes always speak canonical world coordinates.
- **Streamed terrain colliders:** each finest visible tile within 430 m becomes a Rapier heightfield built from the same worker grid the renderer draws, capped at 12 tiles with a per-frame build budget.
- **Physical materials:** asphalt, gravel, grass, soil, rock, snow, ice, wood, metal, concrete, glass, rubber, fabric and water with density, friction, restitution and a tyre-grip factor, plus collision layers, sensors and typed collision events.
- **World entity model:** one record type for every future world object with stable id, bounds, streaming priority, persistence policy, visual/physics/simulation attachments, and four simulation levels (full, reduced ~15 Hz, background, dormant) governed by nearest-first population budgets.
- **Unified world query:** height, normal, slope, biome, road formation, surface class, nearest road point and a composite sample — one authority instead of per-subsystem answers.
- **Typed event bus:** the cross-system layer later phases (missions, dialogue, audio, UI) subscribe to, with bounded history and handler-level error isolation.
- **Developer tools:** `K` collider wireframes straight from Rapier's debug buffers, `X` a real simulated crate (body + entity + visual), and physics/entity budgets in the `F3` overlay and the settings panel.

## What Phase 5 adds

- **Playable character:** a 19-joint skinned rig with 13 animation clips driven through a real `AnimationMixer`, a collision-aware locomotion controller (momentum, slope handling, step climbing, ledge detection, gravity, coyote time, jump buffering, variable jump height) and stance-aware movement (walk / jog / sprint / crouch / strafe / backpedal).
- **Third-person camera:** smooth orbit boom with terrain and solid-geometry avoidance, shoulder swap, zoom, speed FOV, landing shake, and a first-person mode.
- **Asset pipeline:** GLTF/GLB humanoids load via `?character=<url>`, bones resolve semantically, animation names map to locomotor states, and unmatched states are back-filled with procedural clips. The built-in rig is a clearly labelled placeholder, and a failed load never breaks the game.
- **World integration:** the player drives the floating origin and streaming focus, the post chain follows the active camera, the HUD adapts to the view, and the survey camera remains available for inspection.
- **Extensible seams:** `CharacterSampler.blocked()` for world colliders, `WaterQuery` for Phase 9 water, typed `CharacterEvent`s for the Phase 4/11 event layer.

See [docs/PHASE5.md](docs/PHASE5.md) for the architecture, movement model, validation and limitations.

## What Phase 3 added

- **Scenic roads:** an infinite, seed-warped corridor network graded into the terrain, with two asphalt lanes, gravel shoulders, double-yellow and white edge markings, crown/crossfall, and periodic widened overlook pullouts. Road ribbons are worker-built and draped on the same streamed tiles as the ground.
- **Routes & survey travel:** three launch routes (Cedar Pass, Golden Ridge, Snowline Run) into the same infinite network. `G` follows the nearest corridor; the settings panel jumps between named routes. This is a camera survey, not driving physics.
- **World props:** guardrails, reflector posts, scenic-route shields, direction signs, benches, overlook kiosks and bollards, packed into seven bounded nearest-first instance batches with range fade.
- **Richer vegetation & cliffs:** pine, spruce, aspen, birch, shrub, fern, grass, wildflowers, weathered rock and stratified cliff outcrops in ten global instanced batches. Plants are kept clear of the carriageway, shoulders and pullouts.
- **Ultra graphics:** denser terrain tessellation, extended horizons, 4096px soft shadows, higher plant/prop budgets, ultra-detail silhouettes, and a GTAO ambient-occlusion + denoise pass on top of bloom, FXAA and vignette. Lower presets never pay for Ultra-only passes.

## What Phase 2 added

- **Biomes:** valley meadows, conifer highlands, golden steppe, alpine tundra, and snowline peaks. Seeded temperature/moisture fields blend continuously with altitude and slope; rock and snow masks expose cliffs and summits. The HUD names the live biome, and `B` shows a climate overlay.
- **Surface detail:** three seamless 256×256 procedural textures (grass, rock, snow) are triplanar-projected in world space, blended by biome/slope/snow, and faded with distance. Texture periods divide the floating-origin wrap so rebasing does not slide the ground pattern. Macro albedo adds forest-duff and steppe-curing variation.
- **Vegetation:** pine, spruce, aspen, birch, shrub, fern, grass, wildflowers, rock and cliff outcrops are placed in canonical world cells by workers, grounded on the actual terrain mesh, and packed into ten global instanced batches. A seeded cover field clusters plants into groves and meadow patches instead of a uniform scatter. Trees/shrubs use dense procedural alpha-tested foliage sprays (256×256) on layered branch cards; grass uses bent blades with seed heads and occasional wildflower heads. Quality presets bound density, range, and capacity; coarse LODs keep a stable subset of the same plants. Nearest-first budgeting keeps the foreground stable, wind phase is origin-invariant, and range edges fade/scale instead of popping.
- **Lifecycle:** vegetation rebuilds on terrain revision, camera movement, origin shift, or settings change; all geometries, materials, instance buffers, and textures are disposed on teardown. Terrain materials are shared per LOD/mode. `prefers-reduced-motion` starts with wind disabled.
- **Biome overlooks:** deterministic seed-local survey jumps to each climate region; the default spawn prefers a forest overlook so the living terrain is visible immediately.

## What Phase 1 still provides

- **Renderer:** `WebGPURenderer` with AgX tone mapping, MSAA, PBR terrain material, sky-derived environment lighting, directional sun/moon, hemisphere fill, soft shadow maps, and a WebGL2 fallback path with a probe draw and runtime device-loss fallback. Balanced/High add a cinematic post chain (threshold bloom, FXAA, subtle vignette); Ultra adds GTAO ambient occlusion with denoising; Low bypasses post for software/mobile GPUs.
- **Sky:** analytic Rayleigh/Mie atmosphere, procedural layered clouds, seeded star sphere with a galactic band, procedural moon, and a 12-minute day/night cycle.
- **Terrain:** deterministic seeded simplex fBm + ridged multifractal + domain warping + valley carving, streamed as a quadtree of chunks around the camera. Six LOD levels, exact shared borders, vertical skirts, frustum culling, bounded LRU cache, and transferable worker-generated buffers.
- **Floating origin:** simulation coordinates stay in JS doubles; GPU coordinates are re-centered every 2048 m so precision does not degrade at large distances.
- **Survey camera:** fixed 120 Hz update with render interpolation, terrain clearance, scenic auto-flight, and manual free flight.
- **UI shell:** loading progress, minimal HUD, settings panel, seed input, time control, graphics presets, debug toggles, performance overlay, and URL sharing.

## Architecture

```text
src/
  config.ts               central tuning, quality presets, physics and entity budgets
  main.ts                 bootstrap
  core/                   game loop, fixed clock, input, floating origin, survey camera
  game/                   world manager, entity model + registry/streaming, typed event bus
  physics/                Rapier world wrapper, physical materials, streamed terrain
                          ground colliders, collider debug renderer
  character/              locomotion solver, character controller, skinned rig,
                          animation controller + clips, third-person camera, assets,
                          world sampler, character system
  world/                  noise, terrain field, biomes, quadtree tiles, worker pool,
                          generator, vegetation field/manager, road network/geometry/manager,
                          viewpoints, sky, unified world query service
  rendering/              renderer factory, post-processing (GTAO/bloom/FXAA), terrain
                          and road materials, surface/foliage textures, plant and prop geometry
  ui/                     HUD/settings shell and styles
  workers/                terrain worker entry
  utils/                  seeded RNG and math
tests/                    unit, integration + browser regression tests
```

See [docs/ROADMAP.md](docs/ROADMAP.md) for the open-world plan, [docs/PHASE4.md](docs/PHASE4.md) for the engine, physics decision, coordinate model and validation, [docs/PHASE5.md](docs/PHASE5.md) for the playable character, [docs/PHASE3.md](docs/PHASE3.md) for roads/routes/props, [docs/PHASE2.md](docs/PHASE2.md) for biomes/surfaces/vegetation, and [docs/PHASE1.md](docs/PHASE1.md) for the world foundation.

## Performance notes

- Terrain and vegetation placement run in 2–4 Web Workers depending on preset; the main thread only uploads finished buffers and packs instances.
- Pixel ratio is capped per preset and by a total-pixel budget to protect 4K/retina displays.
- Vegetation uses ten instanced draw batches and roadside props use seven more, all with fixed capacities and nearest-first budgeting. Low/Balanced/High/Ultra budgets are documented in [docs/PHASE3.md](docs/PHASE3.md); budget truncation is reported in debug stats. The Low preset also uses reduced-detail plant geometry.
- Physics runs on a fixed 120 Hz step with a bounded substep count; the ground streamer rebuilds at most four heightfields per update under a 6 ms budget. Rigid bodies are capped (640 bodies / 1280 colliders) and the cap emits an event instead of growing.
- Entity streaming enforces population budgets per simulation level (24 full / 72 reduced / 320 background) and only ticks reduced-fidelity entities at ~15 Hz.
- Chunk geometry, materials, instance buffers, and textures are disposed on eviction, seed change, quality change, and teardown.
- The performance overlay reports FPS, draw calls, triangles, geometries, cached/queued tiles, origin rebases, LOD distribution, plant count/capacity, instanced batch count, physics bodies/colliders/step time, streamed ground colliders and entity simulation levels.
- Browser validation in this repository's sandbox uses Chromium/SwiftShader (software WebGL2). It is functional coverage, not a hardware-GPU benchmark; a real WebGPU adapter was not available there.
- The character adds one skinned draw call set (body) per player and a 19-joint skeleton animation update per frame; it does not add per-frame allocations to the streaming path. Movement runs inside the existing fixed 120 Hz step.

## Assets and licenses

No paid assets. Terrain, sky, stars, moon, biomes, surface/road textures, vegetation, cliffs, road signs, props and materials are procedural. Fonts are self-hosted via Fontsource (SIL OFL). Three.js and its examples are MIT/BSD licensed; Rapier 3D is Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
