# Phase 1 — World Foundation

## Scope

Phase 1 delivers the rendering and world-streaming substrate the later driving phases depend on:

1. Vite + TypeScript project.
2. WebGPU renderer with WebGL2 fallback.
3. Dynamic day/night sky with analytic scattering, clouds, stars, and moon.
4. Infinite deterministic chunked terrain with quadtree LOD.
5. Floating-origin recentering.
6. A survey camera and minimal settings/HUD shell for testing the world.

It deliberately does **not** include roads, biomes, vegetation, vehicles, weather, water, audio, or the full menu system. Those are Phases 2–9.

## Rendering path

`src/rendering/renderer.ts` creates a `WebGPURenderer`. Before attaching the canvas it renders a tiny probe scene; some drivers expose WebGPU but fail on the first real buffer allocation. If the probe or initialization fails, the factory retries with `forceWebGL: true`. A runtime device-loss handler also falls back once to WebGL2 by reloading with `?renderer=webgl`, preserving the shared seed/coordinates in the URL.

Tone mapping is AgX. The terrain uses a `MeshStandardNodeMaterial` with procedural albedo from the worker plus two octaves of TSL noise for grain/mottling. Environment lighting is a PMREM capture of the sky, refreshed at most every 8 seconds and scaled down at night. Shadows use a single directional cascade-like ortho frustum snapped to texels; full CSM is a later polish item.

## Sky and day/night

`src/world/sky.ts` wraps Three.js `SkyMesh` (Preetham analytic Rayleigh/Mie). The sun direction is computed from a fixed summer-solstice declination and the current solar hour. A seeded star sphere concentrates a third of its points along a tilted galactic band; a procedural moon uses noise-based crater shading. Clouds are the layered procedural clouds built into `SkyMesh`, not volumetric weather.

The day cycle advances one full day every 720 simulated seconds by default. The time slider pauses the cycle; `P` resumes it. Fog color tracks the sky horizon so distant terrain dissolves into the atmosphere.

## Terrain generation

`TerrainField` is a pure function of world XZ and seed:

- Domain-warped simplex fBm for continent-scale variation.
- Ridged multifractal for mountain chains.
- Absolute-noise valley carving for river-like lowlands.
- Broad mass noise and rolling hills.
- Low-amplitude gully/detail noise for erosion-like texture.

Albedo is computed per vertex from altitude, slope, and noise: meadow → dry grass → rock → snow. This is an alpine material study, not the full climate-driven biome system.

`generateTile()` builds indexed geometry with positions, normals, colors, and downward skirts. It runs in `terrain.worker.ts` and returns transferable `Float32Array`/`Uint32Array` buffers. The worker caches the `TerrainField` per seed so repeated chunks do not rebuild permutation tables.

## Streaming and LOD

`selectTiles()` builds a quadtree over a square window of root tiles (4096 m). A node splits when the camera is within `splitDistance × size`; max depth 6 gives 128 m leaves. The result is an exact partition: no holes, no overlaps.

`TerrainManager` requests missing tiles through a bounded nearest-first `TerrainPool`. Old terrain for a root remains visible until every replacement leaf is ready, then the root swaps atomically. Roots outside the view window are retired. An LRU cache evicts unused tiles and disposes their geometry/materials.

LOD seams are hidden by exact shared border heights plus vertical skirts. Geomorphing was prototyped but removed from Phase 1 because the WebGL2 fallback produced driver-specific artifacts; the streaming contract is locked first, and smooth morph transitions are a later polish item.

## Floating origin

`FloatingOrigin` keeps an absolute origin in JS doubles. When the camera moves more than 2048 m from it, the origin snaps to a new 2048 m grid point and every render object is translated by the delta. GPU coordinates therefore stay small. Terrain shader noise inputs are wrapped to a bounded range; macro albedo remains world-space.

## Survey camera

`SurveyCamera` runs at a fixed 120 Hz with render interpolation. It supports WASD/arrows, Q/E altitude, Shift boost, drag/pointer-lock look, wheel speed adjust, terrain clearance, and a scenic auto-flight mode. This is explicitly a world-preview rig, not a placeholder vehicle controller.

## Tuning

Edit `src/config.ts`:

- `QUALITY.*`: segments per tile, root radius, view distance, pixel ratio, shadows, worker count.
- `CONFIG.terrain`: root size, max depth, split distance, cache limit, skirt fraction.
- `CONFIG.origin.rebaseDistance`: floating-origin threshold.
- `CONFIG.camera`: speed, boost, clearance, damping.
- `CONFIG.sky`: initial hour, day length, latitude, star count, environment refresh interval.

Terrain shape lives in `src/world/terrain-field.ts`; noise octaves/frequencies/amplitudes are documented inline.

## Tests

- `tests/noise.test.ts`: determinism, continuity, non-tiling, far-field bounds.
- `tests/streaming.test.ts`: exact quadtree partition, LOD distribution, bounded selection, floating-origin preservation, fixed-clock catch-up.
- `tests/terrain-generator.test.ts`: finite indexed meshes, shared-edge equality, cross-LOD height agreement, skirts.
- `tests/browser/world.spec.ts`: boot, seed regeneration, time slider, large-coordinate rebase, quality change.

Run:

```bash
npm test
npm run test:browser
```

## Known limitations / next phases

- Single alpine material study; full biomes in Phase 2.
- No roads/props/vegetation yet (Phases 2–3).
- No vehicle physics or cameras beyond survey rig (Phase 4).
- Layered clouds only; weather/water/post-FX in Phase 6.
- No audio (Phase 7).
- Minimal settings shell; full menus/photo/mobile in Phase 8.
- Adaptive quality and deeper profiling in Phase 9.
- WebGPU path is implemented and probed, but CI here exercises the WebGL2 fallback; real-GPU WebGPU validation is recommended on target hardware.
