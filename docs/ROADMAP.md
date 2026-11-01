# Wayfarer — Open-World Engineering Roadmap

The new direction is a story-independent, hybrid procedural/authored open world.
The original driving-only roadmap is superseded. Do not infer implementation from
this plan: the actual baseline on this branch is Phases 1–3 plus the Phase 7 building
slice. Other agents own Phases 4–6; their implementations are not present here.

| Phase | Ownership / scope | Integration boundary |
|---|---|---|
| 4 — Core engine & physics | World/entity registry, typed world events, canonical queries, fixed-step rigid-body physics and origin rebasing | Consume building descriptors and canonical static/kinematic collider payloads; own physics-local conversion and body rebasing |
| 5 — Human character | Capsule controller, locomotion/animation, third-person camera and swimming foundation | Consume structural/door/furniture collisions, floor support, room volumes and entrances; replace the optional inspection bridge |
| 6 — Objects & interaction | Generic interaction targeting, objects, inventory hooks and object persistence | Register building door bindings through `BuildingPorts.interactions`; store building door deltas in the central save format |
| **7 — Buildings & interiors** | **This branch:** validated modular templates, deterministic/authored sites, physical structure data, operating doors, bounded interiors, lighting, room/portal/stair navigation and transition events | See [PHASE7.md](PHASE7.md) and [building integration guide](BUILDING_INTEGRATION.md) |
| 8 — NPC life simulation | Navigation, schedules, perception, behaviour, conversations as hooks, population LOD and persistence | Attach pedestrian world routes to building `outside` nodes; traverse explicit room portals and stair nodes; respect blocked doors |
| 9 — Water & environment | Water queries/rendering, buoyancy, weather, swimming, effects/particles | Extend canonical surface queries and material response; validate sites against future water and flood exclusion volumes |
| 10 — Vehicles | Shared occupants/seats, distinct land/air/rotor/water physics, entry/exit, cameras/audio and persistence | Use road/world queries and building collision/garage entrance data; never share a simplistic vehicle controller |
| 11 — Discovery & gameplay infrastructure | Map, minimap, route planning, discovery, versioned saves and narrative integration hooks | Display stable building identities and canonical positions; save modified state, not procedural geometry |
| 12 — Audio, UX & polish | Spatial sound, acoustics, menus, accessibility, controls, loading and recovery | Subscribe to room acoustic metadata and indoor/outdoor events; replace inspection UI with the normal player HUD |
| 13 — Hardening | Real-GPU/browser matrix, long-run resource budgets, adaptive quality and persistence migrations | Exercise walking/driving/flying across origin shifts and streamed interiors, with central physics and player systems attached |

## Rules for parallel integration

- Keep `TerrainManager`, worker generation, seed functions, existing renderer
  fallback and the fixed clock. New subsystems attach at the composition root.
- Data is canonical world-space doubles. Mesh and physics origins are separate
  implementation details, never stored in world saves or navigation data.
- Physics has one owner. Phase 7 supplies geometry and query data, not a second
  rigid-body world or a competing playable-character controller.
- Interaction has one owner. The door port is replaceable; the F-key inspection
  prompt can be removed without changing door simulation or templates.
- Each module owns its resource teardown and must be tested before integration.
- No story, plot, character identity, lore or authored narrative is defined here.

## Migration from the current composition root

`Game` currently owns the terrain, vegetation, road, sky, camera and building
subsystems. The Phase 4 world manager can take ownership of building updates,
fixed ticks and lifecycle without changing `BuildingManager` public queries.
`BuildingExperience` is a removable adapter, not a gameplay dependency. The normal
player transform should eventually be the observer passed to `update` and
`fixedUpdate`. Hook the central event bus through the typed event port; all other
systems can subscribe there instead of depending on the building renderer.
