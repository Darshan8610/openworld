# Wayfarer — Infinite Open-World Driving Game

**Phase 1: world foundation.** A seeded, infinite, chunk-streamed alpine terrain renderer with a dynamic day/night sky, floating origin, and a free-flight survey camera. Built with Three.js r187, TypeScript, Vite, WebGPU + WebGL2 fallback, and Web Workers.

> This is the foundation for the driving game, not the final driving experience. Roads, biomes, vegetation, vehicle physics, weather, audio, and full menus arrive in later phases.

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed by Vite (default `http://localhost:5173`). WebGPU requires HTTPS or localhost; the app automatically falls back to WebGL2 when WebGPU is unavailable or fails a probe draw.

```bash
npm run build      # type-check + production build
npm run preview    # serve the production build
npm test           # unit tests (noise, streaming, origin, mesh generation)
npm run test:browser  # Playwright browser tests (requires a Chromium install)
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
| L | Toggle LOD debug colors |
| H | Hide/show HUD |
| F3 | Performance overlay |

The settings panel (top-right) exposes the world seed, time-of-day slider, day-cycle toggle, graphics preset, LOD/wireframe toggles, and a shareable world link.

## What Phase 1 includes

- **Renderer:** `WebGPURenderer` with AgX tone mapping, MSAA, PBR terrain material, sky-derived environment lighting, directional sun/moon, hemisphere fill, and a WebGL2 fallback path with a probe draw and runtime device-loss fallback.
- **Sky:** Three.js `SkyMesh` analytic Rayleigh/Mie atmosphere, procedural layered clouds, seeded star sphere with a galactic band, procedural moon, and a 12-minute day/night cycle.
- **Terrain:** deterministic seeded simplex fBm + ridged multifractal + domain warping + valley carving, streamed as a quadtree of chunks around the camera. Six LOD levels, exact shared borders, vertical skirts, frustum culling, bounded LRU cache, and transferable worker-generated buffers.
- **Floating origin:** simulation coordinates stay in JS doubles; GPU coordinates are re-centered every 2048 m so precision does not degrade at large distances.
- **Survey camera:** fixed 120 Hz update with render interpolation, terrain clearance, scenic auto-flight, and manual free flight.
- **UI shell:** loading progress, minimal HUD, settings panel, seed input, time control, graphics presets, LOD/wireframe debug, performance overlay, and URL sharing.

## Architecture

```text
src/
  config.ts               central tuning
  main.ts                 bootstrap
  core/                   game loop, fixed clock, input, floating origin, survey camera
  world/                  noise, terrain field, quadtree tiles, worker pool, generator, sky
  rendering/              renderer factory, terrain material
  ui/                     HUD/settings shell and styles
  workers/                terrain worker entry
  utils/                  seeded RNG and math
tests/                    unit + browser regression tests
```

See [docs/PHASE1.md](docs/PHASE1.md) for the technical walkthrough, tuning guide, and known limitations.

## Performance notes

- Terrain generation runs in 2–4 Web Workers depending on preset; the main thread only uploads finished buffers.
- Pixel ratio is capped per preset and by a total-pixel budget to protect 4K/retina displays.
- Chunk geometry, materials, and textures are disposed on eviction, seed change, and quality change.
- The performance overlay reports FPS, draw calls, triangles, geometries, cached/queued tiles, origin rebases, and LOD distribution.

## Assets and licenses

No paid assets. Terrain, sky, stars, moon, and materials are procedural. Fonts are self-hosted via Fontsource (SIL OFL). Three.js and its examples are MIT/BSD licensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
