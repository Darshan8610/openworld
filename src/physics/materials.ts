/**
 * Physical material table — the single source of truth for how surfaces behave.
 *
 * Every system that needs "what is under me" (character footsteps, tyre grip,
 * object sliding, splashes) asks the world query layer for a `SurfaceKind` and
 * reads its properties here, so handling cannot silently diverge between
 * features. Values are gameplay-tuned but anchored to plausible real-world
 * ranges; friction is a Coulomb coefficient, density is kg/m³.
 */
export const SURFACE_KINDS = [
  'asphalt', 'concrete', 'gravel', 'sand', 'soil', 'grass',
  'snow', 'ice', 'rock', 'wood', 'metal', 'glass', 'rubber', 'water', 'fabric',
] as const;
export type SurfaceKind = typeof SURFACE_KINDS[number];

export interface PhysicalMaterial {
  readonly kind: SurfaceKind;
  /** Coulomb friction coefficient against an identical surface. */
  readonly friction: number;
  /** Coefficient of restitution for a fully elastic-looking bounce. */
  readonly restitution: number;
  /** Bulk density in kg/m³ (used to derive mass from volume). */
  readonly density: number;
  /** Air/rolling damping applied per second when moving. */
  readonly linearDamping: number;
  /** Player/vehicle can stand on it without sliding away. */
  readonly walkable: boolean;
}

export const PHYSICAL_MATERIALS: Record<SurfaceKind, PhysicalMaterial> = {
  asphalt: { kind: 'asphalt', friction: 0.86, restitution: 0.06, density: 2300, linearDamping: 0.05, walkable: true },
  concrete: { kind: 'concrete', friction: 0.82, restitution: 0.08, density: 2400, linearDamping: 0.06, walkable: true },
  gravel: { kind: 'gravel', friction: 0.66, restitution: 0.05, density: 1600, linearDamping: 0.2, walkable: true },
  sand: { kind: 'sand', friction: 0.5, restitution: 0.02, density: 1500, linearDamping: 0.34, walkable: true },
  soil: { kind: 'soil', friction: 0.68, restitution: 0.03, density: 1400, linearDamping: 0.18, walkable: true },
  grass: { kind: 'grass', friction: 0.72, restitution: 0.04, density: 1200, linearDamping: 0.14, walkable: true },
  snow: { kind: 'snow', friction: 0.26, restitution: 0.01, density: 400, linearDamping: 0.24, walkable: true },
  ice: { kind: 'ice', friction: 0.05, restitution: 0.03, density: 900, linearDamping: 0.02, walkable: true },
  rock: { kind: 'rock', friction: 0.8, restitution: 0.12, density: 2600, linearDamping: 0.1, walkable: true },
  wood: { kind: 'wood', friction: 0.58, restitution: 0.16, density: 650, linearDamping: 0.08, walkable: true },
  metal: { kind: 'metal', friction: 0.4, restitution: 0.24, density: 7800, linearDamping: 0.05, walkable: true },
  glass: { kind: 'glass', friction: 0.35, restitution: 0.1, density: 2500, linearDamping: 0.04, walkable: false },
  rubber: { kind: 'rubber', friction: 0.95, restitution: 0.62, density: 1100, linearDamping: 0.1, walkable: true },
  water: { kind: 'water', friction: 0.02, restitution: 0, density: 1000, linearDamping: 1.6, walkable: false },
  fabric: { kind: 'fabric', friction: 0.7, restitution: 0.02, density: 300, linearDamping: 0.3, walkable: false },
};

export const physicalMaterial = (kind: SurfaceKind): PhysicalMaterial => PHYSICAL_MATERIALS[kind];

/** Standard Coulomb combination for two touching surfaces. */
export const combineFriction = (a: PhysicalMaterial, b: PhysicalMaterial): number => Math.sqrt(a.friction * b.friction);
/** Restitution combination: the softer surface decides most of the bounce. */
export const combineRestitution = (a: PhysicalMaterial, b: PhysicalMaterial): number => Math.max(a.restitution * 0.5, b.restitution);

/** Speed-dependent grip: loose surfaces lose grip faster than sealed ones. */
export function gripFor(kind: SurfaceKind, speed: number): number {
  const base = PHYSICAL_MATERIALS[kind].friction;
  const loss = kind === 'snow' || kind === 'ice' || kind === 'gravel' || kind === 'sand' ? 0.25 : 0.1;
  return base * (1 - loss * Math.min(1, speed / 45));
}
