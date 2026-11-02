# WAYFARER — Implementation Roadmap: Vertical Slice 001 to Release
**Target:** Vertical Slice 001 — The First Playable District  

---

## Roadmap Phases

### Phase 0: Technical Direction & Governance (COMPLETED)
- Full repository audit (`docs/AAA_AUDIT.md`).
- Technical Decision Record for Three.js WebGPU / Unreal Engine 5 (`docs/AAA_TECHNICAL_DECISION.md`).
- Master backlog and agent matrix (`docs/AAA_IMPROVEMENT_BACKLOG.md`).
- 575 automated unit tests verified green.

### Phase 1: Presentation & Core Deficiencies (CURRENT)
- **Deficiency 1 (Vehicle Visuals):** Create 8 visible vehicle models (Sedan, SUV, Pickup, Sports, Super, Muscle, Moto, Police) with chassis, cabin, spinning wheels, steering, and headlights.
- **Deficiency 2 (Unique NPC Faces):** Implement procedural CanvasTexture face generator (16 skin tones, eyes, eyebrows, beards, accessories) so no two NPCs share a face.
- **Deficiency 3 (Solid Collisions):** Plug `CityCollider` into player locomotion, third-person camera, and vehicles to prevent ghosting through walls.
- **Deficiency 4 (WebGPU Settings Button):** Fix `#settings-toggle` button clickability and pointer-lock release.
- **Deficiency 5 (NPC Urban Density):** Expand townfolk population from 16 to 48+ residents across streets and shops.

### Phase 2: Environmental Quality & Art Upgrade
- 15 high-fidelity vegetation species (Pines, Palms, Oaks, Bushes, Rocks) matching the 16 reference images.
- Connected road graph with 8 intersections, traffic signals, and double yellow lines.
- 12 modular building families with 3 enterable functional interiors (Diner, Motel, Shop).

### Phase 3: Commercial Polish & Hardware Profiling
- Real recorded vehicle audio loops and environmental soundscapes.
- 3D particle systems (road dust motes, tire smoke, atmospheric mist).
- 60 FPS performance verification on mid-range PC target.
