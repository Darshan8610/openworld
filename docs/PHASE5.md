# Wayfarer — Phase 5: The Playable Character

**Status: implemented / unit- and integration-tested. Browser suite not executed in this
sandbox (no Chromium available — see Validation).**

Phase 5 turns the world-inspection build into a third-person game. The player is now a
collision-aware human character with a real skinned rig, a real animation mixer, a
third-person/first-person camera, and locomotion that runs inside the existing
fixed-timestep, floating-origin, worker-streamed world.

Phase 4 (physics engine, world entity model, event bus) is owned by another phase and is
**not** part of this change. Nothing here depends on it, and nothing here pretends it
exists.

---

## What was added

- `CharacterMotion` — a collision-aware character controller: capsule footprint, ground
  contact, slope classification, step climbing, ledge detection, gravity, momentum,
  coyote time, jump buffering, variable jump height, surface sliding, water buoyancy.
- `CharacterController` — camera-relative input intent, stance selection (walk / jog /
  sprint / crouch), facing, landing response, footstep cadence, gameplay events.
- `AnimationController` + procedural clip set — 13 authored `AnimationClip`s
  (idle, walk, jog, sprint, backpedal, strafe, crouch idle, crouch walk, jump, fall,
  land, swim, tread) on a 19-joint semantic rig, cross-faded through a real
  `AnimationMixer`, with playback rate tied to gait speed.
- `createPlaceholderRig()` — a genuinely **skinned** placeholder body: one merged
  bind-pose geometry with `skinIndex`/`skinWeight` attributes, 19 bones and a `Skeleton`.
- `CharacterVisual` — world placement, slope alignment, hip-pivot lean, prone swim pose,
  procedural head look, first-person body hiding.
- `ThirdPersonCamera` — orbit boom, terrain/geometry avoidance, shoulder swap, zoom,
  speed FOV, landing shake, first-person mode.
- `CharacterSystem` — the composition root: input mapping, spawn/respawn, origin
  updates, interpolation, events, diagnostics.
- `CharacterAssets` — GLTF/GLB humanoid import (`?character=<url>`), semantic bone
  resolution, animation-name mapping, procedural clip back-fill, labelled fallback.
- Full game integration: streaming focus, camera handover, post-processing camera
  swap, URL state (`mode`, player position), HUD/panel controls.

## Controls

| Input | Action |
|---|---|
| `W A S D` / arrows | Move (camera relative) |
| Mouse drag / pointer lock | Look |
| `Shift` | Sprint |
| `Alt` | Walk (slow) |
| `Ctrl` | Crouch |
| `X` | Strafe lock — face the camera instead of the travel direction |
| `Space` | Jump (variable height, buffered, coyote window) |
| `F` | Toggle first / third person |
| `Z` | Swap shoulder |
| `C` | Toggle character ⟷ survey camera |
| Wheel | Camera zoom (character) / cruise speed (survey) |

Survey-camera controls (`Q`/`E`, `T`, `G`, `V`, `B`, `L`, `H`, `F3`, `P`, `R`) are
unchanged and still work in survey mode.

## Architecture

```text
src/character/
  locomotion.ts            pure movement solver (no Three objects, no DOM)
  character-controller.ts  intent → motion, stance, facing, animation state, events
  rig.ts                   semantic joint vocabulary + imported-bone resolution
  humanoid-model.ts        procedural skinned placeholder rig
  animation-clips.ts       procedural clip authoring + clip timing table
  animation-controller.ts  mixer, actions, cross-fades, root-motion extraction
  character-assets.ts      placeholder + GLTF asset pipeline
  character-visual.ts      transform, slope alignment, lean, head look
  third-person-camera.ts   orbit boom, occlusion, first/third person
  world-sampler.ts         terrain sampler + null water provider
  character-system.ts      composition root
tests/character*.test.ts   motion, controller, camera, rig, animation, integration
```

### Layering

`locomotion.ts` knows nothing about Three.js scenes or the DOM, which is why the whole
movement model is testable against synthetic terrain. Everything above it consumes it
through interfaces (`CharacterSampler`, `WaterQuery`, `CameraProbe`).

### Coordinate model and floating origin

- Canonical positions stay in JavaScript doubles in **world** space.
- `CharacterVisual` recomputes `local = world - origin.absolute` every frame, so an
  origin rebase cannot leave the player behind; the camera does the same.
- `CharacterSystem.fixedUpdate()` calls `origin.update(character.position)`, so terrain,
  vegetation and roads stream around the **player**, not the old survey camera.
- Physics of the player are analytic (terrain sampling), not a rigid-body engine, so
  there is no native state to migrate on a rebase. Phase 4's physics integration will
  need its own rebase hook; this module does not pre-implement it.

### Integration with existing systems

| System | How Phase 5 integrates |
|---|---|
| Terrain streaming | `TerrainCharacterSampler` reads `heightAt`/`biomeAt` from the loaded tiles; no duplicate heightfield |
| Vegetation / roads | unchanged; they follow the active world position |
| Floating origin | player drives it; render-space conversion each frame |
| Fixed timestep | character updates in the existing 120 Hz loop with render interpolation |
| Renderer | player camera is passed to the sky, `compileAsync` and the post chain |
| Post-processing | `setCamera()` rebuilds the pass for the active camera on view change |
| UI | mode switch, first person, sensitivity, shoulder, respawn, view-aware HUD |
| URL sharing | `mode=character|survey`; `x`/`z` now describe the player |

### Movement model

Ground movement is momentum-based: a target velocity is approached at
`acceleration`/`deceleration`, uphill/downhill modifies the target, and air control is a
fraction of ground authority. Vertical motion is gravity with ground snapping; walkable
slope is `maxSlopeDeg` (48°). Contact resolution is axis-separated, so the player slides
along walls instead of sticking. Steep ground is contact-without-traction: the solver
adds a downhill component and removes input authority, so the character slides.

Jump: `v₀ = √(2·g·jumpHeight)` (≈7.1 m/s for 1.05 m at 24 m/s²), variable height via a
release cut, 0.14 s input buffer, 0.11 s coyote window.

Swimming: buoyancy is a vertical spring toward neutral buoyancy with drag, current
influence in XZ, and `jump`/`crouch` as rise/dive. Swimming is fully implemented and
unit-tested **against a synthetic water surface**; the world has no water bodies until
Phase 9, which supplies a `WaterQuery` through `CharacterSystem.setWater()`.

### Animation

The placeholder set is authored in code as quaternion tracks on semantic joints, not
sampled from external files. Verification is behavioural: the tests assert that clips
target real bone names, that loop policy matches the timing table, that the mixer moves
joints and hip height, that cross-fades change the active action, and that every
controller output state has a clip.

Imported animations are matched by name (`idle`, `walk`, `run`, `sprint`, `jump`, …) and
**unmatched states are filled with procedural clips built on the imported bones**, so a
model with a single idle animation is still playable. Imported root motion can be
extracted (`AnimationController.consumeRootMotion`); it is disabled for the placeholder
set because those clips are in-place by construction.

## Validation performed

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean (strict, `noUncheckedIndexedAccess`, `noUnusedLocals`) |
| `npm test` | **74/74 passing**, 10 files |
| `npm run build` | passes (type check + Vite production build) |
| `npm run test:browser` | **not run** — Chromium is not installed and the Playwright download host is unreachable from this sandbox |

New coverage:

- `tests/character.test.ts` (27) — settling, acceleration/friction, jump apex and
  release cut, coyote time, jump buffering, step climbing vs walls, cliff falls, steep
  slope sliding, obstacle sliding, unstreamed terrain, swimming, water transitions,
  controller stance/animation mapping, strafe/backpedal, footstep and landing events,
  camera boom/pitch/zoom/first person/rebase, rig, clips, mixer.
- `tests/character-integration.test.ts` (8) — `CharacterSystem` against a synthetic
  heightfield: spawn, deferred spawn, walking with the camera behind, origin rebase,
  first person, terrain climbing + jump, respawn, streaming focus.
- `tests/ui-markup.test.ts` (3) — every element id the interface looks up exists in the
  generated markup.

Browser specs were updated for the new default view and extended with walk, jump, `C`
view-switch, `F` first-person and asset-fallback tests. **They are written but
unexecuted here**, so they must not be reported as passing until run on a machine with
Chromium.

## Known limitations (deliberate)

1. **Character art is a labelled placeholder.** It is a real skinned rig with real clips,
   not production art. `snapshot().character.rig.source` and the HUD report it.
2. **No world geometry collision yet.** The solver exposes `CharacterSampler.blocked()`
   (unit-tested with a stub wall) and the camera accepts a collider list, but buildings,
   props and vehicles do not exist until Phases 4/7. Until then the player collides with
   terrain only.
3. **No water in the world.** Swimming logic and its tests are real; the water provider is
   a documented null until Phase 9.
4. **No audio, no interaction prompts, no climbing.** Those are Phases 12 and 6/7.
5. **Animation quality ceiling.** Procedural clips read as a convincing stylized walk/run,
   not as hand-authored mocap. Swapping in a licensed GLB does not require code changes.
6. **The survey rig stays parked on the scenic route at boot** so `C` always has a
   meaningful destination; `routeFollowing` is therefore `true` at boot even in character
   mode. Route travel switches the view to survey explicitly.

## Next milestone

Phase 6 (world objects and interactions) or Phase 4 (physics, entity model, event bus).
The character is the natural first client of both: `blocked()` becomes the physics
character controller, and `CharacterEvent` becomes the typed event stream.
