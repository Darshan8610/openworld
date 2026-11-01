# Wayfarer — Roadmap

Wayfarer is no longer only a driving-world demonstration. The target is a **full-scale,
seamless, procedural open-world game** — walking, driving, flying, sailing, building
interiors, NPCs, weather, water and a story that will be written later.

The story has deliberately **not** been decided. Nothing in this repository invents a
plot, protagonist, antagonist, faction or questline. Instead the engine exposes the
systems a story will later plug into.

## Principles

1. **Evolve, never restart.** The infinite seeded world, quadtree streaming, floating
   origin, worker generation and WebGPU/WebGL2 fallback are permanent foundations.
2. **One world.** Every new system integrates with the same world manager, coordinate
   model, fixed timestep and query service. No isolated demos.
3. **Hybrid content.** Procedural terrain and decoration with data-driven buildings,
   settlements and hand-authored landmarks at stable world coordinates.
4. **Bounded simulation.** Nothing grows without a cap: entities, bodies, particles,
   audio voices and CPU time all have budgets.
5. **No fakes.** A system exists when it simulates, integrates and is tested — not when a
   state name or a placeholder mesh exists.

## Phases

| Phase | Scope | Depends on |
|---|---|---|
| **1–3** | World foundation, biomes/vegetation, roads/routes/props, Ultra graphics | — |
| **4 — Core game engine & physics** ✅ | Rapier integration, canonical↔physics-local coordinates, rebase-safe bodies, streamed terrain heightfield colliders, physics materials, collision layers/events, debug visualisation, entity model + multilevel streaming, unified world query, typed event bus, world manager ordering | 1–3 |
| **5 — Playable character** ✅ | Capsule character controller on the fixed step, locomotion state machine (walk/jog/sprint/crouch/jump/fall/land), slope and step handling, coyote time and jump buffering, third-person camera with collision avoidance, first-person option, GLTF humanoid + animation blending, swim foundation | 4 |
| **6 — Objects & interaction** ✅ | Interactable interface (id, prompt, range, predicates, cooldown, persistent state), context-sensitive prompts, doors/containers/switches/pickups, physics props, object persistence. Gamepad + touch input abstraction remain pending | 4, 5 |
| **7 — Buildings & interiors** | Modular building templates and prefabs, terrain-conforming placement, collision, room graphs, doors, stairs, furniture, interior lighting, indoor/outdoor transitions, interior streaming | 4, 6 |
| **8 — NPCs & life simulation** ✅ | NPC entities, behaviour FSM/behaviour trees, navmesh over streamed terrain, perception (vision cones, LOS, events), schedules, interaction/dialogue hooks, LOD population management, persistence | 4, 5 |
| **9 — Water & environment** | Lakes/rivers/ocean bodies, water shading with capability fallbacks, buoyancy via multi-point displacement, swimming/diving, splashes and wakes, weather controller (rain/snow/fog/storm) driving light, surface wetness, particles | 4, 5 |
| **10 — Universal vehicles** | Shared vehicle interface (seats, entry/exit, camera, audio, damage, persistence) with distinct controllers: raycast-suspension road vehicles, motorcycle/bicycle balance, aircraft aerodynamics + helicopters, watercraft buoyancy/propulsion, sailing | 4, 9 |
| **11 — Discovery & gameplay infrastructure** | World map + minimap from canonical coordinates, route calculation, waypoints, discovery/fog-of-war, save/load with versioned schemas and migration, inventory hooks, generic mission/objective/flag system on the event bus | 4–10 |
| **12 — Audio, UX & polish** | Spatial audio with zones and mixing, footsteps/engines/weather sounds, main and pause menus, settings, accessibility, loading/recovery, presentation pass | all |
| **13 — Optimisation & release** | Adaptive quality, profiling, browser matrix, memory and GPU fallback testing, long-run streaming, save validation, regression suite, production build | all |

## Phase 4 contracts that later phases must honour

These are load-bearing; changing them requires updating every consumer.

1. **Coordinates.** Gameplay stores canonical world doubles. Only `PhysicsWorld` and
   renderer objects work in origin-relative space. Rebase = translate render/physics
   frames, never mutate canonical data.
2. **Query timing.** Rapier's broad-phase refreshes during `step()`. After a teleport or
   rebase, queries are valid from the next step. `WorldManager` runs ground streaming and
   physics in the same frame, after the rebase.
3. **World queries.** All terrain/road/surface/water answers come from `WorldQuery`.
   Systems must not re-derive them.
4. **Entity lifecycle.** Everything streamed registers in `EntityRegistry` with a stable
   id, bounds, priority and persistence policy; simulation level controls fidelity, not
   existence.
5. **Budgets.** Physics bodies (640), colliders (1280), entity population per level,
   terrain ground tiles (12) are hard caps that emit events when hit.
6. **Events.** Cross-system communication goes through `EventBus` with typed payloads;
   later phases extend `GameEventMap` by declaration merging.
7. **Fixed step.** Physics and gameplay run at 120 Hz independent of render rate;
   rendering interpolates.
8. **No story.** Narrative, dialogue and missions mount on Phase 11 infrastructure;
   they are not part of the engine phases.

## Phase 8 contracts that later phases must honour

These extend the Phase 4 and 6 contracts; all remain in force.

1. **Population is data.** A population is `(seed, canonical cell, slot) → PlacedNpc`
   with stable ids and home/work/leisure anchors. Authored NPCs register in the same
   planning path; nothing spawns people ad hoc.
2. **Motion is intent.** Behaviour nodes call `walkTo` / `stop` / `face` on
   `NpcAgent`. Only `CharacterMotion` on the fixed step writes NPC positions.
3. **Brains are replaceable.** `NpcBrain.setBehaviourTree` accepts authored trees;
   conversation, obstacle, startle and reaction guards stay above them.
4. **Perception is reusable.** `Perception` answers sight (cone + terrain LOS),
   hearing, memory and the startle flag from world queries only; missions, vehicles
   and audio subscribe through the event bus rather than re-deriving visibility.
5. **Navigation is budgeted.** `NavField` searches are globally rate-limited and
   expansion-capped, and an unreachable goal returns `null` — never a partial path.
   `NavigationBlockers` is the seam for buildings and vehicles.
6. **Interaction is generic.** NPCs implement the Phase 6 `InteractionProvider`
   with a structural `InteractionArchetype`; do not re-specialise it per content type.
7. **People persist as a diff.** `NpcStateStore` stores only changed records, keyed by
   seed, versioned and refused when the format is unknown or newer.
8. **No story.** Conversations are functional hooks composed from live world data.
   Narrative, factions and quests mount on Phase 11.

## Phase 6 contracts that later phases must honour

These extend the Phase 4 contracts; both remain in force.

1. **Objects** — every interactive thing implements `InteractionProvider`
   (`centre`, `radius`, `range`, `targetLabel`, `actions()`, `state()`, `setState()`,
   `remove()`). Targeting, prompt, hold-to-confirm and dispatch then work unchanged.
2. **Streaming** — objects are deterministic in `(seed, canonical cell)` and stream
   through `ObjectSystem` cells; authored content is placed by stable world coordinates.
3. **Persistence** — state is versioned, validated, diff-only and keyed by seed; an
   unknown or newer format is refused instead of overwritten. Regenerable baseline data
   is never stored.
4. **Prop physics** — gameplay prop bodies talk to `PropPhysicsWorld`
   (`add`/`remove`/`step`/`applyImpulse`/`push`/`raycast`/`stats`), which is separate
   from the Rapier world physics used for streamed terrain and large rigid bodies.
5. **Growth rules** — every system streams, respects a budget and disposes its GPU
   resources; simulation runs on the fixed step; no unbounded object, body, particle or
   listener creation.
