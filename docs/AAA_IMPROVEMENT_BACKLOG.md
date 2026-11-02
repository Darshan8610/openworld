# WAYFARER — AAA Improvement Backlog & Milestone Plan

**Status:** APPROVED FOR EXECUTION  
**Version:** 1.0.0  
**Scope:** Vertical Slice 001 and Production Maturation  

---

## 1. Backlog Overview

| Priority | Focus Area | Impact | Status |
|---|---|---|---|
| **Priority A** | Vehicle visuals, Character visuals, Unique NPC faces, Building colliders, Settings button | Core Gameplay & Immersion | **IN PROGRESS** |
| **Priority B** | Modular urban building kit, Road network graph, High-GFX foliage & vegetation, PBR materials | Environmental Storytelling | **ACTIVE** |
| **Priority C** | Recorded audio library, Particle VFX, Dashboards, Tire skidmarks, Screen-space reflections | Commercial Polish | **QUEUED** |

---

## 2. Priority A — Core Deficiencies (Immediate Execution)

### Task A.1: Vehicle Visual System (Finding AUD-04)
- **Goal:** Provide visible 3D meshes for vehicles driven or spawned in the world.
- **Scope:** Initial library of 8 distinct vehicle families:
  1. *Sedan* (Aurelia 4-door family sedan)
  2. *Compact* (Pueblo hatchback)
  3. *SUV* (Sierra 4x4 rugged SUV)
  4. *Pickup* (Bighorn double-cab utility truck)
  5. *Sports Car* (Vanguard GT coupe)
  6. *Supercar* (Infernus mid-engine exotic)
  7. *Muscle Car* (Sabre V8 American muscle)
  8. *Motorcycle* (Cruiser 750cc twin)
- **Requirements:** Chassis, cabin, 4 wheels (front steer, rear drive), transparent glass, headlights, taillights, suspension offset synchronization with Rapier physics entity.
- **Responsible Agent:** Vehicle Asset Agent.
- **Acceptance Criteria:** Player approaches, enters, and drives a vehicle with visible wheels rotating, steering, and headlights casting light.

### Task A.2: Player Character Model & Rigging (Finding AUD-03)
- **Goal:** Upgrade the procedural placeholder character to an authored production model with realistic proportions and detailed outfit.
- **Scope:** Humanoid torso, jacket, trousers, boots, backpack, hands with fingers, and detailed head topology.
- **Responsible Agent:** Character Asset Agent.
- **Acceptance Criteria:** Smooth locomotion across all 13 animation states with zero joint dismemberment or head spinning.

### Task A.3: Unique NPC Faces & Expanded Population (Finding AUD-05 & AUD-06)
- **Goal:** Ensure every NPC in the world has a distinct, individual face; expand city population to GTA San Andreas density.
- **Scope:** Procedural facial texture synthesis with 16 diverse skin tones, eye colors/shapes, eyebrow styles, nose/mouth shading, facial hair, scars, and freckles. Plus 3D hair/hat attachments (buzzcuts, afros, side-parts, beanies, caps, sunglasses).
- **Responsible Agent:** NPC Agent.
- **Acceptance Criteria:** Compare any two NPCs in town; no two share the same facial appearance or hair/headwear configuration.

### Task A.4: Solid Building Colliders (Finding AUD-07 - RESOLVED)
- **Goal:** Eliminate ghosting through buildings, houses, and parked cars.
- **Status:** **COMPLETE.** `CityCollider` spatial hash implemented; integrated into `game.ts` locomotion and bounds checking.
- **Acceptance Criteria:** Player cannot penetrate walls, fences, porches, or vehicle bodies.

### Task A.5: Interactive WebGPU Settings Button (Finding AUD-08 - RESOLVED)
- **Goal:** Make the `#settings-toggle` button interactive and fully responsive.
- **Status:** **COMPLETE.** CSS pointer-events enabled, z-index elevated, pointer lock released on modal open.
- **Acceptance Criteria:** Clicking the button reliably opens preferences on first click.

---

## 3. Priority B — Visual Identity & Environment (Active)

### Task B.1: Modular Urban Building Kit
- **Scope:** 12+ architectural building families:
  - Craftsman residential houses with porches and chimneys.
  - Multi-tiered commercial storefronts with cornices and awnings.
  - 2-story motel with exterior walkways and numbered room doors.
  - Classic 1950s roadside diner with neon signage and booths.
  - Gas station with pump island, canopy, and convenience store.
  - Industrial brick warehouse with loading docks and HVAC vents.
  - Suburban stucco bungalows with garages and driveways.
- **Responsible Agent:** Environment Art Agent.

### Task B.2: Vegetation & Foliage Overhaul
- **Scope:** 15 distinct vegetation and terrain assets:
  - Tall Alpine Douglas firs and Ponderosa pines.
  - Coastal California fan palms.
  - Broadleaf deciduous oak trees.
  - Dense mountain undergrowth, shrubs, and ferns.
  - Roadside wild grass tufts and wildflower clusters.
  - Weathered granite boulders and mountain rocks.
- **Responsible Agent:** Environment Art Agent.

### Task B.3: Road Network & Connected Intersections
- **Scope:** Two-lane asphalt highways with double yellow center lines, white shoulder markings, stop lines, pedestrian crosswalks, traffic light signal gantries, and street name signs.
- **Responsible Agent:** World Design Agent.

---

## 4. Priority C — Premium Polish (Queued)

- **Task C.1:** Audio library integration (recorded engine sounds, tire squeals, environmental wind, footsteps).
- **Task C.2:** 3D particle systems (road dust motes, tire smoke, atmospheric pollen, mountain mist).
- **Task C.3:** Vehicle dashboard instrumentation and working steering wheel rotation.
- **Task C.4:** Dynamic weather wetness shaders and puddle reflections.
