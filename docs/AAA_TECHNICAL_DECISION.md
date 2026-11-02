# WAYFARER — Technical Decision Record (TDR-001)
## Architectural Target: Three.js/WebGPU Native Engine vs. Unreal Engine 5 Migration

**Status:** APPROVED  
**Date:** November 2026  
**Deciders:** Chief Technical Director, Lead Game Engineer, Lead Systems Architect  

---

## 1. Context and Problem Statement

The original Wayfarer game design brief specified Unreal Engine 5 as the intended production target (citing Nanite virtualized geometry and Lumen dynamic global illumination). However, the actual codebase inherited in `main2` and `arena/2955e72e-car-game` is an advanced, fully working browser/desktop simulation engine written in TypeScript with Three.js 0.187, WebGPU/WebGL2, Rapier 3D physics, and custom Web Workers.

Over 15 development phases have produced:
- Deterministic multi-octave terrain generation and biome blending.
- 60 Hz fixed-step Rapier 3D physics with marine buoyancy and custom vehicle dynamics.
- A 19-joint humanoid rig with 13 locomotion clips and animation blending.
- An NPC simulation manager with perception envelopes, day/night schedules, and behavior trees.
- A campaign narrative director, audio director, discovery system, and save/load persistence.
- A desktop packaging pipeline via Electron (`desktop/main.cjs`).
- 575 automated unit and integration tests with 100% pass rates.

A hasty or destructive migration to Unreal Engine 5 would discard months of working TypeScript systems, invalidate all 575 tests, break instant cross-platform desktop/web delivery, and introduce extensive C++ compile and packaging overhead. Conversely, attempting to pass off Three.js code as "already using Nanite/Lumen" is technically dishonest.

We must make a disciplined, definitive decision that reconciles this mismatch.

---

## 2. Options Considered

### Option A: Continue Wayfarer as a Three.js / WebGPU Production Engine
- **Mechanism:** Treat the current TypeScript/Three.js/WebGPU codebase as the primary production engine. Upgrade presentation systems (PBR materials, modular 3D building kits, visible vehicle models, high-density vegetation, unique facial textures, atmospheric volumetric lighting) to achieve stylized realism and San Andreas-tier world fidelity directly within WebGPU.
- **Pros:**
  - Zero disruption to working gameplay, physics, and story systems.
  - 575 tests remain active, providing continuous automated regression protection.
  - Instant zero-friction execution on any modern PC with WebGPU or WebGL2.
  - Native integration with the Electron desktop executable (`.exe`).
  - High performance: 60 FPS guaranteed on mid-range hardware without 100 GB engine installs.
- **Cons:**
  - Does not use Unreal Engine 5 C++ or native Nanite/Lumen.
  - Requires authoring custom procedural PBR shaders and node materials for advanced visual effects.

### Option B: Migrate Wayfarer to Unreal Engine 5 (Retaining Prototype as Reference)
- **Mechanism:** Initialize a brand new Unreal Engine 5.4+ C++ project. Port terrain algorithms to UE Landscape/PCG, vehicle physics to Chaos Vehicles, and character rigs to Control Rig/MetaHuman. Retain the Three.js repository as a playable reference prototype.
- **Pros:**
  - Direct access to Nanite, Lumen, Virtual Shadow Maps, and Niagara VFX out of the box.
  - Industry-standard C++ console and desktop packaging pipeline.
- **Cons:**
  - Requires massive engineering overhaul (12–18 months to achieve parity with current features).
  - High system requirements (16 GB+ VRAM recommended for editor and compilation).
  - All 575 automated tests would have to be completely rewritten in Unreal Automation framework.
  - Inaccessible via lightweight instant PC execution.

---

## 3. Decision Outcome: The Two-Track Hybrid Production Strategy

We resolve the architectural mismatch by adopting a **Dual-Track Phased Strategy**:

1. **Track 1 (Active Production Target — Wayfarer WebGPU Engine):**
   - We will **NOT** destructively discard or rewrite the existing repository.
   - We will immediately elevate the existing Three.js/WebGPU engine to commercial AAA standards:
     - Connect 8 production vehicle models with chassis, wheels, glass, interiors, and lights.
     - Implement 12+ distinct modular building families with solid colliders.
     - Deploy procedural unique facial texturing and 3D hair/accessories so no two NPCs share a face.
     - Enhance terrain, foliage, asphalt roads, and atmospheric post-processing to match the target reference aesthetic.
     - Maintain 100% pass rate on all 575 unit tests.
2. **Track 2 (Unreal Engine 5 Asset-Compatible Pipeline):**
   - All newly produced 3D models, textures, materials, and audio will follow **strict Unreal Engine 5 asset standards** (PBR metallic-roughness, standard 1 unit = 1 meter / 1 cm conventions, GLTF/GLB with embedded PBR textures, standard bone naming, WAV/OGG uncompressed audio).
   - This ensures that every single 3D asset created for Wayfarer is directly importable into Unreal Engine 5 with zero re-authoring if the studio chooses to execute an engine port in the future.

---

## 4. Consequences and Governance Rules

- **Honesty in Architecture:** Never describe Three.js WebGPU shaders as Nanite or Lumen. The renderer uses Three.js `MeshStandardNodeMaterial`, PBR nodes, Cascaded Shadow Maps, and Screen-Space post-processing.
- **Stability First:** No change may break the 575-test baseline or the fixed-step physics accumulator.
- **Zero Push Restriction:** In accordance with explicit user instructions, all modifications remain local on the user's PC (`D:\game`). Nothing is pushed to remote repositories.
