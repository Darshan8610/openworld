# Phase 11 — Discovery & gameplay infrastructure

## Milestone 11.1: local chart, exploration and manual save slots

Implemented against `8687232` (integrated Phases 1–6), not against an assumed
combination of all remote feature branches. Phases 7, 8, 10 and 12 remain separate
work lines. No existing subsystem was replaced and no narrative was authored.

### Baseline source audit

- `core/game.ts` owns the rendering/composition lifecycle; `game/world-manager.ts`
  orders terrain/vegetation/road updates and central Rapier simulation.
- The fixed loop runs character and prop simulation separately from rendering.
- `TerrainManager` and workers retain streaming/quadtree ownership; floating
  origin is managed by `core/floating-origin.ts`.
- Two query facades and two typed event buses exist following earlier merges:
  `world/world-query.ts` + `game/events.ts` and `world/world-queries.ts` +
  `core/events.ts`. This milestone uses the existing gameplay `WorldQueries`
  facade rather than introducing another terrain/noise implementation. Consolidation
  of these older seams is a future integration task, not a destructive rewrite here.
- Roads are analytic parallel corridors, **not an intersection graph**. A direct
  waypoint distance must not be presented as a calculated walkable/drivable route.
- Inventory and object modification snapshots already exist. Legacy per-seed
  object autosaves remain intact; Phase 11 manual slots are separate snapshots.
- Existing GLTF character loading, WebGPU/WebGL2, terrain materials, instanced
  vegetation, sky, URL parameters and seed behaviour are unchanged.

### Architecture and integration

`Discovery` owns canonical 256 m exploration cells and one optional waypoint.
Exploration is recorded from the active character (not developer survey flight).
It is independent of all render-origin shifts. Cells have a hard cap of 8192;
once full, existing discoveries remain and new cells are not recorded. This is
an explicit first-milestone limit, not an infinite-world persistence solution.

`DiscoveryPanel` owns a bounded local canvas chart, not simulation. Open using
**M** or **Map · M**. Click the chart to set a waypoint; zoom, clear waypoint and
save/load controls are keyboard-focusable. Escape or Close hides the chart.
The chart centres on the current canonical focus, shows biome tint only for
visited cells, analytic roads, player direction and a waypoint. Roads remain
visible in unexplored cells. Distances are explicitly direct, not route lengths.
Chart sampling is bounded to 1024 cells at most twice per second while open;
no map sampling occurs while closed. The chart is not a full world-map/minimap.

`GameSaveStore` owns three named numeric slots in localStorage. Version 1 contains:
seed, save timestamp, character XZ, sky hour/cycling, exploration, waypoint,
object modifications and existing inventory stacks. Generated terrain, vegetation
and road data are **not** persisted. Validation occurs before world mutation and
before writes. Unsupported versions, corrupt slots, quota/storage exceptions and
oversized saves are reported rather than silently overwritten. Each localStorage
setItem replaces its slot atomically; a failed write leaves its previous value.
There is no historical migration yet because this is the first game-slot schema;
other versions are deliberately refused, not guessed or downgraded.

Game composition supplies capture/restore adapters. Load rebuilds the seed-local
gameplay layer, resets active objects with saved modifications, restores inventory,
then queues a terrain-resolved character spawn. Existing URL sharing is refreshed.
Public `saveGame` / `loadGame` methods are also available on the existing inspection
handle; `snapshot().discovery` returns copied data.

### Explicit limitations / next milestones

- Grounded XZ respawn only: yaw, Y, velocity, stance and occupied seats are not yet
  saved. Do not use these slots to claim exact player-pose persistence.
- Map-open blocks character/prop input stepping, not the entire world's physics,
  sky or streaming. It is **not** a full pause menu.
- No automatic game-slot autosave, import/export, deletion/recovery UI, backup
  history, cross-tab conflict arbitration or older-version migration yet.
- Object payload sanitisation reuses the existing Phase 6 validator; stricter
  schema validation of every object archetype is still needed.
- No vehicle/NPC/weather/building persistence adapters: those implementations are
  not in this branch. The slot schema must be explicitly versioned when added.
- No road route calculation, walking pathfinding, pan-enabled world map, minimap,
  discovered landmarks, named markers, mission/objective/flag runtime or dialogue
  infrastructure yet. Existing inventory remains the inventory integration hook.
- Long-run performance profiling, GPU/browser matrix and full acceptance testing
  remain pending. No claim of completion of Phase 11 as a whole.

### Validation

- Before changes: `npm test`: 181 tests passed across 20 files.
- After milestone: `npm test`: 190 tests passed across 21 files.
- `npm run build`: TypeScript checking and Vite production bundling passed.
- No lint script is configured in this repository.
- New browser spec: `tests/browser/discovery.spec.ts` checks chart interaction and
  slot/waypoint restoration. Attempted execution failed **before browser launch**:
  the Playwright Chromium executable is not installed. Neither renderer path has
  been browser-verified for this milestone.
- Unit coverage includes negative/large coordinates, discovery limits, slot
  isolation, unsupported/corrupt data preservation, quota errors, invalid time,
  cross-seed object snapshots and invalid slot IDs.
