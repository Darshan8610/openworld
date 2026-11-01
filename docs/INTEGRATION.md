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
folders. Phase 9 was excluded in the first integration (PR #2); the refreshed
integration includes it from `arena/298dcffe-car-game`. Hydrology carving shares
the terrain field with road grading and building placement, buoyancy runs inside
the existing Rapier and prop substep loops, and the weather front drives the sky
and particles alongside the Phase 12 audio/UI systems.

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
- Phase 9 key collision resolved: the NPC toggle keeps `N`; weather cycling moved
  to `U` because `M` is the world chart key (both previously fired on one keypress).

## Known boundaries

This combines existing implementations, not every aspiration in the master roadmap.
Phase 11 now includes honest corridor routing, the corner minimap, save v2 with
autosave and the story-independent mission runtime (see `PHASE11.md`); manual game
slots still do not snapshot NPCs, vehicles or building changes — the existing
per-seed stores handle those changes separately, and NPC/vehicle/building
persistence adapters remain future work.

Three earlier adapter gaps were closed in the post-Phase-12 debug pass:

- **Character ↔ building collision.** `CharacterSampler.blocked()` (already in the
  motion solver) is now fed by the streamed `BuildingCollisionIndex` at mid-body
  height; walls stop the player with axis-separated sliding, open doors are
  passable because the runtime rotates their collider, and walkable tops (porches,
  interior floors) become step-on supports through the same sampler. The
  third-person camera also treats streamed building meshes as solids.
- **Building doors on foot.** Building bindings stream into the on-foot
  `InteractionManager` through `interaction/building-provider.ts` (throttled
  registry sync); the runtime still owns state, range, cooldown and occlusion.
- **Vehicle audio.** Phase 10 `VehicleAudioHooks` (already stepped per vehicle)
  now drive live `engine.setVehicleLoops` voices (engine/tyre/rotor/wind) and
  discrete one-shots (impact, gear, start/stop, splash); `vehicle:damaged` pans
  through the new vehicle position lookup, ambience keeps updating while driving,
  and five new procedural recipes extend the sound vocabulary.

Still deliberately bounded (not claimed as finished): NPC interior navigation
(outdoor pathfinding keeps rejecting building lots), Rapier rigid-body building
colliders for vehicles/props (character locomotion uses the analytic index;
buildings keep their own physics port for inspection), and hardware-WebGPU /
long-run browser validation.

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
