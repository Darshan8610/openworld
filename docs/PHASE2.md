# Wayfarer — Phase 2: Biomes & Living Terrain

**Status: reconstructed / graphics-upgraded / verified.** This phase turns the streamed heightfield into a
climate-driven landscape with layered surface detail and deterministic instanced
vegetation. The Phase 1 landform, worker streaming, floating origin, survey camera,
day/night cycle, shareable URLs, and graphics presets remain intact. Roads, vehicles,
traffic, missions, physics, weather, audio, and full menus are still out of scope.

The reconstruction started from the specified Phase 2 baseline (`1682449`) and
rebuilds the weak visual/technical areas rather than changing the roadmap:

- richer procedural plant silhouettes with dense alpha-tested foliage sprays and grove/meadow clustering;
- higher-resolution, layered ground textures and stronger macro climate variation;
- continuous biome-weight rendering instead of dominant-biome-only debug color;
- nearest-first instance budgeting and origin-invariant wind phase;
- shared terrain materials per LOD/mode to reduce material churn;
- tighter, quality-scaled soft sun shadows and lower survey altitude for readable foreground;
- a cinematic post chain (bloom, FXAA, vignette) on Balanced/High, bypassed on Low;
- deterministic seed-local biome overlooks for survey travel.

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

The worker now transfers a second per-vertex attribute, `biomeWeights`, containing the
first four normalized biome weights. The snowline weight is `1 - sum(weights)`. The
terrain material uses this for a continuous biome debug palette and a subtle ground
tint, while the original `surface` attribute still carries rock mask, snow mask, and
dominant biome id for compatibility/HUD lookup.

Macro albedo includes seeded broad variation plus forest-floor duff and steppe curing
patches, so large slopes do not read as a single flat color sheet.

## Surface material

`src/rendering/surface-textures.ts` generates three seamless, mipmapped 256×256
procedural textures: grass, rock, and snow. RGB is a near-neutral detail multiplier;
alpha stores a height field for bump. No external image assets are required.

`terrain-material.ts` blends them in world space with triplanar projection,
biome/slope/snow masks, and distance-based detail fade. Texture periods are powers of
two and divide the 1024 m floating-origin wrap, so rebasing does not slide the surface
pattern. Detail fade now reaches farther into the foreground survey view, and bump
relief blends grass/rock height instead of using rock only.

Terrain materials are shared per LOD level and debug mode. Tiles still own their
geometry, but material disposal happens once in the terrain material factory rather
than once per tile. Wireframe/detail/origin updates apply to the shared material set.

## Vegetation

`src/world/vegetation-field.ts` places plants in canonical world-space cells. A cell's
seed determines position, species suitability, scale, rotation, and colour variation.
Coarse LODs visit a deterministic subset of the same accepted cells; they never boost
acceptance probability, so distant trees cannot appear from nowhere when a finer tile
arrives. Tile ownership is half-open, preventing duplicate boundary plants. Plant Y is
sampled from the actual generated terrain triangles, not a separate approximate height
lookup.

`src/rendering/vegetation-geometry.ts` builds one merged, vertex-colored geometry per
species. The reconstruction replaces simple cone/blob silhouettes with:

- pine: irregular whorls of drooping needle-spray branch cards + inner tufts (no solid cone);
- aspen: pale trunk/branches + ellipsoid leaf-cluster cards;
- shrub: woody base + mounded sage/leaf cards;
- grass: tapered, bent blades with root-to-tip color, seed heads, and per-instance wildflower heads;
- rock: distorted, faceted stone with mossy tops and grounded base.

`src/rendering/foliage-textures.ts` generates deterministic 256×256 alpha foliage
sprays for pine, aspen, and shrub. A per-vertex `leaf` mask selects texture alpha/color,
while solid trunk/branch/inner-crown vertices remain opaque. A per-vertex `plantFlex`
attribute weights wind so bark stays planted and tips move more.

`src/world/vegetation-manager.ts` packs visible instances into five global
`InstancedMesh` batches: pine, aspen, shrub, grass, and rock. Quality presets set fixed
capacities, density, tree range, and grass range. Rebuilds are throttled and triggered
by terrain revision, camera movement, origin shifts, or settings changes.

Budgeting is nearest-first per species: if a budget is full, the closest accepted plants
win instead of whichever tile happened to be visited first. Range fade/scale happens in
the vertex shader. Wind phase is derived from canonical world coordinates modulo the
origin wrap, so a floating-origin rebase does not restart or slide a plant's sway.
Pine, aspen, and rock cast shadows. All geometries, materials, instance buffers, and
foliage textures are disposed on teardown.

The Low preset uses a reduced-detail plant geometry variant (fewer cards/blades) while
keeping the same canonical placement and five-batch architecture.

### Quality budgets (maximum instances per species)

| Preset | Pine | Aspen | Shrub | Grass | Rock |
|---|---:|---:|---:|---:|---:|
| Low | 900 | 350 | 1,400 | 6,500 | 700 |
| Balanced | 2,200 | 800 | 3,500 | 14,000 | 1,600 |
| High | 4,000 | 1,400 | 6,000 | 24,000 | 2,800 |

Density multipliers are 0.55 / 0.8 / 1.0. Tree ranges are 720 / 1100 / 1500 m; grass
ranges are 140 / 220 / 300 m. If a budget is reached, the manager reports truncation in
debug stats rather than allocating unbounded memory.

## Survey overlooks

`src/world/viewpoints.ts` adds a deterministic, seed-local overlook search. It does not
alter terrain or vegetation; it only finds a pleasant survey position inside a requested
climate region. The settings panel exposes a **Biome overlook** selector for jumping to
meadow, forest, steppe, tundra, or snowline country. When no explicit `x`/`z` URL
coordinates are supplied, the initial survey spawn prefers a conifer-highland overlook
so the living terrain is visible immediately.

The survey camera now flies lower (about 45–55 m above ground in scenic mode) so grass,
shrubs, and surface detail are readable. `R` resets to the current seed's home overlook.

## Controls & UI

- `V` — toggle vegetation
- `B` — toggle biome overlay
- `L` — toggle LOD overlay (mutually exclusive with biome overlay)
- Settings panel — vegetation, wind, surface detail, biome overlook, biome overlay, LOD,
  wireframe, quality, seed, time, camera mode, and share link
- HUD — current biome name, plant count/capacity, instanced batch count, FPS, draw
  calls, triangles, GPU memory estimate, tile counts, and origin shifts
- URL — adds `vegetation=0|1` and `postfx=0|1` alongside existing Phase 1 parameters
- `prefers-reduced-motion` — starts with wind disabled

## Lighting / shadow polish

Sun shadow frusta are quality-scaled instead of one very large fixed box: Low 600 m
half-width (shadows off), Balanced 700 m, High 1200 m, with soft (PCF) filtering and a
2048px map on Balanced/High. The shadow centre snaps to texels to reduce swimming.

`src/rendering/post-processing.ts` adds a lightweight cinematic chain on Balanced/High:
HDR scene pass → threshold bloom → filmic output transform → FXAA → subtle vignette.
Low bypasses the chain and keeps the direct MSAA path so software/mobile GPUs stay
playable. The settings panel and `postfx=0|1` URL parameter toggle it.

## Validation

- `npm run build` — TypeScript check + production bundle
- `npm test` — 31 unit tests: noise, streaming/origin, terrain generation, biome
  determinism/weights/continuity, texture periodicity, vegetation determinism/LOD
  subset/boundary ownership/mesh grounding, geometry/budgets, foliage sprays,
  quality-aware geometry, and deterministic biome overlooks
- `npm run test:browser` — 9 Playwright/WebGL2 tests: boot/streaming, seed/share, time
  slider, floating-origin rebase, graphics preset rebuild, vegetation toggle, biome
  overlay, origin-rebase vegetation coverage, and wind/detail switches

Browser validation in this environment uses Chromium with SwiftShader (software
WebGL2). It is functional coverage, not a hardware-GPU performance benchmark. WebGPU
compilation paths are exercised through Three.js node materials, but a real WebGPU
adapter was not available here.

If the standard Playwright browser download is unavailable, the suite also accepts an
external Chromium executable:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm run test:browser
```

## Acceptance criteria

- Biomes are deterministic and continuous.
- Vegetation is deterministic and LOD-stable.
- Plants are grounded on rendered terrain triangles.
- Vegetation stays within fixed budgets and reports truncation.
- Floating origin still works with vegetation and origin-invariant wind phase.
- Biome overlay uses continuous weights rather than only dominant ids.
- Vegetation, wind, and surface-detail toggles work.
- Build, unit tests, and browser tests pass.

## Deferred

Roads, drivable vehicles, physics, traffic, missions, audio, multiplayer, and
biome-specific gameplay remain future phases. Phase 2 is a visual/world-generation
foundation only.
