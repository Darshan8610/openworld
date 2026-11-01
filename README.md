# Wayfarer — Infinite Open-World Driving Game

**Phase 2: biomes & living terrain.** A seeded, infinite, chunk-streamed landscape with five climate-blended biomes, procedural triplanar surface detail, and deterministic instanced vegetation. Built on the Phase 1 world foundation: Three.js r187, TypeScript, Vite, WebGPU + WebGL2 fallback, Web Workers, floating origin, dynamic day/night sky, and a free-flight survey camera.

> This is still the world foundation for the driving game, not the final driving experience. Roads, vehicles, traffic, missions, physics, weather, audio, and full menus arrive in later phases.

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed by Vite (default `http://localhost:5173`). WebGPU requires HTTPS or localhost; the app automatically falls back to WebGL2 when WebGPU is unavailable or fails a probe draw.

```bash
npm run build         # type-check + production build
npm run preview       # serve the production build
npm test              # 31 unit tests (noise, streaming, origin, terrain, biomes, vegetation, overlooks)
npm run test:browser  # 9 Playwright browser tests (requires Chromium)
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
| R | Reset viewpoint |
| P | Pause/resume day cycle |
| V | Toggle vegetation |
| B | Toggle biome overlay |
| L | Toggle LOD debug colors |
| H | Hide/show HUD |
| F3 | Performance overlay |

The settings panel exposes the world seed, time-of-day slider, day-cycle toggle, graphics preset, vegetation, wind, surface detail, biome overlook travel, biome/LOD/wireframe debug, performance overlay, and a shareable world link. Share URLs include `vegetation=0|1` alongside seed, position, hour, quality, and renderer.

## What Phase 2 adds

- **Biomes:** valley meadows, conifer highlands, golden steppe, alpine tundra, and snowline peaks. Seeded temperature/moisture fields blend continuously with altitude and slope; rock and snow masks expose cliffs and summits. The HUD names the live biome, and `B` shows a climate overlay.
- **Surface detail:** three seamless 256×256 procedural textures (grass, rock, snow) are triplanar-projected in world space, blended by biome/slope/snow, and faded with distance. Texture periods divide the floating-origin wrap so rebasing does not slide the ground pattern. Macro albedo adds forest-duff and steppe-curing variation.
- **Vegetation:** pine, aspen, shrub, grass, and rock are placed in canonical world cells by workers, grounded on the actual terrain mesh, and packed into five global instanced batches. Trees/shrubs use procedural alpha-tested foliage sprays over solid inner mass; grass uses bent blades. Quality presets bound density, range, and capacity; coarse LODs keep a stable subset of the same plants. Nearest-first budgeting keeps the foreground stable, wind phase is origin-invariant, and range edges fade/scale instead of popping.
- **Lifecycle:** vegetation rebuilds on terrain revision, camera movement, origin shift, or settings change; all geometries, materials, instance buffers, and textures are disposed on teardown. Terrain materials are shared per LOD/mode. `prefers-reduced-motion` starts with wind disabled.
- **Biome overlooks:** deterministic seed-local survey jumps to each climate region; the default spawn prefers a forest overlook so the living terrain is visible immediately.

## What Phase 1 still provides

- **Renderer:** `WebGPURenderer` with AgX tone mapping, MSAA, PBR terrain material, sky-derived environment lighting, directional sun/moon, hemisphere fill, and a WebGL2 fallback path with a probe draw and runtime device-loss fallback.
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
                          generator, vegetation field/manager, viewpoints, sky
  rendering/              renderer factory, terrain material, surface textures,
                          foliage textures, vegetation geometry
  ui/                     HUD/settings shell and styles
  workers/                terrain worker entry
  utils/                  seeded RNG and math
tests/                    unit + browser regression tests
```

See [docs/PHASE1.md](docs/PHASE1.md) for the original world foundation and [docs/PHASE2.md](docs/PHASE2.md) for biomes, surfaces, vegetation, quality budgets, and validation notes.

## Performance notes

- Terrain and vegetation placement run in 2–4 Web Workers depending on preset; the main thread only uploads finished buffers and packs instances.
- Pixel ratio is capped per preset and by a total-pixel budget to protect 4K/retina displays.
- Vegetation uses five instanced draw batches with fixed capacities and nearest-first budgeting. Low/Balanced/High budgets are documented in [docs/PHASE2.md](docs/PHASE2.md); budget truncation is reported in debug stats. The Low preset also uses reduced-detail plant geometry.
- Chunk geometry, materials, instance buffers, and textures are disposed on eviction, seed change, quality change, and teardown.
- The performance overlay reports FPS, draw calls, triangles, geometries, cached/queued tiles, origin rebases, LOD distribution, plant count/capacity, and instanced batch count.
- Browser validation in this repository's sandbox uses Chromium/SwiftShader (software WebGL2). It is functional coverage, not a hardware-GPU benchmark; a real WebGPU adapter was not available there.

## Assets and licenses

No paid assets. Terrain, sky, stars, moon, biomes, surface textures, vegetation, and materials are procedural. Fonts are self-hosted via Fontsource (SIL OFL). Three.js and its examples are MIT/BSD licensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
