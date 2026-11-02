# WAYFARER — Asset Standards & Technical Specifications
**Version:** 1.0.0  

---

## 1. Units, Transforms & Coordinate Space
- **Scale:** 1 unit = 1.0 meter (conforms directly to Rapier 3D and Unreal Engine 100 uu = 1m).
- **Coordinate System:** Right-handed Cartesian:
  - `+X` = East / Right
  - `+Y` = Up / Elevation
  - `+Z` = South / Forward-Facing Cam
- **Origin Rebasing:** All visual models must tolerate floating origin rebasing via `FloatingOrigin.toLocal()`.

---

## 2. Vehicle Model Specifications
Every vehicle model must supply:
1. **Chassis Mesh:** Main body shell with painted exterior, undercarriage, front grille, and rear bumper.
2. **Cabin & Glass:** Transparent tinted glass mesh (`roughness: 0.1`, `metalness: 0.1`, `transparent: true`, `opacity: 0.45`).
3. **Interior:** Dashboard, steering wheel, front bucket seats, rearview mirror.
4. **4 Independent Wheels:**
   - Front Left / Front Right (steerable + rotatable).
   - Rear Left / Rear Right (rotatable).
   - Each wheel has tire rubber (`roughness: 0.85`, `metalness: 0.05`) and rim alloy/chrome (`roughness: 0.25`, `metalness: 0.9`).
5. **Lighting Points:** Left/Right Headlights (`#fffce0`), Left/Right Taillights (`#ff1e1e`), Reverse lights (`#ffffff`).
6. **Collision Proxy:** Rapier compound convex/box hull matching the physical bounds.

---

## 3. Character & NPC Model Specifications
- **Skeleton:** 19-joint standard humanoid hierarchy rooted at `hips`.
- **Face Resolution:** Procedural 512x512 CanvasTexture with deterministic facial feature rasterization (skin tone, eyes, eyebrows, nose, mouth, facial hair, stubble, accessories).
- **Hair & Accessories:** Modular 3D meshes attached to `head` bone with zero clipping into facial topology.
- **Animation Compatibility:** All clips must provide keyframes or neutral defaults for all 19 joints.

---

## 4. Architectural Building Specifications
- **Footprint Snap:** Built on integer 4m/8m modular city grid coordinates.
- **Colliders:** Every building must register an AABB or compound box in `CityCollider` with minimum 2.8m height clearance.
- **Entrances:** Doors and porches must have unobstructed entry thresholds at least 1.2m wide.
