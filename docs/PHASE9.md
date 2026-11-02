# Wayfarer — Phase 9: Water & Environment

**Status: implemented / unit- and integration-verified / browser suite written but not executed in this sandbox (no Chromium binary).**

Phase 9 adds water and weather to the same streamed world Phases 1–6 built: real
water bodies carved into the deterministic terrain, a wave surface that the
renderer and the physics share, buoyancy, swimming and diving, splashes and
precipitation, and a seeded weather front that drives light, sky, fog, water
state, ground wetness and particle load.

Nothing here is a separate demo. The water field is a function of `(seed, x, z)`
and is consumed by the terrain field, the gameplay query facade, the physics
substep loops, the character controller, the renderer and the UI.

---

## 1. What Phase 9 adds

| System | Module | Summary |
|---|---|---|
| Hydrology | `src/world/water-field.ts` | Deterministic lakes/ponds/reservoirs/wetlands/seas on a seeded lattice, plus rivers; `sampleAt()` answers "is there water here", `carve()` is the only thing that lowers terrain for water, `waveOffset()` is the authoritative wave height. |
| River corridors | `src/world/river-network.ts` | Seeded corridor curves with a monotone-Hermite downhill bed profile, bank width, cross-section and carve weight. |
| Water rendering | `src/world/water-manager.ts`, `src/rendering/water-material.ts` | Streamed surface tiles at three LODs, depth/fresnel/shoreline shading, analytic wave normals, shoreline foam, sun glitter, rain pockmark normals. TSL node material compiled by the same renderer for WebGPU **and** WebGL2. |
| Water query | `src/world/world-query.ts`, `src/world/world-queries.ts` | `WaterQuery` (body id, kind, surface height, depth, flow, wave amplitude, shoreline) registered as a provider, so `surfaceAt()` returns `water` and every gameplay system asks one authority. |
| Buoyancy | `src/physics/buoyancy.ts` | Submerged-fraction buoyancy, quadratic drag, surface currents, angular damping and a righting offset; applied inside Rapier's substep loop (`PhysicsWorld.preStep`) and inside the prop solver's substep loop (`PropPhysicsWorld.forceField`). |
| Swimming | `src/character/locomotion.ts` | Swim mode with buoyant vertical spring, currents, dive/climb control and a hard bed clamp so a dive cannot pass through the lake bed. |
| Weather | `src/environment/weather.ts` | Eleven conditions from an advecting seeded front; eased numeric state (45 s half-life) driving cloud cover/density/speed, sun and ambient scale, fog, wind, sea state, rain/snow and ground wetness/snow cover. |
| Particles | `src/effects/particles.ts` | One pooled system, two point layers (fine/coarse), rain, snow, splash and spray emitters, per-particle ground/water collision, hard per-preset budget, free-list allocation. |
| Sky | `src/world/sky.ts` | Cloud coverage/density/speed, sun and ambient scaling and star occlusion driven by the weather state; the authored baseline is restored when weather hands control back. |

---

## 2. Contracts

These are load-bearing; changing them requires touching every consumer.

1. **One water authority.** `WaterField.sampleAt()` is the only answer to "is
   there water at `(x, z)`, how deep, which way does it flow". Terrain carving,
   the query facade, the water mesh, buoyancy, swimming, prop placement and
   particle collisions all read it.
2. **Water only lowers terrain.** `carve()` returns `{bed, weight}` and the
   terrain field interpolates `graded → bed`, so a lake bed can never be raised
   above the landform and a shoreline bed depth reaches exactly zero at the rim.
3. **The drawn surface is the queried surface.** `WaterField.waveOffset()` is the
   wave height for physics; `rendering/water-material.ts` evaluates the same three
   wave trains (`WATER_WAVES`) with a per-vertex phase. Rain pockmarks perturb the
   *normal only*, so they can never desynchronise the drawn surface from physics.
4. **Water never covers engineered ground.** Carving is gated on the *graded*
   terrain (natural landform + road earthwork), so a road embankment standing
   above a lake keeps its carriageway dry, and props are never placed in water or
   on its shoreline.
5. **Water forces run on the fixed step.** Buoyancy is applied inside the physics
   substep loops, never per render frame; `WaterManager` also advances its wave
   clock on the world's fixed clock.
6. **Canonical geometry.** Water tiles store canonical positions and only offset
   their mesh by the floating origin; a rebase never rebuilds a tile.
7. **No water feature without a fallback.** The water material is a TSL node
   material, so WebGPU and WebGL2 compile the same graph; quality presets select
   `waterDetail` 0–2 (flat → waves → waves + foam + glitter), never a
   backend-specific branch.

---

## 3. Hydrology

**Basins.** A coarse seeded lattice (default 3.3 km, `CONFIG.water.basinCell`)
adjudicates which cells may hold a body. Each candidate cell rolls a seeded
`lakeChance`/`seaChance`, picks 4 jittered candidate centres and 2 radii, and
probes 12 rim points. A cell only floods when

* the lowest rim probe stands `minBasinDepth` above the centre, and
* the mean rim stands `minBasinDepth × 1.6` above it (so a uniform slope is never
  excavated into a lake), **and**
* the resulting bed is below the landform.

The surface is `min(centre + basin × fill, rimMin − freeboard)`: always below the
spill point, so a basin cannot leak. The bed profile is
`surface − depth × (1 − t²)`, meeting the landform at the rim; the carve weight
fades with `1 − smoothstep(0.68, 1, t)`, so the shoreline is a real graded bank
and not a vertical wall.

Classification: `sea` (large-radius basins), `pond` (< 150 m), `wetland`
(depth < 1.8 m), `reservoir` (seeded ~22 % of lakes) and `lake` otherwise. Rivers
are a separate family (below). Waterfalls, tidal/coastal ocean at a global sea
level and scripted flooding are **not** implemented — see §8.

**Rivers.** `RiverNetwork` lays seeded corridors across the world. Each corridor
has a monotone-Hermite bed profile over station, so the channel flow is strictly
downhill; the water surface is derived from that profile, the channel is carved to
the profile with a bank cross-section, and the reported current is the corridor
tangent times a station-dependent speed. The monotone profile is what guarantees
"rivers flow downhill" — a test asserts the flow direction points to the lower end
of the sampled profile.

**Measured** (seed `wayfarer`, 6000 samples in ±12 km): 1.6 % wet; kinds
`{river 44, sea 35, lake 9, reservoir 7}`; max depth 37.7 m; 0 samples whose
surface sits below the terrain; ~65 ms for 6000 samples (≈11 µs/sample
including memoisation misses). Within ±2 km of the origin the world is 5 % wet,
which is the number that matters for streaming.

---

## 4. Rendering

* Tiles of `CONFIG.water.tileSize` metres at three LODs (`waterSegments` per
  preset) stream inside `waterRadius`, nearest first, with a hard `waterTiles`
  budget and a per-frame build budget.
* Every vertex is sampled: wet vertices sit on the surface with their depth,
  wave amplitude and canonical wave phase; dry vertices sit on the local water
  plane (found by a ring search, `surfaceNear`) a hair *below* the surface, or
  are buried under the ground when no water is nearby. A quad is emitted when any
  corner is wet, so the terrain cuts the water along the true shoreline instead of
  a grid-aligned staircase.
* A tile with no water is remembered in a bounded dry-tile set instead of
  consuming the mesh budget, so an empty region cannot starve a nearby lake.
* Shading: depth-driven shallow→deep colour with wave-damped depth factor,
  Schlick fresnel sky mix, shoreline foam from the depth attribute, sun glitter,
  and rain pockmark normals driven by the weather system.
* Underwater: the camera going below the displaced surface switches the scene fog
  to a short, tinted water fog (`CONFIG.water.underwater`) and hides the sky.

---

## 5. Physics

`BuoyancySolver` works on any body that reports a position, velocity and a
half-height, so both rigid-body paths share one implementation:

```
fraction   = clamp((surface − (y − halfHeight)) / (2 · halfHeight), 0, 1)
buoyancy   = g · (ρ_water / ρ_body) · fraction        (as an acceleration)
drag       = quadratic in velocity, scaled by fraction
current    = surface flow × fraction
righting   = force applied below the centre of mass
```

* **Props** (`PropPhysicsWorld.forceField`) — impulses are integrated inside the
  prop solver's substep loop, so a floating crate rides the same 120 Hz clock as
  its contacts.
* **Rapier** (`PhysicsWorld.preStep`) — applied as a per-substep impulse at a
  point below the centre of mass, with the canonical position recovered through
  `worldFromLocal`, so a floating body survives a floating-origin rebase without
  a teleport or a momentum reset.
* **Swimming** — `WaterManager.swimQuery` returns the *displaced* surface, the
  current and the bed; locomotion springs the swimmer to neutral buoyancy, is
  pushed by the current, and cannot dive through the bed.
* **Splash reporting** — `BuoyancySolver.onEntry` fires once per waterline
  crossing with impact speed, and the game turns it into particles plus a
  `world:propEnteredWater` event. The solver never touches rendering.

Body volume comes from the collider (`shapeVolume`) or, for prop shapes, from the
box/sphere extent; a body with no derivable volume gets no buoyancy rather than
an invented mass.

---

## 6. Weather, sky and particles

* The front is two seeded noise fields sampled at `(x, z)` and advected with game
  time, so two places 20 km apart can see different weather simultaneously.
* Severity selects a condition; local temperature (biome climate, altitude, hour)
  decides rain versus snow, which is why a snowline peak gets a blizzard while the
  valley below gets rain.
* Every numeric property eases toward its target with `1 − exp(−dt·ln2/halfLife)`
  (45 s), so lighting, fog, water state and particle load change continuously.
* `wetness` and `snowCover` integrate separately (rain wets, sun dries; snow
  accumulates, warmth melts) and are published through `WorldManager`'s ground
  condition, which makes `WorldQuery.surfaceAt()` return `snow` and changes grip.
* `seaState` drives `WaterField.setActivity`, i.e. the wave amplitude — the same
  value physics and rendering read.
* Particles: rain and snow fall in a box around the camera and recycle; splashes
  follow water entry/exit and prop entry, plus a swimmer wake; droplets are killed
  by the ground or water surface; allocation is O(1) from a per-layer free list
  and a saturated layer recycles rather than allocating.

---

## 7. Controls, UI and URLs

| Input | Action |
|---|---|
| `J` | Toggle the water surface (streaming + rendering; physics keeps running) |
| `N` | Cycle the weather override: auto → clear → cloudy → rain → storm → fog → snow → blizzard → auto |

The settings panel gains a **Water surfaces** switch with a live status line and a
**Weather** selector (auto + ten conditions). The bottom HUD shows the current
condition, and the performance overlay reports weather parameters, water tiles /
budget / triangles / bodies, particle count versus budget and bodies in water.

Share URLs accept `water=0|1` and `weather=auto|clear|…|blizzard`.

Debug/inspection hooks: `Game.snapshot()` exposes `water`, `weather`, `particles`,
`buoyancy` and `underwater` alongside the existing world state.

---

## 8. Known gaps (deliberately not faked)

| Area | Status |
|---|---|
| Waterfalls, flooded areas, global sea level / tides | Not implemented. Basins and rivers only; there is no waterfall geometry path, and the sea is a very large basin rather than a global ocean surface. |
| Multi-point hull buoyancy, planing, wave-making | Deferred to Phase 10 watercraft; the current model is a single-point approximation with a righting offset, documented in `buoyancy.ts`. |
| Refraction / reflection passes, caustics, underwater volumetrics | Not implemented. Fresnel colour mix and a tinted underwater fog only; no screen-space water pass. |
| Audio | No audio system exists in the repo yet; weather and water publish state (`world:weatherChanged`, `world:waterEntered`, `world:propEnteredWater`) for Phase 12 to consume. |
| GPU particles | Precipitation and splashes are CPU-simulated point layers (bounded, pooled). A GPU path for very large precipitation counts is a Phase 13 option, not a claim. |
| Rip currents, whirlpools, dams, water interaction with vehicles | Not implemented. |
| Browser verification | `tests/browser/phase9.spec.ts` is written but **not executed**: this sandbox has no Chromium binary. The unit suites cover the field, solver, streaming, weather and particles headlessly. |

---

## 9. Tests

Executed in this sandbox with `npx vitest run`:

```
Test Files  27 passed (27)
     Tests  225 passed (225)
```

Phase 9 coverage:

| Suite | What it pins |
|---|---|
| `tests/water-field.test.ts` | Body determinism per seed, seed sensitivity, water only where the column is real, surface at/above the carved ground, carve lowers only, rivers run downhill and carry a current, wave amplitude bounds, wave damping in shallows, sea-state response, reusable samples. |
| `tests/water-manager.test.ts` | Material uniforms drive without a GPU, tiles stay inside radius/budget, dry vertices hidden under the ground, tile LOD triangle bound, rebase moves tiles without rebuilding, queries agree with the field, enable/disable keeps geometry. |
| `tests/buoyancy.test.ts` | Wood floats at the analytic waterline, steel sinks, dry land gets no force, currents carry floating bodies, Rapier float settles, floats across a floating-origin rebase, collider volume derivation. |
| `tests/weather.test.ts` | Same seed/place/time → same state, seed and position sensitivity, eased (non-snapping) transitions, rain→snow by temperature and altitude, wetness/snow accumulation and drying, override handling, wind vector consistency. |
| `tests/particles.test.ts` | Hard budget never exceeded, precipitation thins out, splashes die out, recycled rather than unbounded, rain and snow separated, frame-rate tolerance, origin rebase keeps positions finite and local. |
| `tests/phase9-integration.test.ts` | Water streams through the real `WorldManager` order, query provider answers, origin rebase reaches the water layer, a Rapier body floats inside the world step, weather ground condition reaches the query. |
| `tests/phase9-world-smoke.test.ts` | The real hydrology, no stubs: a crate dropped into the nearest deep body floats at the reported surface with exactly one entry splash, and a character placed on that bed enters swim mode and rises toward the surface. |
| `tests/character.test.ts` | (extended) swimming reaches neutral buoyancy, water entry/exit fire once, **diving stops at the bed**. |
| `tests/browser/phase9.spec.ts` | Written, **not run**: water budget in a real frame, pinned storm drives rain/particles/sea state, `J` toggles water. |

`npx tsc --noEmit` is clean and `npm run build` succeeds (last run: 1.29 s).

---

## 10. Performance implications

* **Water streaming** — up to `waterTiles` meshes (64 at High), each
  `waterSegments[level]²` quads; the build loop is time-budgeted per frame
  (~4 ms) and tiles are rebuilt only on LOD or tile-ring changes. Geometry is
  static per tile, so per-frame cost is a handful of draw calls plus uniform
  updates.
* **Sampling** — `WaterField.probe()` memoises on a 4 m grid with a bounded table,
  so the per-vertex cost during a tile build is mostly one map lookup.
  Buoyancy samples once per body per substep; at 96 bodies × 120 Hz that is
  ~11.5 k lookups/s, dominated by memo hits.
* **Particles** — two draw calls, one fixed pool per quality preset (900 low →
  6000 ultra) allocated once; per-frame cost is a linear walk of the pool.
* **Weather** — a handful of noise evaluations per fixed step plus one eased
  update of ~15 scalars per frame.
* **Memory** — water geometry is the largest new allocation: ~64 tiles ×
  (48² vertices × (3 + 3 + 1 + 1) floats) ≈ 4.7 MB at High, disposed on quality
  change, seed change and teardown.

---

## 11. Next milestone

Phase 10 (vehicles) consumes this layer: watercraft hulls need multi-point
buoyancy on top of `BuoyancySolver`, and the water query already exposes surface,
depth, flow and body identity to drive propulsion, wake and beaching logic.
