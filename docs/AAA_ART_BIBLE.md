# WAYFARER — Art Bible & Visual Style Guide
**Version:** 1.0.0  
**Creative Direction:** Modernized GTA San Andreas-Inspired Stylized Realism  
**Target Atmosphere:** Golden hour California warmth, deep Pacific Northwest pines, atmospheric mountain haze  

---

## 1. Visual Pillars

### Pillar 1: Cinematic Stylized Realism
Wayfarer achieves visual richness not through flat photorealism, but through bold silhouettes, saturated atmospheric lighting, high-contrast shadows, and rich PBR material definition. It evokes the golden age of open-world Americana—nostalgic, cinematic, sun-drenched, and alive.

### Pillar 2: Distinct Regional Geographies
The world is organized into distinct, visually unmistakable districts:
1. **The Commercial Core / Storefront Boulevard:** Multi-tiered masonry buildings, storefront awnings, rooftop water towers, HVAC chillers, neon diner signs, and street furniture (hydrants, mailboxes, traffic signals).
2. **Suburban Residential District:** Tree-lined avenues with towering California fan palms, craftsman bungalows with front porches, wood columns, brick chimneys, and parked sedans in driveways.
3. **Valley Highway Corridor:** Sweeping two-lane asphalt roads with center double yellow lines, white shoulder lines, roadside drainage channels, guard rails, and STOP signs.
4. **Alpine Mountain Plateau:** Dense forests of tall Douglas firs and Ponderosa pines, granite rock outcrops, rolling mist, and distant snow-capped mountain horizons.

### Pillar 3: Environmental Storytelling & Clutter
Streets must feel lived-in. Curbs feature concrete bevels, street lamps cast warm volumetric cones at night, power lines crisscross above intersections, and roadside vegetation tufts sprout through sidewalk cracks.

---

## 2. Reference Image Analysis (D:\game\assets\)

| Reference | Motif & Atmosphere | Implementation in Wayfarer |
|---|---|---|
| **reference_1.jpg** | Red sports car on dirt/gravel road, dense pine walls, snow mountains, cumulus clouds | Third-person driving camera, sports car chassis, pine instancing |
| **reference_2.jpg & 4.jpg** | Endless pine valleys, winding highway, mountain horizon haze | Infinite terrain streaming, highway corridor, depth fog |
| **reference_3.jpg** | Overhead road into forested plateau with water tower, billboards, radio towers | Authored landmark silhouettes, water towers, blinking red beacons |
| **reference_6.jpg & 11.jpg** | Lush grassy creek, boulders, wildflowers, forest edge | Streamed rock boulders, wild grass clumps, riverbed water |
| **reference_12.jpg** | Low sun backlighting highway, dramatic tree shadows across hills | Cascaded shadow maps, 2K/4K sun bias, god rays |
| **reference_13.jpg** | Iconic Los Santos / San Andreas: Fan palms, craftsman houses, parked cars, distant towers | Boulevard palm trees, residential houses, parked 3D vehicles |
| **reference_14.jpg** | Mysterious fog rolling between steep mountain valley slopes | Story campaign atmosphere, particle mist, volumetric fog |
| **reference_16.jpg** | Golden hour coastal highway, azure water, distant cityscape | Water surface shaders, sky atmosphere Rayleigh scattering |

---

## 3. Lighting & Palette Standards

### Day Lighting (10:00 - 15:00)
- **Sun Directional Light:** Warm white (`#fff4e0`), intensity `2.2`, crisp soft shadows.
- **Ambient Sky Light:** Azure blue (`#a5c8e4`), ground bounce warm ochre (`#68553f`).
- **Atmosphere:** Clean horizon fog gradient, distant mountain silhouette separation.

### Golden Hour (17:00 - 19:30)
- **Sun Directional Light:** Deep amber gold (`#ff9e42`), intensity `2.8`, long raking shadows.
- **Sky Tone:** Peach-rose to twilight indigo gradient.
- **Post-Processing:** Subtle bloom threshold `0.85`, warm tone-mapping curve.

### Night (21:00 - 05:00)
- **Moonlight:** Cool desaturated slate (`#32465a`), intensity `0.35`.
- **Artificial Lights:** High-pressure sodium street lamps (`#ffb03a`), warm incandescent porch lights (`#ffe090`), red rooftop radio beacons (`#ff2020`).

---

## 4. PBR Material Conventions

Every surface in Wayfarer uses Three.js `MeshStandardNodeMaterial` adhering to Unreal Engine PBR conventions:
- **Base Color (Albedo):** sRGB color space, unlit color information with ambient occlusion baked into crevices.
- **Roughness:** Linear grayscale (0.0 = mirror smooth, 1.0 = matte chalk). Asphalt = `0.82`, Car Paint = `0.18`, Concrete = `0.75`, Wood = `0.65`, Metal Trim = `0.30`.
- **Metalness:** Binary or thresholded (1.0 for automotive chrome, bumpers, and steel; 0.0 for wood, concrete, paint, and skin).
- **Normal Maps:** Tangent-space normal mapping for surface relief (brick joints, bark grooves, tire treads).
