import { BUILDING_TEMPLATES } from './templates';
import type { BuildingDescriptor, BuildingPart } from './types';

/** The visible foundation and its collision are derived from the SAME pieces. */
export function createBuildingSiteParts(building: BuildingDescriptor): BuildingPart[] {
  const template = BUILDING_TEMPLATES.get(building.template);
  const bottom = building.foundationBottom - building.position.y;
  const height = Math.max(0.25, -bottom - 0.24);
  const parts: BuildingPart[] = [
    { id: 'foundation', center: { x: 0, y: bottom + height / 2, z: 0 }, size: { x: template.width + 0.16, y: height, z: template.depth + 0.16 }, material: 'stone', stage: 'shell', solid: true },
    { id: 'porch-foundation', center: { x: 0, y: bottom + height / 2, z: template.depth / 2 + 1.6 }, size: { x: 3.6, y: height, z: 3.2 }, material: 'stone', stage: 'shell', solid: true },
  ];
  const steps = Math.min(24, Math.max(1, Math.ceil((-bottom - 0.35) / 0.18)));
  for (let i = 0; i < steps; i++) {
    const top = -i * 0.18;
    parts.push({ id: `entry-step-${i}`, center: { x: 0, y: (top + bottom) / 2, z: template.depth / 2 + 3.35 + i * 0.3 }, size: { x: 2.6, y: Math.max(0.1, top - bottom), z: 0.31 }, material: 'stone', stage: 'shell', solid: true, walkable: true });
  }
  return parts;
}
