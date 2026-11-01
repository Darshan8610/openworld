# Wayfarer — Infinite Open-World Driving Game

**Phase 3: roads through the wild.** A seeded, infinite, chunk-streamed landscape with five climate-blended biomes, ten instanced vegetation/rock layers, graded scenic highways, roadside props, route-following survey travel, and an Ultra graphics preset. Built on the Phase 1 world foundation: Three.js r187, TypeScript, Vite, WebGPU + WebGL2 fallback, Web Workers, floating origin, dynamic day/night sky, and a free-flight survey camera.

> Phase 3 adds roads, routes and world props. Drivable vehicles, traffic, missions, physics, weather, audio and full menus remain later phases; the route camera is a survey tool, not a car controller.

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed by Vite (default `http://localhost:5173`). WebGPU requires HTTPS or localhost; the app automatically falls back to WebGL2 when WebGPU is unavailable or fails a probe draw.

```bash
npm run build         # type-check + production build
npm run preview       # serve the production build
npm test              # 36 unit tests (noise, streaming, origin, terrain, biomes, vegetation, roads, overlooks)
npm run test:browser  # 11 Playwright browser tests (requires Chromium)
```

For browser tests, install Chromium once:

```bash
npx playwright install chromium
```

## Controls

| Input | Action |
|---|---|
| WASD / arrows | Fly horizontally |
| Q / E | Descend / ascend |
| Shift | Boost |
| Mouse drag | Look around |
| Explore button | Pointer-lock mouse look (Esc releases) |
| Mouse wheel | Adjust cruise speed |
| T | Toggle scenic auto-flight |
| G | Start/stop the nearest scenic route survey |
| R | Reset viewpoint |
| P | Pause/resume day cycle |
| V | Toggle vegetation |
| B | Toggle biome overlay |
| L | Toggle LOD debug colors |
| H | Hide/show HUD |
| F3 | Performance overlay |

The settings panel exposes the world seed, time-of-day slider, day-cycle toggle, graphics preset (Low / Balanced / High / Ultra), vegetation, roads, wind, surface detail, cinematic post-processing, scenic route travel, biome overlook travel, biome/LOD/wireframe debug, performance overlay, and a shareable world link. Share URLs include `vegetation=0|1`, `roads=0|1`, `postfx=0|1` and `route=cedar|golden|snowline` alongside seed, position, hour, quality, and renderer.

## What Phase 3 adds

- **Scenic roads:** an infinite, seed-warped corridor network graded into the terrain, with two asphalt lanes, gravel shoulders, double-yellow and white edge markings, crown/crossfall, and periodic widened overlook pullouts. Road ribbons are worker-built and draped on the same streamed tiles as the ground.
- **Routes & survey travel:** three launch routes (Cedar Pass, Golden Ridge, Snowline Run) into the same infinite network. `G` follows the nearest corridor; the settings panel jumps between named routes. This is a camera survey, not driving physics.
- **World props:** guardrails, reflector posts, scenic-route shields, direction signs, benches, overlook kiosks and bollards, packed into seven bounded nearest-first instance batches with range fade.
- **Richer vegetation & cliffs:** pine, spruce, aspen, birch, shrub, fern, grass, wildflowers, weathered rock and stratified cliff outcrops in ten global instanced batches. Plants are kept clear of the carriageway, shoulders and pullouts.
- **Ultra graphics:** denser terrain tessellation, extended horizons, 4096px soft shadows, higher plant/prop budgets, ultra-detail silhouettes, and a GTAO ambient-occlusion + denoise pass on top of bloom, FXAA and vignette. Lower presets never pay for Ultra-only passes.

## What Phase 2 adds

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
  config.ts               central tuning + vegetation quality budgets
  main.ts                 bootstrap
  core/                   game loop, fixed clock, input, floating origin, survey camera
  world/                  noise, terrain field, biomes, quadtree tiles, worker pool,
                          generator, vegetation field/manager, road network/geometry/manager,
                          viewpoints, sky
  rendering/              renderer factory, post-processing (GTAO/bloom/FXAA), terrain
                          and road materials, surface/foliage textures, plant and prop geometry
  ui/                     HUD/settings shell and styles
  workers/                terrain worker entry
  utils/                  seeded RNG and math
tests/                    unit + browser regression tests
```

See [docs/PHASE1.md](docs/PHASE1.md) for the world foundation, [docs/PHASE2.md](docs/PHASE2.md) for biomes/surfaces/vegetation, and [docs/PHASE3.md](docs/PHASE3.md) for roads, routes, props, Ultra graphics and validation.

## Performance notes

- Terrain and vegetation placement run in 2–4 Web Workers depending on preset; the main thread only uploads finished buffers and packs instances.
- Pixel ratio is capped per preset and by a total-pixel budget to protect 4K/retina displays.
- Vegetation uses ten instanced draw batches and roadside props use seven more, all with fixed capacities and nearest-first budgeting. Low/Balanced/High/Ultra budgets are documented in [docs/PHASE3.md](docs/PHASE3.md); budget truncation is reported in debug stats. The Low preset also uses reduced-detail plant geometry.
- Chunk geometry, materials, instance buffers, and textures are disposed on eviction, seed change, quality change, and teardown.
- The performance overlay reports FPS, draw calls, triangles, geometries, cached/queued tiles, origin rebases, LOD distribution, plant count/capacity, and instanced batch count.
- Browser validation in this repository's sandbox uses Chromium/SwiftShader (software WebGL2). It is functional coverage, not a hardware-GPU benchmark; a real WebGPU adapter was not available there.

## Assets and licenses

No paid assets. Terrain, sky, stars, moon, biomes, surface/road textures, vegetation, cliffs, road signs, props and materials are procedural. Fonts are self-hosted via Fontsource (SIL OFL). Three.js and its examples are MIT/BSD licensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
