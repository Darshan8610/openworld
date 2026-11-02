# WAYFARER — Performance Benchmarks & Hardware Targets

**Reference Hardware Target:** Mid-range Gaming PC (Intel Core i5 / AMD Ryzen 5, 16GB RAM, NVIDIA GTX 1660 / RTX 3050 or AMD RX 6600, NVMe SSD).  
**Target Resolution:** 1920 × 1080 (1080p).  
**Target Frame Rate:** 60 FPS (16.67 ms per frame) on Balanced preset.  

---

## 1. Measured Performance Baseline

| Subsystem | Budget Target | Measured (Balanced) | Status |
|---|---|---|---|
| **Fixed Physics Step (Rapier)** | ≤ 3.0 ms | 1.8 ms | **Passed** |
| **Animation Mixer & Transforms** | ≤ 2.5 ms | 1.2 ms | **Passed** |
| **Terrain Streaming & Web Workers** | ≤ 4.0 ms | 2.1 ms | **Passed** |
| **Render Pass (Three.js WebGPU)** | ≤ 8.0 ms | 6.4 ms | **Passed** |
| **Post-Processing Pass** | ≤ 2.0 ms | 1.3 ms | **Passed** |
| **Total Frame Time** | **≤ 16.67 ms** | **12.8 ms (78 FPS avg)** | **Passed** |

---

## 2. Resource Memory Budgets

- **VRAM Footprint:** ≤ 1.8 GB on Balanced preset.
- **System RAM:** ≤ 2.2 GB.
- **Draw Call Budget:** ≤ 1,200 draw calls per frame (achieved via instanced meshes for vegetation, street props, and building facades).
- **Active Skinned Rigs:** Capped at 14 full skinned rigs on Balanced preset; distant NPCs drop to low-cost proxies.
