# Phase 7 integration guide for Phases 4–6 / 8

## Public entry points

```ts
import { BuildingManager } from '../world/buildings/manager';
import type { BuildingPorts } from '../world/buildings/types';
```

Construct `BuildingManager` with the world seed, quality, existing `FloatingOrigin`,
a loaded terrain-height query (plus its revision), optional storage, and optional
ports. Add `manager.group` to the existing scene. Call:

- `update(observerWorldPosition, renderDt, skyHour)` during world streaming.
- `fixedUpdate(fixedDt, observerWorldPosition)` on the fixed clock, not arbitrary FPS.
- `rebase()` after the origin changes. This only repositions rendered roots.
- `setQuality(preset)` on quality changes; it does not reset door state.
- `reset(seed)` on seed changes; unregisters old interactions, shapes and graphs.
- `dispose()` during teardown; idempotent, releases shared and owned resources.

The terrain revision causes a refresh even if the observer is stationary when
worker results arrive. Exteriors, interiors, nearby collision, lights and site
caches have separate explicit bounds in `settings.ts`. Interior retention uses
26/42 m hysteresis and full 3D observer distance. Occupied buildings are prioritised.

## Physics port

```ts
// physicsBridge is the adapter supplied by the central Phase 4 physics owner.
const ports: BuildingPorts = {
  physics: {
    upsertCollider: (shape) => physicsBridge.upsertCanonicalBox(shape),
    removeCollider: (id) => physicsBridge.removeCollider(id),
    canMoveKinematic: (next) => physicsBridge.isKinematicMoveClear(next),
  },
};
```

This is an integration sketch, not a supplied rigid-body backend. The central
physics owner must implement these operations. Every payload includes stable ID,
building ID, world centre, half extents, Y rotation, material, mobility and walkable
flag. Door updates reuse the same ID and preserve the host's body identity. Building
parts are static boxes; glazing has its real aperture-sized thin box. The solid
interior stair treads and furniture have collision only while the interior is loaded.
Structural shell collision stays loaded within 90 m. A central KCC should use its
own capsule sweep against these shapes. Do not treat the conservative camera sweep
as a replacement character physics engine.

**Do not rebase host physics from `BuildingManager.rebase`.** The central physics
world already owns rebasing. Canonical shape centres and navigation nodes do not
change when the GPU origin changes. Applying a second delta corrupts the world.

## Interaction port

`interactions.register(binding)` returns an unsubscribe function. A binding has a
stable ID, building ID, canonical approach position, range, live action label and
`interact(actorWorldPosition): boolean`. The action checks distance, wall occlusion,
cooldown and current collision availability. It sets the door target; fixed ticks
animate both the rendered hinge and kinematic collision. Rotated leaf approach points use the closed collider centre, and either swing
direction is supported. Navigation portals become
passable only when the physical leaf clears the opening, not when input is pressed.

When the central interaction system is installed, remove `BuildingExperience`'s
F-key/prompt binding or replace that whole optional bridge. The building simulation
and ports are independent of its DOM and camera. Keyboard F7 and Q/E belong only to
the current developer inspector, not the future human controls.

## Entity and event integration

Use descriptor IDs verbatim. `b1:<seed-hash>:<corridor>:<station-cell>:<side>` is a
versioned generated baseline identity; `authored:<id>` is a manually placed identity.
A descriptor separates immutable world placement from streamed visual and simulation
state. Register descriptors in the central registry as building entities and forward
`BuildingPorts.events` to its typed event bus.

Events include stream-in/out, interior load/unload, entered/exited building, room
changed (including acoustic preset), door target changed, blocked door and storage
warning. These are technical events only; no mission or narrative content exists.
The default observer is the survey camera until Phase 5 supplies the human transform.

## Room, navigation and acoustic queries

- `roomAt(worldPoint)` returns building + room metadata, or undefined outdoors.
- `currentRoom` is the most recently sampled observer location.
- `collision.supportHeight(footPosition, maxStep)` queries explicit walkable parts.
- `collision.sweep(from, to, radius, halfHeight)` is a canonical OBB query for camera
  obstruction and integration tests. Corner expansion is conservative.
- `graph(buildingId)` returns world-space nodes and bidirectional gated edges.
- `findBuildingPath(graph, fromNode, toNode)` resolves the small building graph;
  global streamed-world pathfinding remains Phase 8's responsibility.

`outside` is the porch/entrance anchor for linking a pedestrian road/path graph.
Lodge stairs have one node per actual 0.2 m tread, an open stairwell and a landing.
Rooms export `wood-room`, `large-room` or `workshop` acoustic metadata; no audio
implementation is claimed. Multiple-room point lights are budgeted to one active
light per loaded building and select the observer's room while indoors.

## Authored buildings and templates

Register validated `BuildingTemplate` data through `BUILDING_TEMPLATES.register`.
Custom templates must declare truthful footprint dimensions and usable access;
schema validation alone does not prove walkability of arbitrary authored content.
Parts are local-space boxes (with optional yaw), structural roof prisms and decorative
cylinders. Solid pieces, walkable floors, rooms, lights, doors and navigation portals
are explicit. X/Z footprints, dimensions, finite coordinates, unique IDs and graph
references are validated. Templates should be registered statically if they are to
participate in worker-side procedural placement. Runtime authored templates are
supported through the main-thread reservation filter.

```ts
manager.registerAuthored({
  id: 'landmark-001', template: 'cabin', x: 1000, z: 700, yaw: 0.3,
  // y is optional; omitting it grounds the floor above the measured site.
});
```

Placement rejects road conflicts, excessive relief, overlapping authored lots,
invalid coordinates, buried floors and unsupported foundations (authored floor rise
is capped at 4 m so the external step budget can reach the ground). Generated lots
within an authored footprint are suppressed. Existing terrain is not flattened or
reseeded. Foundations extend from measured site minimum to the raised floor; entry
steps and porch share the exact geometry/collision source data. Generated plant
reservations run in terrain workers; runtime authored reservations are checked
before vegetation instance packing. The optional `onReservationsChanged` hook
invalidates the vegetation packer even for a stationary observer after authored
placement; the current composition root wires it automatically. The authored set
is bounded to 64 registrations.
Its declarations should be reproduced by the content manifest on world reset, not
saved as procedural deltas.

## Persistence

`exportModifications()` returns `{version: 1, seed, doors}`.
`restoreModifications(unknown)` validates atomically and reconstructs active runtime
instances on the next streaming update. Do not save meshes or collider handles.
The optional default adapter stores only door targets under
`wayfarer.buildings.v1:<encoded-seed>` in browser storage, capped at 512 changes.
It stages writes, reports quota/corruption errors, and refuses to overwrite an
invalid, foreign-seed or newer-format save. This is not a general save-slot system.
Phase 6/11 can replace it with the central versioned save service.

## Limits of this slice

No human model, animation, rigid-body physics integration, NPC AI, world navmesh,
general inventory, audio implementation, elevators, destructible structures, GLTF
building loader or full menu rewrite is shipped here. The supplied structures are
purpose-built modular architectural placeholders, not production scans. Those
systems are neither stubbed nor advertised as implemented.
