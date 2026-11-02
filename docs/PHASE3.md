# Wayfarer — Phase 3: Roads Through the Wild

**Status: implemented / verified.** Phase 3 turns the living terrain foundation into a
road-trip world: graded scenic highways, named route surveys, roadside furniture,
overlook pullouts, richer vegetation and cliffs, and an Ultra graphics preset.

Phase 3 deliberately stays within the roadmap. It adds **roads, routes and world
props**, not drivable vehicles. The route-following camera is a survey tool; vehicle
physics, traffic, missions, weather, water, audio and full menus remain later phases.

## What was added

- An infinite, seed-warped scenic road network graded into the height field.
- Two-lane asphalt carriageways with gravel shoulders, double-yellow centre lines,
  white edge lines, crown/crossfall and periodic widened overlook pullouts.
- Three named launch routes into the same network: **Cedar Pass**, **Golden Ridge**
  and **Snowline Run**. `G` follows the nearest corridor; the settings panel can jump
  between named routes.
- Seven roadside prop batches: guardrails, reflector posts, route shields, direction
  signs, benches, overlook kiosks and bollards.
- Ten vegetation/rock batches: pine, spruce, aspen, birch, shrub, fern, grass,
  wildflowers, weathered rock and stratified cliff outcrops.
- Road-aware vegetation clearance: plants never spawn in the carriageway, shoulders,
  pullouts or the immediate cut/fill formation.
- An **Ultra** preset with denser tessellation, longer horizons, 4096px soft shadows,
  higher fixed budgets, ultra-detail silhouettes and GTAO ambient occlusion.

## Road network

`src/world/road-network.ts` is a random-access analytic network. Corridors are smooth
functions of world X, repeated every 2048 m in Z. There is no chunk-local path state
and no accumulated integration, so any tile can ask for the same road at any time.

The centreline profile is a cached monotone cubic through the natural height field.
`TerrainField.height()` grades a formation into that profile and blends it back to the
natural landform over an 18 m cut/fill transition. The untouched Phase 1/2 landform is
still available as `naturalHeight()`.

`src/world/road-geometry.ts` clips corridors to tiles by centreline ownership, then
drapes every lane/marking strip on the tile's actual rendered triangles. Fine tiles
resolve the graded formation; coarse tiles keep a continuous distant road silhouette.
Markings are geometry strips with a paint mask, not a stretched decal. UVs wrap at
1024 m so texture phase survives floating-origin rebases.

Pullouts repeat every 1536 m and widen the right shoulder into a rest area. Benches,
kiosks and bollards are placed canonically inside those pullouts.

## Routes & survey travel

`SurveyCamera.startRoute()` moves the camera along a corridor at a bounded survey
speed. It is explicitly **not** a vehicle controller: there is no suspension, tyre
model, traffic or driving input. Manual input releases the route and returns to free
flight. The HUD shows the active route name/number and survey speed.

Shareable URL parameters:

- `route=cedar|golden|snowline` — launch into a named route.
- `roads=0|1` — hide/show the road network and props.
- Existing Phase 2 parameters (`seed`, `x`, `z`, `hour`, `quality`, `renderer`,
  `vegetation`, `postfx`) remain valid.

## World props

`src/world/road-manager.ts` attaches worker-built road meshes to the same streamed
tiles as terrain and packs roadside furniture into seven bounded, nearest-first
instanced batches. Props fade at range edges, cast/receive shadows where appropriate,
and are disposed on quality change, seed change and teardown. Sign faces are crisp
procedural canvas textures; no downloaded art is required.

## Vegetation & cliffs

The Phase 2 five-batch system is expanded to ten batches. New silhouettes include a
narrow subalpine spruce, white-barked birch with dark bands, arching fern fronds with
paired leaflets, dedicated wildflower clumps, and stratified cliff outcrops with mossy
ledges. All placement remains canonical, deterministic, LOD-stable and grounded on the
rendered terrain triangles. A seeded cover field still clusters groves and meadows.

## Ultra graphics

`src/config.ts` adds `ultra` and per-preset geometry detail, pixel caps, prop budgets
and an ambient-occlusion flag. `src/rendering/post-processing.ts` rebuilds its chain on
preset changes:

- Low: direct MSAA path, no post chain.
- Balanced / High: HDR scene pass → bloom → filmic output → FXAA → vignette.
- Ultra: the same chain plus half-resolution GTAO with a depth-aware denoise pass,
  modulating indirect lighting only so direct sun and painted markings stay crisp.

Ultra also raises terrain segments to 36, view distance to 14 km, shadow maps to
4096px, and plant/prop capacities. It is intended for hardware GPUs; software WebGL2
is used only for functional regression coverage in this repository.

### Fixed vegetation budgets (maximum instances per species)

| Preset | Pine | Aspen | Shrub | Grass | Rock | Spruce | Birch | Fern | Flowers | Cliff |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low | 650 | 250 | 900 | 4,000 | 450 | 200 | 160 | 500 | 250 | 100 |
| Balanced | 2,200 | 800 | 3,000 | 12,000 | 1,400 | 700 | 500 | 1,800 | 900 | 350 |
| High | 4,000 | 1,400 | 5,000 | 22,000 | 2,400 | 1,200 | 900 | 3,200 | 1,600 | 650 |
| Ultra | 6,500 | 2,200 | 8,000 | 36,000 | 3,600 | 2,200 | 1,600 | 5,500 | 2,800 | 1,100 |

Roadside props use seven additional fixed budgets per preset. Budget truncation is
reported in debug stats rather than allocating unbounded memory.

## Controls

- `G` — start/stop the nearest scenic route survey.
- `T` — scenic auto-flight (releases route following).
- `V` — vegetation, `B` — biome overlay, `L` — LOD overlay, `H` — HUD, `F3` — stats.
- Settings panel — scenic route selector, road network toggle, Ultra preset, plus all
  Phase 2 controls.

## Validation

- `npm run build` — TypeScript check + production bundle.
- `npm test` — 36 unit tests: noise, streaming/origin, terrain generation, biomes,
  vegetation determinism/LOD/grounding/clearance, road network determinism, graded
  formation, draped markings, prop packing/buffer transfer, geometry quality tiers,
  foliage sprays and biome overlooks.
- `npm run test:browser` — 11 Playwright/WebGL2 tests: boot/streaming, seed/share, time
  slider, origin rebase, preset rebuild, vegetation toggle, biome overlay, origin-safe
  vegetation, wind/detail switches, scenic route survey + road toggle, and an Ultra
  ambient-occlusion boot smoke test.

Browser validation uses Chromium/SwiftShader (software WebGL2). It is functional
coverage, not a hardware-GPU benchmark. A real WebGPU adapter was not available here.

## Acceptance criteria

- Roads are deterministic, continuous and graded into the terrain.
- Road ribbons and markings drape on streamed tiles and survive origin rebases.
- Routes can be followed by the survey camera and shared by URL.
- Roadside props are deterministic, bounded, nearest-first and correctly disposed.
- Vegetation is expanded, LOD-stable, grounded and kept clear of the road formation.
- Ultra enables denser detail and ambient occlusion; lower presets stay lighter.
- Build, unit tests and browser tests pass.

## Deferred

Drivable vehicles, physics, traffic, missions, weather, water, audio, multiplayer and
full menus remain future phases.
