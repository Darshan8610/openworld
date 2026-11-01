# Combined Phases 1–12

## Source lines

| Scope | Source |
|---|---|
| Phases 1–6 integrated baseline | `main2` at `8687232` |
| Phase 7 buildings/interiors | `arena/b5edc35b-car-game` at `329637d` |
| Phases 8 and 12 NPCs/audio/menus | `arena/5bd47b5d-car-game` at `3e4d294` |
| Phase 10 vehicles | `arena/2d03ff06-car-game` at `573ad86` |
| Phase 9 water/environment | `arena/298dcffe-car-game` at `3e6e5be` |
| Phase 11 milestone 11.1 | current integration branch, commit `ff37948` |

The feature lines were merged with ancestry retained, not copied as disconnected
folders. Phase 9 was excluded in the first integration (PR #2); the refreshed
integration includes it. Phase 12's remote head remains `3e4d294` and was already
an ancestor of `main2`; no newer Phase 12 source branch was found in the refresh.

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
  one side of overlapping merge blocks. Phase 9 is now integrated with those paths.

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
- Unit/integration suite: 434 tests passed across 38 files.
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

## Phase 9 integration follow-up

- Preserved combined audio/menu/NPC/building/vehicle controls while adding water,
  weather, buoyancy and particle ownership, lifecycle and stats.
- Phase 10 now gets a live water provider (displaced elevation, normalized wave
  normal, depth, currents) and fixed-step weather wind. No artificial water is
  reported over dry terrain.
- WorldManager receives the composition root's fixed simulation clock so water
  rendering cannot advance ahead of swimming/vehicle waves while loading.
- Particle pools are rebuilt/disposed on quality changes to respect preset caps.
- Fixed stale full/reduced-fidelity NPC activity reporting from the behaviour brain.
  The schedule integration test now checks schedule activity rather than disallowing
  valid higher-priority perception reactions such as investigating the player.
- 481 unit/integration tests across 46 files pass; production build/type check pass.
- Software-WebGL2 browser checks executed: Phase 9 streaming/weather budget, pinned
  storm precipitation, keyboard water toggle, and Phase 11 chart/save roundtrip.
  Initial storm/toggle specs failed due to wall-clock timing on slow software GPUs
  and assumptions predating the title menu; tests now wait for simulation state
  and enter through the actual Phase 12 menu.
- Full browser matrix, hardware WebGPU and long-run profiling remain unverified.
  This does not complete Phase 11 or remove the adapter boundaries above.
