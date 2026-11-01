# Wayfarer — Open-World Roadmap

Wayfarer is becoming a full, seamless, procedural open-world game rather than a
terrain demo. The old driving-game plan (Phase 4 = drivable cars) is superseded by
the architecture below. Nothing here invents story content: these are technical
systems a narrative can later be attached to.

| Phase | Scope | Status |
|---|---|---|
| 1 | World foundation: renderer, streaming quadtree, floating origin, sky, survey rig | **done** (`docs/PHASE1.md`) |
| 2 | Biomes, surface detail, vegetation | **done** (`docs/PHASE2.md`) |
| 3 | Graded scenic roads, route survey, roadside props, Ultra preset | **done** (`docs/PHASE3.md`) |
| 4 | Core game engine & physics: world entity model, events, physics engine, debug | **in progress (separate agent)** — Phase 6 shipped the seams it needs: `src/core/entities.ts`, `src/core/events.ts`, `src/core/spatial.ts`, `src/physics/*` |
| 5 | Playable character: controller, third-person camera, animation, swimming foundation | **in progress (separate agent)** — Phase 6 shipped the target `ActorView` contract and grounded prop bodies to push |
| 6 | World objects & interactions | **done** (`docs/PHASE6.md`) |
| 7 | Buildings & interiors | pending — reuse `InteractionProvider`, `ObjectState`, `ObjectStateStore`, streaming cells |
| 8 | NPCs & life simulation | pending — reuse `EntityRegistry`, simulation bands, `InteractionProvider`, event bus |
| 9 | Water & environmental simulation | pending — `SurfaceKind.water` and the buoyancy hooks exist in the material table; `player:enteredWater` events are declared |
| 10 | Universal vehicles (land/air/water) | pending — `player:seated`/`player:stood`, `PropPhysicsWorld.push` and the road query layer are ready |
| 11 | Discovery & gameplay infrastructure: map, navigation, save slots, missions | pending — the `ObjectSave` envelope is the pattern for the full save format |
| 12 | Audio, UX and polish | pending — `GameEventBus` is the audio trigger source |
| 13 | Optimisation and release hardening | pending |

## Stable contracts other phases must build on

1. **Coordinates** — canonical world doubles everywhere; render space only via
   `toRenderPoint`/`FloatingOrigin`. No system stores a render-space position.
2. **World queries** — `WorldQueries` is the only source of height, normal,
   slope, biome, road space and `SurfaceKind`. Do not re-derive terrain.
3. **Entities** — `EntitySpec`/`EntityRegistry` for identity, position, bounding
   radius, streaming bands, persistence policy and lifecycle. Rendering, physics
   and AI state stay in their own systems.
4. **Events** — new cross-system signals are added to `GameEventMap`; systems
   subscribe instead of importing each other.
5. **Interaction** — implement `InteractionProvider` (`centre`, `radius`, `range`,
   `targetLabel`, `actions()`, `state()`, `setState()`, `remove()`) and the
   existing targeting, prompt, hold and event pipeline works unchanged.
6. **Physics** — gameplay talks to `PropPhysicsWorld`
   (`add`/`remove`/`step`/`applyImpulse`/`push`/`raycast`/`stats`). Phase 4 may
   replace its internals with a WASM engine behind that interface.
7. **Persistence** — versioned, validated, diff-only envelopes; never overwrite a
   newer format; never store regenerable baseline data.

## Growth rules

* Every system must stream, respect a budget and dispose its GPU resources.
* Fixed-step simulation only; nothing important depends on frame rate.
* No unbounded entity, body, particle or listener creation.
* New world content is deterministic in `(seed, canonical cell)`; authored content
  is placed by stable world coordinates.
* Document what is not implemented instead of shipping an empty shell.
