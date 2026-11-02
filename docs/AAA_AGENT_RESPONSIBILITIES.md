# WAYFARER — Agent Responsibilities & Organization Matrix

---

## Leadership Roles

1. **Master Orchestrator:**
   - Coordinates multi-agent milestones, dependencies, and integration order.
   - Enforces the "zero destructive rewrites" and "zero git push" rules.
2. **Technical Director:**
   - Decides runtime architecture (Three.js WebGPU vs UE5 dual-track).
   - Reviews physics, memory budgets, and loop synchronization.
3. **Art Director:**
   - Establishes the Art Bible, color grading curves, and visual benchmarks.
   - Evaluates screenshot fidelity against the 16 reference images.

## Production Specialists

4. **Vehicle Asset Agent:**
   - Implements 3D vehicle visual meshes and binds them to the Pacejka Rapier simulation.
   - Owns `src/rendering/vehicles/`.
5. **Character Asset Agent:**
   - Upgrades player model and modular clothing.
   - Owns `src/character/humanoid-model.ts` and `src/character/character-visual.ts`.
6. **NPC Agent:**
   - Develops the deterministic unique-face generator and modular hair/headwear.
   - Expands urban street population and traffic avoidance.
   - Owns `src/npc/`.
7. **Environment Art Agent:**
   - Constructs modular building families, enterable interiors, and street clutter.
   - Owns `src/story/city.ts` and `src/world/buildings/`.
8. **Rendering Agent:**
   - Tunes PBR materials, Cascaded Shadow Maps, post-processing, and bloom.
   - Owns `src/rendering/`.
9. **QA Agent:**
   - Runs Vitest suites, verifies 575+ tests, and performs visual validation.
   - Owns `tests/` and regression reporting.
