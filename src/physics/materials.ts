import type { SurfaceKind } from '../world/world-query';

/**
 * Reusable physical materials. One table feeds collision response (friction,
 * restitution, density), later-phase tyre grip, buoyancy density comparisons and
 * the surface id used by footsteps/impact effects. Values are plausible
 * real-world approximations, not measured tables.
 */
export type PhysicsMaterialId =
  | 'asphalt' | 'gravel' | 'grass' | 'soil' | 'rock' | 'snow' | 'ice'
  | 'wood' | 'metal' | 'concrete' | 'glass' | 'rubber' | 'fabric' | 'water';

export interface PhysicalMaterial {
  readonly id: PhysicsMaterialId;
  /** kg/m³ — used for mass and for buoyancy comparisons in Phase 9. */
  readonly density: number;
  /** Coulomb friction coefficient against a reference surface. */
  readonly friction: number;
  readonly restitution: number;
  /** Tyre grip relative to dry asphalt (1.0); consumed by Phase 10 vehicles. */
  readonly tireGrip: number;
  /** Surface id for footsteps, impacts and audio events in later phases. */
  readonly impact: string;
  readonly liquid: boolean;
}

export const PHYSICS_MATERIALS: Record<PhysicsMaterialId, PhysicalMaterial> = {
  asphalt: { id: 'asphalt', density: 2400, friction: 0.92, restitution: 0.02, tireGrip: 1, impact: 'asphalt', liquid: false },
  gravel: { id: 'gravel', density: 1800, friction: 0.74, restitution: 0.05, tireGrip: 0.78, impact: 'gravel', liquid: false },
  grass: { id: 'grass', density: 1200, friction: 0.86, restitution: 0.02, tireGrip: 0.66, impact: 'grass', liquid: false },
  soil: { id: 'soil', density: 1400, friction: 0.7, restitution: 0.03, tireGrip: 0.62, impact: 'soil', liquid: false },
  rock: { id: 'rock', density: 2600, friction: 0.8, restitution: 0.06, tireGrip: 0.7, impact: 'rock', liquid: false },
  snow: { id: 'snow', density: 400, friction: 0.34, restitution: 0.01, tireGrip: 0.4, impact: 'snow', liquid: false },
  ice: { id: 'ice', density: 917, friction: 0.06, restitution: 0.01, tireGrip: 0.08, impact: 'ice', liquid: false },
  wood: { id: 'wood', density: 700, friction: 0.55, restitution: 0.15, tireGrip: 0.6, impact: 'wood', liquid: false },
  metal: { id: 'metal', density: 7800, friction: 0.42, restitution: 0.2, tireGrip: 0.55, impact: 'metal', liquid: false },
  concrete: { id: 'concrete', density: 2300, friction: 0.85, restitution: 0.05, tireGrip: 0.95, impact: 'concrete', liquid: false },
  glass: { id: 'glass', density: 2500, friction: 0.35, restitution: 0.1, tireGrip: 0.4, impact: 'glass', liquid: false },
  rubber: { id: 'rubber', density: 1100, friction: 0.95, restitution: 0.55, tireGrip: 1, impact: 'rubber', liquid: false },
  fabric: { id: 'fabric', density: 300, friction: 0.6, restitution: 0.02, tireGrip: 0.5, impact: 'fabric', liquid: false },
  water: { id: 'water', density: 1000, friction: 0.05, restitution: 0, tireGrip: 0.2, impact: 'water', liquid: true },
};

const SURFACE_MATERIAL: Record<SurfaceKind, PhysicsMaterialId> = {
  asphalt: 'asphalt',
  gravel: 'gravel',
  grass: 'grass',
  soil: 'soil',
  rock: 'rock',
  snow: 'snow',
  ice: 'ice',
  water: 'water',
};

export function materialForSurface(surface: SurfaceKind): PhysicalMaterial {
  return PHYSICS_MATERIALS[SURFACE_MATERIAL[surface]];
}

export function physicalMaterial(id: PhysicsMaterialId): PhysicalMaterial {
  return PHYSICS_MATERIALS[id];
}

/**
 * Terrain covers every surface class at once, so its streamed ground colliders
 * use a single representative coefficient; per-surface grip, footsteps and tyre
 * response come from `WorldQuery.surfaceAt()` at the point of contact.
 */
export const TERRAIN_COLLIDER_MATERIAL: PhysicsMaterialId = 'soil';
