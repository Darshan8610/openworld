# Wayfarer — Phase 2: Biomes & Living Terrain

Phase 2 turns the streamed heightfield into a climate-driven landscape. It adds five
softly blended biomes, world-space surface detail, and deterministic instanced
vegetation. The Phase 1 landform, worker streaming, floating origin, survey camera,
day/night cycle, shareable URLs, and graphics presets remain intact. Roads, vehicles,
traffic, missions, and physics are still out of scope.

## Biomes

`src/world/biomes.ts` evaluates two independent, seeded low-frequency climate fields
(temperature and moisture) together with altitude and local slope. The result is a
normalized weight vector for:

| Biome | Character |
|---|---|
| Valley meadows | Broadleaf trees, shrubs, dense grass, green-gold ground |
| Conifer highlands | Pine forest, cooler slopes, scattered rock |
| Golden steppe | Open grassland, low shrubs, warm dry tones |
| Alpine tundra | Sparse low vegetation, exposed rock, cold grey-green ground |
| Snowline peaks | Snow cover, rock outcrops, almost no vegetation |

Weights are continuous, so neighbouring tiles blend rather than switching palette at a
border. Altitude and slope also produce rock and snow masks. The same seed, position,
height, and slope always produce the same climate and vegetation. Climate is separate
from the heightfield: Phase 2 does not alter Phase 1 terrain heights.

## Surface material

`src/rendering/surface-textures.ts` generates three small (128×128) seamless,
mipmapped procedural textures: grass, rock, and snow. No external image assets are
required. `terrain-material.ts` blends them in world space with triplanar projection,
biome weights, slope/altitude masks, and distance-based detail fade. Texture periods
are powers of two and divide the 1024 m floating-origin wrap, so rebasing does not
slide the surface pattern. A debug biome material can replace the natural material
without rebuilding terrain.

## Vegetation

`src/world/vegetation-field.ts` places plants in canonical world-space cells. A cell's
seed determines position, species suitability, scale, rotation, and colour variation.
Coarse LODs visit a deterministic subset of the same accepted cells; they never boost
acceptance probability, so distant trees cannot appear from nowhere when a finer tile
arrives. Tile ownership is half-open, preventing duplicate boundary plants. Plant Y is
sampled from the actual generated terrain triangles (including skirts), not a separate
approximate height lookup.

`src/world/vegetation-manager.ts` packs visible instances into five global
`InstancedMesh` batches: pine, aspen, shrub, grass, and rock. Quality presets set fixed
capacities, density, tree range, and grass range. Rebuilds are throttled and triggered
by terrain revision, camera movement, origin shifts, or settings changes. Instances
fade/scale near their range edge; a height-weighted TSL wind shader bends foliage.
Pine, aspen, and rock cast shadows. All geometries, materials, instance buffers, and
textures are disposed on teardown.

### Quality budgets (maximum instances per species)

| Preset | Pine | Aspen | Shrub | Grass | Rock |
|---|---:|---:|---:|---:|---:|
| Low | 900 | 350 | 1,400 | 6,500 | 700 |
| Balanced | 2,200 | 800 | 3,500 | 14,000 | 1,600 |
| High | 4,000 | 1,400 | 6,000 | 24,000 | 2,800 |

Density multipliers are 0.55 / 0.8 / 1.0. Tree ranges are 720 / 1100 / 1500 m; grass
ranges are 140 / 220 / 300 m. If a budget is reached, the manager reports truncation in
debug stats rather than allocating unbounded memory.

## Controls & UI

- `V` — toggle vegetation
- `B` — toggle biome overlay
- `L` — toggle LOD overlay (mutually exclusive with biome overlay)
- Settings panel — vegetation, wind, surface detail, biome overlay, LOD, wireframe,
  quality, seed, time, camera mode, and share link
- HUD — current biome name, plant count/capacity, instanced batch count, FPS, draw
  calls, triangles, GPU memory estimate, tile counts, and origin shifts
- URL — adds `vegetation=0|1` alongside existing Phase 1 parameters
- `prefers-reduced-motion` — starts with wind disabled

## Validation

- `npm run build` — TypeScript check + production bundle
- `npm test` — 28 unit tests (noise, streaming/origin, terrain generation, biome
  determinism/weights/continuity, texture periodicity, vegetation determinism/LOD
  subset/boundary ownership/mesh grounding, geometry/budgets)
- `npm run test:browser` — Playwright/WebGL2 smoke, streaming, seed/share, settings,
  vegetation toggle, biome overlay, wind/detail switches, and origin-rebase vegetation coverage

Browser validation in this environment uses Chromium with SwiftShader (software
WebGL2). It is functional coverage, not a hardware-GPU performance benchmark. WebGPU
compilation paths are exercised through Three.js node materials, but a real WebGPU
adapter was not available here.

## Deferred

Roads, drivable vehicles, physics, traffic, missions, audio, multiplayer, and
biome-specific gameplay remain future phases. Phase 2 is a visual/world-generation
foundation only.
