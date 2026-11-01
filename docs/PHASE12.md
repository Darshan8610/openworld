# Wayfarer — Phase 12: Audio, UX & Polish

**Status: implemented / unit + headless-integration verified / browser suite not executed in this sandbox.**

Phase 12 gives the world a voice and a way in. Every sound is synthesised at
runtime from noise and oscillators — the repository ships **no audio files** — and
is budgeted like every other system: a fixed voice cap, per-bus limits, distance
attenuation and a mixer that steals the weakest voice instead of growing. The
front end becomes a real product shell: a title screen with seed and preset,
a pause menu that actually freezes simulation *and* audio, a settings panel with
a four-bus mix, and accessibility controls (captions, contrast, large text,
reduced motion, hold-to-confirm) that persist locally and apply immediately.

There is still **no story, no dialogue content and no invented soundscape**:
footsteps come from the surface the character is standing on, ambience from the
biome, altitude, hour and wind setting the simulation already owns, and object /
conversation sounds from typed events that already existed in Phase 6 and 8.

> Phase 7 (buildings/interiors), Phase 9 (water/weather), Phase 10 (vehicles) and
> Phase 11 (discovery/gameplay infrastructure) are owned by other work lines.
> Engine and weather loops therefore do **not** exist yet; `AudioDirector` is the
> seam through which they will submit `AudioPlayRequest`s when they land.

---

## 1. What Phase 12 adds

| System | Module | Summary |
|---|---|---|
| Audio vocabulary | `src/audio/types.ts` | 27 sound ids, four buses, settings defaults, `AudioPlayRequest`/`AudioStats`, `AudioEngine` interface, `spatialize()`. |
| Sound recipes | `src/audio/recipes.ts` | Data-driven recipes (bus, duration, priority, 1–3 layers each with filter, envelope, glide, jitter), surface → footstep mapping, archetype/action → object sound mapping. |
| Mixing policy | `src/audio/mixer.ts` | `busGains()` (master/duck/clamp/mute) and `VoiceMixer`: global cap, per-bus caps, quietest-then-oldest steal, drop accounting. Pure bookkeeping, no nodes. |
| Ambience zones | `src/audio/zones.ts` | `ambienceWeights()` from biome, altitude, hour, wind and shelter; `dominantZone()`; bounded `smoothWeights()` cross-fade. |
| Footsteps | `src/audio/footsteps.ts` | Distance-cadenced steps per stance and surface, soft/hard landings from the airborne→grounded transition, swimming splashes. |
| Web Audio engine | `src/audio/engine.ts` | Bus → master → compressor graph, one shared generated noise buffer, node-per-layer rendering, four looping ambience beds, mute/master ramps, graceful absence of Web Audio. |
| Director | `src/audio/director.ts` | Consumes a per-frame `AudioFrame` plus typed game events; owns cadence, distance attenuation, 4 Hz ambience resampling, captions and pause. |
| Preferences | `src/ui/preferences.ts` | Versioned `wayfarer.preferences` blob, clamped/typed parsing, `applyPreferences()` document classes, OS reduced-motion default, storage-failure tolerance. |
| Captions | `src/ui/captions.ts` | Bounded, time-limited caption feed with direction labels and duplicate suppression. |
| Menu state | `src/ui/menu.ts` | Four mutually exclusive overlays (`title`, `pause`, `settings`, `none`) with pause semantics, escape ladder and settings return path. |
| Interface shell | `src/ui/interface.ts`, `src/ui/style.css` | Title menu fields, pause dialog, SOUND and ACCESSIBILITY sections, caption region, focus trap, overlay body classes, new panels/responsive styles. |
| Interaction option | `src/interaction/manager.ts` | `setHoldToConfirm()` / `requiresHold` for the accessibility toggle. |
| Wiring | `src/core/game.ts`, `src/config.ts` | Audio engine + director lifecycle, preference application, 8 new UI actions, pause/resume, stats, `snapshot()`, disposal, `CONFIG.audio`. |

---

## 2. Audio architecture

```text
AudioFrame (per render frame)          GameEventBus (typed)
        │                                     │
        ├── FootstepDriver ── steps/landings ──┤
        │                                     │
        └── ambienceWeights → smoothWeights ──┴── AudioDirector
                                                     │ AudioPlayRequest
                                                VoiceMixer  (policy)
                                                     │ admitted / stolen
                                              WebAudioEngine (nodes)
                                                     │
                    ambience bus ─┐   effects bus ─┼─ ui bus
                                  └── master ─ compressor ─ destination
```

* **No assets, no licences.** `WebAudioEngine.createNoise()` generates one mono
  2-second white-noise buffer at the context sample rate (48 kHz ≈ 384 kB) and
  every noise layer reuses it. Tones are oscillators. Nothing is fetched.
* **Buses.** `ambience`, `effects`, `ui` are gain nodes feeding a master gain,
  which feeds a `DynamicsCompressor` (used as a safety limiter) and then the
  destination. The master node carries both the master slider and mute; bus gains
  are ramped with `setTargetAtTime(…, 0.05)` so a slider move never clicks.
* **Voices are recipes.** A `VoiceRecipe` lists 1–3 layers; each layer becomes
  `BufferSource` or `Oscillator` → optional biquad (with optional sweep) → gain
  envelope → stereo panner → bus. `jitter` derandomises playback rate per voice
  id so repeated footsteps are not identical samples.
* **Budget.** `CONFIG.audio.maxVoices = 24`, `busVoices = { ambience 4, effects 16,
  ui 6 }`. The mixer admits a voice only if both the global and the bus cap have
  room; otherwise it steals the quietest, then oldest, voice of **lower or equal
  priority** — and never replaces a same-priority voice with a quieter request.
  Every refusal increments `dropped`, which is surfaced in the HUD.
* **Autoplay policy.** The context is created suspended. `bindAudioUnlock()` in the
  game resumes it on the first pointerdown/keydown (once). `resume()` swallows a
  blocked promise; if `AudioContext` is missing, `available` is false and every
  call is a safe no-op — the game runs silently and the settings panel says so.

### 2.1 Spatialisation

`spatialize(listener, source, maxDistance = CONFIG.audio.effectDistance)` returns
`{ gain, pan }`: pan is the source's projection on the camera right vector
(`cos(yaw), -sin(yaw)`), gain is squared linear falloff with a 2.5 m near-field
plateau and silence beyond 46 m. Objects and NPCs are resolved to canonical
positions by `Game.locateSoundSource()`; unresolvable ids still play centred, so a
sound is never lost because a streamed entity despawned. There is no HRTF, no
occlusion and no reverb: stereo pan plus distance is the honest budget.

---

## 3. Ambience zones

| Zone | Bed | Rises with |
|---|---|---|
| `wind` | low-pass noise 480 Hz | exposure (biome + altitude), falls at night |
| `foliage` | band-pass noise 2.6 kHz | biome cover (0.95 in conifer highlands → 0.05 on snowline) |
| `ridge` | narrow band-pass 900 Hz, Q 2.2 | altitude exposure above ~45 % |
| `hush` | low-pass 240 Hz | night, shelter, open ground |

`ambienceWeights()` is a pure function of `(biome, altitude, hour, windEnabled,
sheltered)`; `windEnabled === false` returns `{ 0, 0, 0, 1 }` (still air, not
silence). The director resamples at 4 Hz and moves the current weights towards
the target by at most `dt / 2.5 s` per channel, so crossing a biome boundary
cross-fades instead of stepping. The first sample after a zone change also emits
a short `ambience-transition` and a caption ("Open wind", "Leaves rustle", …).

`CONFIG.audio.ambienceInterval = 0.25`, `zoneFadeSeconds = 2.5`.

---

## 4. Footsteps and landings

Footsteps are **distance-driven**, not time-driven, so they follow the speed the
locomotion solver actually produced:

* Stride = `0.78 m × stance factor` (crouch 0.55, walk 0.82, jog 1.0, sprint 1.12).
* Below `minSpeed = 0.35 m/s` the accumulator is capped at half a stride, so the
  next step lands immediately when the player starts moving; airborne resets it.
* Loudness = `min(1, 0.4 + speed / 6) × stance gain` (crouch 0.35 → sprint 1.0).
* Sound = `footstepSoundFor(surface)` — grass, gravel, rock, snow, hard, wood,
  metal, water — from the Phase 6 `SurfaceKind` table under the player's feet.
* Swimming takes a `stride × 1.6` splash variant.
* Landings come from the airborne → grounded transition using the downward speed
  captured on the previous frame: `< 4.2 m/s` is `land-soft`, above it is
  `land-hard` (louder, captioned). The driver starts *grounded* so the first frame
  of a session does not report a phantom landing.
* Footsteps are deliberately **never captioned** — captions describe information
  the player cannot infer from ground texture, not a step counter.

`character-system.ts` emits no footstep events and `PropPhysicsWorld` emits no
impact events, so the director derives all of this from the per-frame
`CharacterSnapshot`; no new gameplay coupling was introduced.

---

## 5. Events the director listens to

| Event | Sound | Caption |
|---|---|---|
| `object:interacted` | `interactionSoundFor(archetype, action)` — door, container, switch, valve, lamp, pickup | "Gate opens", "Pickup", … |
| `npc:talkStarted` | `npc-greet` | "Someone greets you" |
| `npc:topicSelected` | `npc-reply` (quieter) | "Reply" |
| `npc:talkEnded` | `npc-farewell` | "Conversation ends" |

Subscriptions are stored and unsubscribed in `dispose()`. `ui()` plays
`ui-click | ui-hover | ui-confirm | ui-back | ui-error` centred and unattenuated;
the interface fires one for every button click (`primary` → confirm, otherwise click)
through a single delegated listener, so a new button is audible without extra wiring.

---

## 6. Menus and overlays

One small state machine (`MenuState`) owns which surface is visible, whether the
simulation runs, where focus goes and whether the shell is inert.

| From | Action | To | Simulation | Notes |
|---|---|---|---|---|
| `title` | Enter the world | `none` | runs | intro dismissed, pointer lock requested |
| `none` | Esc | `pause` | frozen | pointer lock released, input cleared |
| `pause` | Esc / Resume | `none` | runs | context resumed |
| any | gear / “World settings” | `settings` | unchanged | returns to where it came from |
| `settings` | Esc / × | previous | restored | focus returns to the opener |
| `pause` | Back to title | `title` | runs (behind title) | intro restored |

* Only `pause` freezes the world; the title screen keeps the world alive behind it
  so entering is instant and the loading/compile phase is unaffected.
* `Interface.applyOverlay()` is the single writer of `#settings`/`#pause` visibility,
  `aria-expanded`, `inert`/`aria-hidden` (pause only), and the body classes
  `paused`, `title-screen`, `settings-open` (plus the existing `pointer-locked`).
* Focus: the resume button is focused on pause, the close button on settings, and
  Tab is trapped inside the open dialog (wrapping at both ends).
* The game subscribes via `onOverlayChange`: pause → `loop.reset()`,
  `audioDirector.setPaused(true)`, `audio.suspend()`; resume → the inverse. While
  any overlay is open, `Input` is cleared every frame and keyboard shortcuts are
  ignored, so keys pressed behind a menu can never move the player or toggle systems.

---

## 7. Settings, preferences and accessibility

`src/ui/preferences.ts` stores `{ version: 1, audio, accessibility }` under
`wayfarer.preferences`. It is **not** save data: an unreadable, non-object or
newer blob falls back to defaults instead of blocking boot, every volume is
clamped to `0…1`, every boolean must actually be a boolean, and a storage denial
(private browsing / quota) leaves preferences in memory and returns `false`.

| Setting | Effect |
|---|---|
| Master / Ambience / World & footsteps / Interface | bus gains; master also drives the master node |
| Mute all sound | master node → 0, UI toggle + pause-menu button label stay in sync |
| Sound captions | gates the caption feed; also toggles the `a11y-captions` class |
| Reduce motion | stills vegetation wind, pauses the day cycle and the scenic tour (restored when switched off), applies `a11y-reduced-motion`; promoted automatically on first load from `prefers-reduced-motion` |
| High contrast | `a11y-contrast` (stronger text, panel edges and caption backgrounds) |
| Larger interface text | `a11y-large-text` (HUD, menus, dialogue and captions scale) |
| Hold to confirm | `InteractionManager.setHoldToConfirm()`; off = one press confirms |

Captions show up to 3 entries for 3.6 s each in a polite live region, with a
0.5 s director cooldown and 0.6 s duplicate suppression. They are the
audio-independent path to the same information, not decoration.

---

## 8. UI and controls

| Input | Action |
|---|---|
| `Esc` | pause (or step out of settings → pause) |
| `Tab` / `Shift+Tab` | cycle focus inside the open dialog |
| Title screen | seed field, random seed, graphics preset, Enter the world, settings, copy link |
| Pause menu | resume, settings, copy link, mute, restart world, back to title, controls list |
| Top-right gear | settings from the world without pausing |

The settings panel gains a **SOUND** section (four sliders with live percentage
outputs, mute, captions) and an **ACCESSIBILITY** section (four switches), both
styled for desktop and 600 px mobile. `#captions-feed` is a fixed, centred,
non-interactive live region above the toast; `#pause` is a modal dialog with a
responsive two-column action grid.

---

## 9. Diagnostics

The performance overlay (`F3`) now reports audio truthfully:

```text
AUDIO <state> · <voices>/<capacity> voices · <dropped> dropped
ZONE  <dominant zone> · <steps> steps
```

`Game.snapshot()` exposes `paused`, `overlay`, `preferences` and `audio` stats for
the browser suite and for console inspection; `AudioStats` carries state, voices,
capacity, dropped, bed count and the current zone weights.

---

## 10. Validation

Everything below was executed in this sandbox.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (0 errors) |
| `npm test` | **300 tests / 29 files passing** (15.9 s) |
| `npm run build` | success — `dist/assets/index-*.js` 1,229.83 kB (gzip 348.07 kB), CSS 27.37 kB (gzip 8.77 kB) |

New and extended suites (58 tests) and what they prove:

* **`tests/audio-core.test.ts` (19)** — bus gains clamp/mute/duck; global and
  per-bus voice caps; same-priority refusal; priority stealing; pruning; every
  sound id has a playable recipe with a sane envelope; every `SurfaceKind` maps to
  a footstep; interaction mapping; zone weights for wind-off, cover, altitude and
  night; bounded cross-fade and dominant zone; step cadence, surface, crouch vs
  sprint loudness, soft/hard landings and swimming.
* **`tests/audio-engine.test.ts` (11)** — silence without an `AudioContext`; graph
  shape (master → compressor → destination, three buses, four beds, one shared
  buffer); a source per recipe layer with clamped pan/rate/gain; budget refusal and
  drop counts; bus/master/mute ramps; ambience cross-fade and looping beds;
  `stopAll`; single-close, inert disposal; resume/suspend.
* **`tests/audio-director.test.ts` (10)** — settings pushed at construction and on
  change; centred UI sounds; spatialised, captioned object interactions; out-of-
  earshot suppression and centred fallback; NPC conversation sounds and caption
  gating; caption cooldown; footsteps from movement; pause stops cadence;
  4 Hz ambience resampling and transition sound; unsubscribe on dispose.
* **`tests/ui-phase12.test.ts` (16)** — preference defaults, malformed/future blobs,
  clamping, round-trip, storage denial, document classes; caption directions,
  lifetime, cap and dedupe; every menu transition including the pause → settings →
  pause regression; markup integrity (unique ids, pause dialog ARIA, caption live
  region, sliders with value outputs, switch states); seed escaping.

`tests/ui-markup.test.ts` was extended (3 → 4 tests) to cover the Phase 12 ids and
the `PHASE 12` banner, and `tests/interaction.test.ts` gained a test for the
hold-to-confirm accessibility switch (instant press → full hold again).

**Not executed:** `npm run test:browser` and any visual/audio listening check. This
sandbox has no GPU browser and Playwright's Chromium download is blocked, so
Web Audio playback, caption layout and the pause/loading presentation are
**unverified visually**. Run `npm run test:browser` on a machine with Chromium.

Two real defects were found and fixed while testing rather than papered over:
the mixer refused to steal a lower-priority voice under global pressure when the
bus had room, and `FootstepDriver` reported a phantom landing on the first frame.

---

## 11. Known issues and limitations

* **No engine or weather sounds yet.** Vehicles (Phase 10) and weather (Phase 9)
  are other work lines; the director documents the seam instead of inventing
  loops. Nothing here claims engine audio exists.
* **Stereo panning only.** `StereoPannerNode` has no elevation and no HRTF; a
  sound above or behind the player is centred/attenuated, not localised
  vertically. That is a deliberate budget, not an oversight.
* **No occlusion or reverb.** Walls do not muffle, interiors have no room tone.
  Phase 7 should drive a low-pass/duck parameter through the engine when it lands.
* **No browser verification** in this sandbox (above). Autoplay behaviour, context
  suspension on device sleep and Bluetooth latency are untested here.
* **Master mute suspends nothing.** Pause suspends the `AudioContext`; mute only
  zeroes the master node (the cheapest reversible option). Browsers may keep the
  context running while muted, which is expected.
* **Ambience is not weather.** Rain, wind gusts and storms need Phase 9's weather
  state; today's "wind" is moving air derived from exposure, not a simulation of it.
* **Title → Back to title restarts the document.** `restart` and `title` reload
  the page (the seed and quality live in the URL), which is honest but not instant;
  a hot in-place world reset would need a rebuild path that Phase 13 can own.
* **Captions are English-only and fixed wording.** They are data (`CAPTIONS` in the
  director), so localisation is a table swap, not an architecture change.

---

## 12. Performance implications

* Hard cap of 24 voices plus per-bus caps; the mixer's accounting is O(active) with
  no allocation except the decision record. No unbounded `AudioNode` creation.
* One 2-second noise buffer per engine instance (~384 kB mono at 48 kHz), shared by
  every noise layer and every ambience bed; tones cost one oscillator each.
* Ambience decisions run at 4 Hz; footsteps are a handful of comparisons per frame.
  `AudioFrame` is a small object literal per render frame (one allocation), and the
  caption DOM is only touched when the visible signature changes.
* Pausing suspends the context, so a paused tab costs no audio CPU; disposal closes
  the context and disconnects every bed and voice.
* Preference writes are one `localStorage` set per change, not per frame.
* UI work is unchanged in frequency: the HUD still updates at 180 ms intervals; the
  menu/title CSS is static.

---

## 13. Contracts for later phases

1. **One audio path.** Vehicles, weather, buildings and missions submit
   `AudioPlayRequest`s through `AudioEngine` (or `AudioDirector.playAt`), never own
   a context or create voices directly. The mixer, not the caller, decides admission.
2. **Sound is data.** New sounds are a `SoundId` plus a `VoiceRecipe`; no ad-hoc node
   graphs in gameplay code. Captions and priorities live next to the recipe.
3. **Presentation never blocks gameplay.** Audio absence, a blocked context, a
   denied `localStorage` or a missing caption sink must all degrade silently.
4. **Overlays are a state machine.** Do not add `isPaused`-style booleans elsewhere;
   add a transition to `MenuState` and let `onOverlayChange` drive the simulation.
5. **Preferences are local and disposable.** Versioned, clamped, typed, never part
   of save data; nothing may assume it was read successfully.
6. **Accessibility is a requirement.** Every new cue needs a caption or a visual
   equivalent, and every new interaction must respect the hold-to-confirm toggle.
7. **No story.** Ambience describes the world the simulation already produces; it
   never narrates a plot that has not been decided.
