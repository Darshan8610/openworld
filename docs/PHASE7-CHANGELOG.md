# Phase 7 implementation change inventory

## Added

World/domain modules:

- `src/world/buildings/types.ts` — descriptor, template, collision, interaction,
  navigation, room and typed host adapter/event contracts.
- `coordinates.ts` — canonical/local architectural transforms.
- `settings.ts` — explicit stream, interior, light, collision and persistence budgets.
- `template-kit.ts` — modular openings, floors, doors and furniture components.
- `templates.ts` — validated registry; cabin, workshop and two-storey lodge content.
- `placement.ts` — bounded deterministic site field, authored lots, foundation
  surveys, road/slope/overlap validation and vegetation reservations.
- `site-parts.ts` — shared source of visible/collidable foundations and entry steps.
- `collision.ts` — canonical oriented boxes, continuous camera obstruction queries,
  explicit support surfaces and per-door shapes.
- `navigation.ts` — canonical room/entrance/stair graphs with physical door gating.
- `state.ts` — validated versioned door deltas with safe browser storage adapter.
- `runtime.ts` — per-instance doors, host registration, fixed-time animation and teardown.
- `manager.ts` — integrated bounded streaming, room transitions, queries and lifecycle.
- `experience.ts` — removable developer inspection UI and existing-camera bridge.

Rendering:

- `src/rendering/buildings/building-visuals.ts` — shared merged geometry, PBR material
  library, transparent glazing, night illumination and bounded indoor point lights.
- `collision-debug.ts` — one instanced, pooled collision-overlay draw.

Tests:

- `tests/building-model.test.ts` — templates, site validation, deterministic/far
  coordinates, road-spanning footprint/foundation validation, plant clearance and
  room/stair/portal navigation.
- `tests/building-collision.test.ts` — continuous sweeps, sliding, rotated far shapes,
  exact-contact boundaries, closed/open door passage, stair support and cleanup.
- `tests/building-manager.test.ts` — terrain availability, stream hysteresis,
  physics/interaction/nav port cleanup, rebase preservation, animation, occupied
  door recovery, rotated/negative-swing leaves, authored reservation invalidation,
  long-travel bounds and shared geometry disposal.
- `tests/building-state.test.ts` — data-only deltas, seed separation, schema rejection,
  no invalid/newer-save overwrite, capacity limits and write-failure recovery.
- `tests/browser/buildings.spec.ts` — real WebGL2 launch, door collision and passage,
  interior reload/unload, persistence, far-coordinate rendering, settings integration
  and ground-to-gallery stair inspection.

Documentation:

- `docs/PHASE7.md` — audit, design, migration, validation and limits.
- `docs/BUILDING_INTEGRATION.md` — concrete handoff to Phases 4–6 and 8.
- `docs/ROADMAP.md` — revised story-independent Phase 4–13 roadmap.
- `docs/PHASE7-CHANGELOG.md` — this inventory.

## Changed

- `src/core/game.ts` — additive building ownership, fixed/render update integration,
  origin/seed/quality/teardown lifecycle, snapshots and building-sharing URL.
- `src/core/survey-camera.ts` — opt-in slow interior inspection constraint; original
  flight/route controls and defaults preserved.
- `src/world/terrain-field.ts` — owns the same pure placement/reservation field in
  workers and main-thread building placement. Height/noise algorithms are unchanged.
- `src/world/vegetation-field.ts` — rejects canonical generated building footprints
  before packing plants; original seed/LOD subset logic is retained.
- `src/world/vegetation-manager.ts` — optional authored-footprint reservation port.
- `src/ui/style.css` — additive inspection panel, door prompt and accessible controls.
- `README.md` — Phase 7 availability, controls, test counts and documentation links.
- `index.html` — removes obsolete Phase 1-only metadata description.
- `THIRD_PARTY_NOTICES.md` — records the procedural architectural asset provenance.

## Removed

None. No existing terrain, road, sky, biome, worker, renderer, vegetation, UI or test
module was removed or replaced. No new runtime dependency was added. Temporary
Chromium tooling and screenshots remain ignored and are not committed.
