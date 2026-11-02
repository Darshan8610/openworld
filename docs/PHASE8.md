# Wayfarer — Phase 8: NPCs & Life Simulation

**Status: implemented / unit + headless-integration verified / browser suite not executed in this sandbox.**

Phase 8 populates the streamed world with people who exist independently of the
camera: they are placed deterministically per canonical cell, they navigate over
the same streamed terrain the player walks on, they follow data-driven daily
schedules through an extensible behaviour tree, they perceive the player through
cones, terrain line-of-sight and hearing, they react, and they can be approached
and talked to through the Phase 6 interaction pipeline.

There is **no story, no named character, no quest and no authored dialogue**.
Roles are generic population behaviours ("Trail worker", "Route watcher"), and a
conversation answers from live world data. Phase 11 can mount narrative on the
same contracts without changing them.

> Phase 7 (buildings and interiors) is owned by a different work line. NPCs
> therefore path over open terrain and around solid world objects; they do not
> enter buildings. `NavigationBlockers` is the seam a building system plugs into.

---

## 1. What Phase 8 adds

| System | Module | Summary |
|---|---|---|
| Data vocabulary | `src/npc/types.ts` | Roles, anchors, 19 behaviour ids, 4 activities, schedule ids, records, snapshots, stats, conversation view. |
| Role catalogue | `src/npc/npc-definitions.ts` | Four generic roles with label, accent, body scale, walk-speed scale, schedule, streaming radii, curiosity, alert distance. |
| Placement | `src/npc/npc-placement.ts` | Deterministic per-cell planning: roadside population projected from road-corridor stations, plus wild population; slope/walkability/road-clearance/spacing rules; stable ids. |
| Navigation | `src/npc/navigation.ts` | `NavField`: 4 m grid nodes over streamed terrain, walkability by slope/water/blockers, A* with an expansion cap, goal snapping, road penalty, node cache, path smoothing + line-of-sight. |
| Grounding | `src/npc/npc-sampler.ts` | Feet-on-terrain sampling from the real terrain mesh, cached contacts, ground blocking. |
| Perception | `src/npc/perception.ts` | Vision cone + range, terrain line-of-sight sampling, hearing stimuli, decaying memory, startle flag, player detection. |
| Schedules | `src/npc/schedule.ts` | Data-driven daily windows per schedule id with per-NPC deterministic phase offsets; activity → anchor mapping. |
| Behaviour | `src/npc/behaviour.ts` | Behaviour-tree library (leaf/sequence/selector/reactive selector/cycle/loop) plus the nodes that produce every behaviour state, and `NpcBrain`. |
| Dialogue hooks | `src/npc/dialogue.ts` | Four functional topics composed from live world data; session state; no narrative content. |
| Simulation | `src/npc/npc-instance.ts` | The NPC entity: locomotion through the shared `CharacterMotion`, brain, perception, interaction provider, persistence record, render pose. |
| Visuals | `src/npc/npc-visual.ts` | Two honest tiers: pooled skinned rigs (player rig + mixer, role tint) and cheap procedural proxies; background NPCs render nothing. |
| Streaming owner | `src/npc/npc-manager.ts` | Cell planning, nearest-first population budget, four simulation levels with hysteresis, rig budget, separation, path-search budget, conversations, save diff, stats. |
| Persistence | `src/persistence/npc-store.ts` | Versioned per-seed envelope, strict validation, sanitised load, refuses newer/unknown formats, entry cap. |
| Wiring | `src/core/game.ts`, `src/ui/interface.ts`, `src/ui/style.css` | Fixed-step simulation, rebase, quality/seed rebuild, `N` toggle, `?npcs=0`, dialogue panel, HUD/diagnostics, save. |

---

## 2. Population model

### 2.1 Placement (deterministic, no RNG carried between sessions)

Every canonical 512 m cell plans its own population from `(seed, cell, slot)`:

* **Roadside population.** Road corridors are laid out every
  `CONFIG.roads.corridorSpacing`. A cell enumerates the corridor stations whose
  northing falls inside the cell, rolls a 55 % occupancy, jitters the station
  ±35 m along the corridor, then scans a fixed verge ladder
  (`13, 19, 26, 34, 44, 56, 70, 86 m` lateral, 0–4 m jitter) outwards from the
  carriageway on a seeded side. The first candidate that is walkable, within the
  slope ceiling (0.55) and clear of the road (> 10 m) wins.
  *Ground within ~30 m of the centreline is usually cut/fill, so the ladder is
  deliberately not a fixed 9.5 m verge — that assumption produced an empty world
  in an early version.*
* **Wild population.** Three candidates per cell at a 40 m inset, rejected on
  slope, road clearance, spacing from already-planned anchors (55 m) and
  walkability.
* **Anchors.** Each NPC gets `home` (30 m), `work` (70 m) and `leisure` (46 m)
  anchors, each searched up to six times for walkable, slope-accepted ground and
  falling back to the spawn point. Anchors are where the schedule sends them, so
  an NPC's day has destinations instead of a random walk.
* **Identity.** `npc.<cx>.<cz>.r<corridor>.<slot>` for roadside,
  `npc.<cx>.<cz>.w<attempt>` for wild. The id is a function of the cell and slot,
  never a counter, so it survives streaming out/in and relaunches.

Measured on the default seed: **99 NPCs across 42 of 49 cells** near spawn
(13 roadside, 86 wild) in ~116 ms for 49 cells, planned lazily per streaming tick.

### 2.2 Streaming and fidelity (four levels)

`NpcManager` streams canonical cells within `CONFIG.npc.loadRadius` (2 → 5×5),
nearest-first, inside the preset population budget, with a planning budget so a
frame never plans 25 cells at once. Each NPC gets a `SimulationLevel`
(`src/game/entity.ts`):

| Level | Distance | Simulation | Visual |
|---|---|---|---|
| Full | ≤ 95 m | every fixed 120 Hz tick, A* allowed | pooled skinned rig + mixer |
| Reduced | ≤ 230 m | accumulated ~15 Hz think step | procedural proxy |
| Background | ≤ 640 m | schedule bookkeeping only | none |
| Dormant | beyond | not streamed | — |

Band hysteresis (25 m) prevents thrash. The rig pool is capped by the preset
(Low 2 / Balanced 4 / High 6 / Ultra 8). Population budget per preset: 8 / 14 /
20 / 28. When the budget truncates the neighbourhood the fact is reported in
`stats.truncated` and the `F3` overlay, never silently.

### 2.3 Identity across streaming

Streaming out does not destroy identity: `NpcInstance.toRecord()` writes role,
position, yaw, behaviour, activity and `talked`; the record is folded into the
manager's save diff. When the NPC re-enters the stream the record is applied back
(`applyRecord`). The persistence slice is a diff of changed NPCs only, keyed by
seed and id, so unvisited populations cost nothing.

---

## 3. Navigation

`NavField` is a demand-built walkable graph, not a world-wide navmesh:

* Node size 4 m; nodes are cached (bounded at 6000, evicted first-in) and carry
  height, walkability and cost.
* Walkability = slope ≤ 0.62, above the water line, not blocked by the
  `NavigationBlockers` provider (solid world objects today, buildings later) and
  not inside the water body; road distance adds an A* cost penalty (6) so
  pedestrians prefer the verge but may cross.
* A* uses a bounded open heap, an expansion cap (1200), an arrival radius (1.1 m)
  and goal snapping. **If the goal node is never expanded the search returns
  `null`** — no "best-effort" partial path, which would make NPCs walk at walls.
  Snapped goals displaced beyond `size × 1.6` are rejected.
* The path is simplified by line-of-sight string-pulling, so movement is straight
  segments rather than grid steps.
* Searches are budgeted globally: `searchesPerSecond` 8, `repathSeconds` 1.8 per
  NPC, and only full-fidelity NPCs may search. `stats.searches` exposes usage.
* Chunk boundaries are invisible to navigation: nodes are canonical world
  coordinates, so a path may cross any number of streamed chunks; if the next
  node's ground is not ready the NPC waits rather than teleporting.

Water is handled as a boundary (`WaterQuery`), not as terrain: NPCs do not enter
water, and a path that would need to is not produced.

---

## 4. Perception

`Perception.update(dt, self, targets)` is reusable and independent of the brain:

* **Vision** — 26 m range, 110° full cone (`CONFIG.npc.perception`); a target
  inside 1.6 m counts regardless of cone edge.
* **Line of sight** — 7 height samples along the ray against `WorldQueries`, so a
  ridge, cut bank or rock hides a player. No raycasting against scene meshes, no
  physics dependency.
* **Hearing** — `hear(x, y, z, distance)` records a `stimulus` memory inside 15 m;
  sounds alert without revealing the player.
* **Memory** — awareness decays over `memorySeconds` (6 s), so an NPC remembers a
  player who just stepped behind a rock, then forgets. `alerted` is the single
  question the brain asks.
* **Startle** — `justSpotted` marks the first visible tick; `takeSpot()` reads and
  clears it, so exactly one reaction fires per sighting regardless of tick rate.
  A 4 s `spotCooldown` stops an NPC that keeps losing and re-acquiring sight (while
  turning, say) from stuttering in and out of a startle.
* **Reaction range** — `NpcDefinition.alertDistance` bounds every reaction: outside
  it the schedule resumes even if the player is still visible, so workers do not
  flee across the valley from a distant player.

`tests/npc-perception.test.ts` covers cone edges, range, ridge occlusion, memory
decay, hearing radius and the startle flag.

---

## 5. Behaviour

### 5.1 Tree primitives (`src/npc/behaviour.ts`)

`PredicateNode`, `SequenceNode`, `SelectorNode`, `ReactiveSelectorNode`,
`CycleNode`, `LoopNode` and timed leaves. All leaves issue **intent** only —
`walkTo`, `stop`, `face` — and set a behaviour id. They never write positions or
meshes, so the shared locomotion solver and fixed step remain the single source
of motion.

Two semantics matter and are tested:

* `SelectorNode` stops at the first success (standard BT), so a priority list
  does not "fall through".
* The root is a `ReactiveSelectorNode`: higher-priority branches are re-evaluated
  every tick, letting a conversation or a startle preempt a walk in progress, and
  a `CycleNode` alternates routine tasks (work → look → errand → work) without
  ending the activity.

### 5.2 State vocabulary (19 real simulated states)

`NPC_BEHAVIOURS` — every entry is produced by a node that changes simulation
state and is asserted by test:

| State | Produced by | What actually happens |
|---|---|---|
| `idle` | `IdleNode` | stops and stands for a bounded random duration |
| `walk` | `WanderNode(..., 'walk')` | walks to a nearby walkable point at a reduced speed |
| `wander` | `WanderNode` | walks a longer roam leg (up to 46 m) |
| `run` | `FleeNode` (urgent) | walks away at 2× base speed when the player is within 5 m |
| `look` | `LookAroundNode` | stops and sweeps several headings |
| `travel` | `GoToAnchorNode` | paths to the schedule anchor (move to destination) |
| `work` | `HoldAnchorNode` | holds the work post, facing it, for a bounded spell |
| `sit` | `SitNode` | seated pause at the leisure/rest anchor |
| `eat` | `EatNode` | meal pause (see limitations: no item consumption yet) |
| `rest` | `IdleNode(..., 'rest')` | standing rest at the anchor |
| `sleep` | sleep tree | walks home, then sleeps in 30–70 s blocks |
| `follow` | `FollowNode` | escorts a *visible* player inside a 3.4–5 m band, fails when sight is lost |
| `wait` | `WaitNode` | bounded wait at a post |
| `investigate` | `InvestigateNode` | walks to the last known sighting, gives up when the memory fades |
| `react` | `ReactNode` | startle: stops, turns to the player, hands over |
| `avoid` | `AvoidNode` | detours around `probeAhead` blocking ground, then hands back |
| `talk` | `TalkNode` | stops and faces the player while a conversation is open |
| `return` | `ReturnToPostNode` | paths back to the post after a detour |
| `flee` | `FleeNode` | backs away at 1.25× speed for a few seconds |

Priority order at the root: **conversation → obstacle ahead → startle → shy
reaction → curious reaction (investigate → escort) → schedule tree**. The root is a
reactive selector, so a higher branch preempts a walk already in progress, and
every leaf re-asserts its behaviour id on each tick — a paused or aborted branch
can never leave a stale label ("talk", "flee", "react") on the NPC.

Animation mapping is honest: the shared humanoid rig has locomotion clips only,
so `sit`, `eat`, `rest` and `sleep` drive the crouch pose and `run` uses the
sprint clip. Nothing is labelled as an animation the rig does not have.

### 5.3 Schedules (data-driven)

`DEFAULT_SCHEDULES` defines three generic schedules over four activities
(`sleep`, `work`, `leisure`, `wander`). A role selects a schedule; each NPC gets a
deterministic phase offset (< 1 h) derived from its seed hash, so populations do
not move in lockstep. The brain resolves the live activity from the world clock
(`time` option, i.e. the sky/day cycle) and swaps in that activity's tree:

* **sleep** — walk home → sleep in blocks.
* **work** — walk to the post → short wait → cycle: hold the post → look around →
  short errand and back (`return`).
* **leisure** — walk to the leisure anchor → cycle: sit then eat → look around →
  stroll → rest.
* **wander** — cycle: long roam → stroll → look around → pause.

Authored NPCs in later phases call `NpcBrain.setBehaviourTree(map)` to supply
their own trees without touching the brain, the manager or the events.

---

## 6. Interaction and conversations

`NpcInstance` implements `InteractionProvider`, so the Phase 6 targeting pass finds
people exactly like world objects: aim cone + reach, one prompt ("Talk to …"),
hold-to-confirm not required, cooldown, typed action dispatch.

* `NpcManager.requestTalk(npc)` opens the session, stops the NPC, marks it
  `talked`, emits `npc:talkStarted` and breaks off if the player walks past
  `talkBreakDistance` (5.5 m).
* `selectTopic(index)` resolves a `DialogueLine`; `endConversation(reason)`
  (`'player' | 'distance' | 'timeout'`) closes and emits `npc:talkEnded`.
* `conversationView` is the UI contract: `{ npcId, npcLabel, topics, line }`.
* Topics are functional, not narrative: local conditions (biome, surface, grade,
  distance to the road, compass bearing), directions to the nearest road point,
  current activity, farewell. Every word is a rendering of numbers the
  simulation already computed — the same generator produces the same answer in
  any language later.

The interaction layer had to be widened for this: `InteractionProvider.archetype`
was typed as the object `ObjectArchetype`, which made non-object providers
impossible. It is now the structural `InteractionArchetype`
(`src/interaction/types.ts`); object behaviour is unchanged.

---

## 7. Persistence

`NpcStateStore` (`src/persistence/npc-store.ts`) mirrors the Phase 6 object store:

* Versioned envelope per seed, with a field whitelist:
  `{ role, x, y, z, yaw, behaviour, activity, talked }`.
* `save(seed, npcs, now)` → `{ status: 'ok' | 'refused' | 'failed' }`;
  `load(seed)` → `{ status: 'empty' | 'ok' | 'invalid', reason? }`.
* Unknown roles and missing coordinates are dropped; `y` is clamped to ±9000;
  defaults fill missing optional fields (`yaw 0`, `behaviour 'idle'`,
  `activity 'wander'`, `talked false`).
* A newer format or a different format is **refused, not overwritten**, and the
  player gets a toast explaining why.
* Entries are capped at `NPC_SAVE_LIMIT` (512); corrupt JSON is recoverable on the
  next write.

---

## 8. Events

Phase 8 adds to `GameEventMap`:

| Event | Payload | When |
|---|---|---|
| `npc:spawned` | `{ id, role, level }` | an NPC enters the stream |
| `npc:despawned` | `{ id, role }` | it leaves the stream |
| `npc:behaviourChanged` | `{ id, behaviour, activity }` | only on change, never per tick |
| `npc:detectedPlayer` | `{ id, distance }` | sight acquired |
| `npc:playerLost` | `{ id }` | sight lost after the memory fades |
| `npc:talkStarted` | `{ id, label }` | a conversation opens |
| `npc:topicSelected` | `{ id, topic, line }` | the player picks a topic |
| `npc:talkEnded` | `{ id, reason }` | conversation closes |
| `npc:stateChanged` | `{ id, role }` | a restored/edited record changes state |

---

## 9. UI and controls

* **N** toggles the population; `?npcs=0` disables it from a share link. Only the
  NPC layer stops — terrain, vegetation, roads and objects keep streaming.
* The settings panel gains a **People** switch, and the diagnostics block reports
  streamed/full/reduced/background counts, rigs in use vs. capacity, A* searches
  used, budget truncation and the nearest NPC's label and behaviour.
* `E` opens a conversation with the NPC in reach; `1`–`4` pick a topic, `Esc`
  leaves. The dialogue panel is a plain DOM overlay, re-rendered only when the
  view changes.

---

## 10. Validation

Executed in this sandbox:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | **242 passed / 242** across 25 files |
| `npm run build` | pass (main bundle 1,192.52 kB, gzip 337.09 kB) |
| `npx vitest run tests/npc-behaviour.test.ts` | 23 / 23 |
| `npx vitest run tests/npc-navigation.test.ts` | 7 / 7 |
| `npx vitest run tests/npc-perception.test.ts` | 8 / 8 |
| `npx vitest run tests/npc.test.ts` | 12 / 12 |
| `npx vitest run tests/npc-system.test.ts` | 11 / 11 |

What the new suites actually assert:

* **`npc-navigation.test.ts`** — walkability (slope/water/blockers), A* reaches a
  goal around a blocked wall, returns `null` when the goal is unreachable
  (no partial path), respects the expansion cap, snaps nearby goals, prefers
  off-road routes, line-of-sight rejection, bounded node cache.
* **`npc-perception.test.ts`** — cone edges, out-of-range targets, ridge
  occlusion, memory decay and forgetting, hearing radius, startle read-and-clear
  and the sighting cooldown.
* **`npc-behaviour.test.ts`** — schedule windows/offsets, tree primitives
  (sequence, selector, loop, cycle, idle timing), every behaviour node with a
  scripted agent, preemption by conversation, curious/shy reactions, alert-range
  bounding, stale-label prevention, plus a simulated day that reaches **all 19
  documented states**.
* **`npc.test.ts`** — placement determinism, containment in the cell, off-road
  and walkable anchors, unique ids across cells, the role catalogue, dialogue
  context/compass and session lifecycle, and the persistence store's round-trip,
  sanitising, refusal and entry cap.
* **`npc-system.test.ts`** — headless integration with real terrain queries and the
  real interaction manager: streaming and budget truncation, convergence across
  ticks, simulation levels and rig budget, disable/enable, locomotion following
  terrain, floating-origin rebase, clock-driven behaviour change, a real
  interaction prompt → `npc:talkStarted` → topic → `endConversation`, save →
  restore on a fresh world, changed-only saves, and `blocksWalk` semantics for
  solid vs. dynamic objects.

**Not executed:** `npm run test:browser` and any visual check. This sandbox has no
GPU browser and Playwright's Chromium download is blocked, so rendering, the
dialogue panel layout and real-world navigation quality are **unverified** here.
Run `npm run test:browser` on a machine with Chromium.

---

## 11. Known issues and limitations

* **No browser/visual verification** in this sandbox (above).
* **Seated poses use the crouch clip.** The shared rig has 13 locomotion clips and
  no sit/eat clips; the states are real simulation states, the pose is approximate.
  A dedicated NPC rig with seated clips would fix the presentation only.
* **`eat` consumes nothing.** NPCs have no inventory, so a meal is a timed
  activity at a rest anchor. It is labelled as an activity state, not as an item
  interaction.
* **No indoor navigation.** Phase 7 (buildings) is a separate work line; NPCs path
  around solid objects via `NavigationBlockers` but cannot enter interiors or use
  stairs yet.
* **No voice audio.** Phase 12 synthesises footsteps, ambience and greeting /
  reply / farewell cues from the existing `npc:*` events; NPCs do not speak —
  conversations remain text, and there is no speech synthesis or recorded voice.
* **Path quality is grid-based.** 4 m nodes with string-pulling are adequate for
  verge and meadow traffic; dense props in tight spaces may still produce short
  detours rather than elegant curves.
* **Traffic awareness is absent.** NPCs cross roads with a cost penalty but do not
  react to vehicles; vehicles arrive in Phase 10 and should feed the perception
  `stimulus` channel.
* **Crowd separation is a pairwise hint** computed inside a bounded radius, not a
  full local avoidance solver; very dense crowds can still overlap briefly.

---

## 12. Performance implications

* Planning is lazy and bounded: only cells inside the load radius are planned, and
  a per-tick planning budget spreads a fresh neighbourhood over several ticks.
* Population is capped by preset (8/14/20/28) and truncated nearest-first; rigs are
  pooled and capped (2/4/6/8), proxies beyond the full band, nothing rendered in
  the background.
* Thinking is level-gated: full NPCs every 120 Hz tick, reduced NPCs at ~15 Hz,
  background NPCs only schedule bookkeeping. The per-tick work is O(active NPCs)
  with small constants; no allocation-heavy paths in the think loop.
* A* is the only expensive operation and is globally capped at 8 searches/second
  with a 1200-expansion ceiling per search and a 6000-node cache.
* Separation uses a bounded neighbourhood query, not all pairs.
* Everything is disposed on disable, seed change, quality change and teardown:
  rigs, materials, geometries, pooled proxies and the manager's group.

---

## 13. Contracts for later phases

1. **Placement is data.** A population is `(seed, cell, slot) → PlacedNpc`; authored
   NPCs should register in the same planning path with stable world coordinates
   rather than being spawned ad hoc.
2. **Motion is intent.** Behaviour nodes call `walkTo`/`stop`/`face` on `NpcAgent`.
   Nothing else may move an NPC; the fixed step and the locomotion solver stay the
   only writers of motion.
3. **The brain is replaceable.** `NpcBrain.setBehaviourTree` accepts authored trees;
   the reaction guards and conversation branch stay above them.
4. **Perception is reusable.** `Perception` is world-query based and has no
   knowledge of the brain; mission logic, vehicles and audio can subscribe to
   sightings through the event bus.
5. **Interaction is generic.** Any interactive thing implements
   `InteractionProvider` with a structural `InteractionArchetype`; NPCs prove the
   contract is not object-specific.
6. **Persistence stays diff-only and versioned.** Regenerable baseline data
   (placement, anchors, roles) is never stored; unknown or newer formats are
   refused.
7. **No story.** Dialogue remains a functional hook. Narrative, factions and quests
   mount on Phase 11.
