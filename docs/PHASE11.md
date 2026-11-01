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

## Milestone 11.2: navigation, minimap, mission runtime and save v2

Built on the integrated Phases 1–12 line (`3e6acba`). Still no authored story,
no invented road links and no replacement of existing subsystems.

### Honest navigation (`discovery/navigation.ts`)

`planRoute(roads, from, to)` returns one of exactly two plans:

- `corridor` — both endpoints snap within `snapRadius` (default 120 m) of the
  **same** corridor; distance is real along-corridor travel plus both lateral
  access walks, and the polyline is the corridor centreline itself;
- `direct` — anything else; an explicitly labelled straight-line distance that
  `describeRoute()` marks as “not a road route”. The corridor network has no
  intersections, so cross-corridor itineraries are never fabricated.

The world chart (M) now draws the corridor route to the waypoint in blue and
reports the honest route description; `snapToRoad`/`nearestOnRoad` share the
same projection. All inputs/outputs are canonical metres.

### Live minimap (`ui/minimap.ts`)

A 144 px north-up canvas at the bottom-left: discovered cells tinted by their
analytic biome colour (unknown land stays dark), the nearby corridor centrelines
(recomputed from the analytic field — no stored map), the waypoint (clamped to
the rim when off-map) and a player arrow. Redraws are throttled to ~200 ms and
skipped when nothing moved; a settings switch (“Corner minimap”) toggles it.
Only canonical positions are read, so floating-origin rebases are invisible.

### Mission / objective / flag runtime (`game/objectives.ts`)

`ObjectiveRuntime` is story-independent infrastructure on the existing
`GameEventBus`:

- objectives of kind `event` (count bus events, optional payload match filter),
  `flag` (named flag reaches a value) and `reach` (player enters a canonical
  radius, fed from the fixed step);
- typed events `mission:started|objectiveCompleted|completed|flagSet` and
  `world:locationDiscovered` (emitted on first discovery-cell visit) were added
  to `core/events.ts` for future narrative layers to observe;
- bounded everywhere: ≤64 missions, ≤32 objectives each, ≤256 flags, string
  length caps; registration, `snapshot()`/`restore()` and the save validator
  all enforce them, so hostile progress is stripped, not trusted.

No missions are registered in-game: content belongs to a later narrative phase.

### Save format v2 + autosave

`GameSave` is now **version 2**: `player` gains `yaw`, plus `weather`
(override id or `null`) and `objectives` (mission progress). `validateGameSave`
accepts v1 and v2 and migrates v1 → v2 (yaw 0, procedural weather, empty
objectives); unknown versions are still refused, never overwritten. `GameSaveStore`
slot 0 is the silent autosave (`wayfarer.game.autosave`); manual slots remain
1–3. The game autosaves every 120 s of running time (never while driving or
behind a menu). Load restores yaw through `character.spawnAt(x, z, yaw)` — the
camera rig keeps the restored look direction and the body faces away from it —
and restores the weather override (unknown ids degrade to procedural weather)
and mission progress.

### Keybindings and flake fix

Weather moved from **M** to **U**: **M** is the world chart key and both
handlers previously fired on one keypress. README control table and the pause
hint were updated.

The previously flaky `water-manager` shoreline test now streams until the tile
count stabilises (`streamUntilStable`): the manager's per-call 4 ms wall-clock
build budget legitimately truncates a pass under parallel-test load, and the
old helper simulated only one second of streaming. Production budget behaviour
is unchanged.

### Validation (11.2)

- Baseline before changes: `npx tsc --noEmit` clean; `npm test` 481/481 across
  46 files (one water-manager test flaky under load, root-caused as above);
  `npm run build` OK.
- After milestone: `npx tsc --noEmit` clean; `npm test` **498/498 across 49
  files** (new: objectives ×6, navigation ×5, minimap ×3; save tests extended
  with v1 migration, autosave-slot isolation and hostile-objective rejection);
  `npm run build` OK (Vite ~1.7 s).
- Minimap rendering is covered with an injected fake canvas/document (drawing,
  throttling, enable/disable); no browser executable was available for e2e here.
