# Third-party notices

## Three.js

- Package: `three` (MIT)
- Includes `SkyMesh` from Three.js examples (MIT/BSD-style attribution in the Three.js repository).
- https://github.com/mrdoob/three.js

## Rapier 3D

- Package: `@dimforge/rapier3d-compat` (Apache-2.0)
- Rust physics engine compiled to WebAssembly; the compatibility build inlines the
  WASM as base64 so no extra asset request is required.
- https://github.com/dimforge/rapier

## Fonts

- DM Sans Variable — SIL Open Font License 1.1, via `@fontsource-variable/dm-sans`.
- Manrope Variable — SIL Open Font License 1.1, via `@fontsource-variable/manrope`.
- Font files are self-hosted from `node_modules` at build time; no Google Fonts requests are made at runtime.

## Tooling

- Vite (MIT), TypeScript (Apache-2.0), Vitest (MIT), Playwright (Apache-2.0), Rapier 3D (Apache-2.0).

## Procedural content

Terrain, sky parameters, stars, moon shading, biome climate fields, terrain albedo, seamless surface textures, vegetation geometry/placement, modular buildings, furniture, architectural materials, and UI geometry are generated in code. No paid or externally downloaded art assets are used.
