# WAYFARER — Master Production Changelog

## [1.0.0-aaa.1] - November 2026

### Added
- **Production Documentation:** Added `docs/AAA_AUDIT.md`, `docs/AAA_TECHNICAL_DECISION.md`, `docs/AAA_IMPROVEMENT_BACKLOG.md`, `docs/AAA_ART_BIBLE.md`, `docs/AAA_ASSET_REGISTRY.md`, `docs/AAA_ASSET_STANDARDS.md`, `docs/AAA_AGENT_RESPONSIBILITIES.md`, `docs/AAA_IMPLEMENTATION_ROADMAP.md`, `docs/AAA_PERFORMANCE_BENCHMARKS.md`, and `docs/AAA_QA_REPORT.md`.
- **Asset Manifest:** Created `assets/manifest.json` cataloging all vehicle, character, architecture, vegetation, and audio assets.
- **Reference Image Library:** Copied 16 high-GFX open-world target images into `assets/` (`target_gfx_ref_1.jpg` through `16.jpg`).
- **Solid Building Colliders:** Added `CityCollider` spatial hash indexing in `StoryCity` with `blockedAt(x, z, feetY)` wired into `CharacterSystem`, `Game`, and `enforceStoryBounds`.
- **Unique NPC Faces & Hair:** Implemented deterministic procedural facial feature synthesis with 16 skin tones, varied eyes, eyebrows, beards, mustaches, and 3D hair/hat attachments in `NpcVisual`.
- **Vehicle 3D Meshes:** Integrated production vehicle visual meshes (chassis, cabin, spinning wheels, steering, headlights) bound directly to Rapier physics bodies.

### Fixed
- **Head Spin Bug:** Generated explicit tracks for `head`/`neck` in `animation-clips.ts` and replaced additive Euler math in `animation-controller.ts`, eliminating the 60+ rad/sec spinning head defect.
- **WebGPU Settings Toggle:** Fixed `#settings-toggle` button clickability by setting proper z-indexing, pointer-events on `.top-actions`, and releasing pointer lock on modal open in `interface.ts` and `style.css`.
- **Ghosting Through Buildings:** Eliminated player and vehicle clipping into city buildings, craftsman houses, and storefronts.
