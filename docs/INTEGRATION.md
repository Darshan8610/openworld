# Combined Phases 1–12

## Source lines

| Scope | Source |
|---|---|
| Phases 1–6 integrated baseline | `main2` at `8687232` |
| Phase 7 buildings/interiors | `arena/b5edc35b-car-game` at `329637d` |
| Phases 8 and 12 NPCs/audio/menus | `arena/5bd47b5d-car-game` at `3e4d294` |
| Phase 10 vehicles | `arena/2d03ff06-car-game` at `573ad86` |
| Phase 11 milestone 11.1 | current integration branch, commit `ff37948` |
| Phase 9 water & environment | `arena/298dcffe-car-game` at `3e6e5be` |

The feature lines were merged with ancestry retained, not copied as disconnected
folders. Phase 9 is merged with the combined tree: hydrology carving shares the
terrain field with road grading and building placement, buoyancy runs inside the
existing Rapier and prop substep loops, and the weather front drives the sky and
particles alongside the Phase 12 audio/UI systems.

## Shared composition and conflict resolution

- Game constructs, updates, rebases and disposes buildings, NPCs, vehicles,
  character, terrain, objects and audio in one application.
- Character and vehicle control share the fixed update; active vehicle position
  drives world focus. Vehicle entry via interactions now hands off character
  control as well as explicit Q entry. Survey altitude Q no longer enters vehicles.
- Switching to survey exits the current vehicle first. Seated interactions do not
  target objects using the abandoned on-foot actor position.
- Building inspection enters survey mode **before** placing its camera, and exits
  the title/settings menu through the UI state machine rather than only hiding DOM.
- F remains first-person toggle on foot and door interaction while inspecting.
- Building updates follow the active canonical focus, preserve origin rebasing,
  and retain worker-side vegetation reservations and authored reservation filters.
- NPC outdoor navigation rejects building lots. This conservative boundary is not
  interior room-graph navigation; it avoids treating building footprints as empty.
- Manual Phase 11 grounded-player slots refuse saves while driving. The separate
  NPC/vehicle/building per-seed stores remain intact.
- NPC/audio and vehicle lifecycle paths were retained together instead of selecting
  one side of overlapping merge blocks.
- Phase 9 merge: NPC toggle keeps `N`; weather cycling moved to `M` to avoid the
  key collision. Both sides of the gameplay-layer, stats and dispose paths were
  kept (water/particles alongside npcs/vehicles/buildings/audio).

## Known boundaries

This combines existing implementations, not every aspiration in the master roadmap.
Phase 11 is still the chart/discovery/manual-slot milestone, not completed routing,
minimap or missions. Manual slots do not yet snapshot NPCs, vehicles or building
changes. Existing per-seed stores handle those changes separately.

Buildings retain their survey-inspection collision and door path. Character-to-
building collision, central Rapier building-collider adapters, building doors in the
on-foot interaction registry, NPC interior navigation, and audio/vehicle continuous
sound integration still need dedicated adapters. Do not infer those are finished
merely because their respective source phases are present in the same tree.

## Verification in this integration session

- TypeScript + production bundling: `npm run build` passed.
- Unit/integration suite: 478 tests passed across 45 files (Phase 9 water/weather/particles/buoyancy suites included).
- Selected Playwright software-WebGL2 checks passed:
  - deterministic streamed-world character boot without page errors;
  - discovery chart, waypoint and manual save/load roundtrip;
  - buildings/collisions/windows after a large-coordinate origin rebase;
  - building inspection via the existing settings panel.
- Initial browser attempts failed for missing Chromium/libraries. A temporary
  npm-distributed Chromium plus extracted runtime libraries enabled the checks;
  neither temporary tools nor their libraries were added as project dependencies.
- Two intermediate building browser failures exposed a duplicate accessible-name
  selector and title/pointer-lock test navigation. Selectors/navigation were adapted
  to the integrated Phase 12 menus; both selected building tests then passed.
- Full browser suite, hardware WebGPU and long-run performance were not executed.
  These selected checks are not a claim of full cross-phase acceptance.
