import type { PersistencePolicy, StreamingRadii } from '../core/entities';
import type { SurfaceKind } from '../physics/surfaces';
import type { ItemId, ItemStack } from './items';

/** Behaviour family; the interaction actions are derived from this. */
export const OBJECT_KINDS = ['door', 'container', 'pickup', 'switch', 'lever', 'valve', 'lamp', 'seat', 'sign'] as const;
export type ObjectKind = typeof OBJECT_KINDS[number];

/** Procedural visual family. */
export const OBJECT_MESHES = ['crate', 'chest', 'barrel', 'bottle', 'toolbox', 'gate', 'switch', 'lever', 'valve', 'lamp', 'bench', 'sign'] as const;
export type ObjectMesh = typeof OBJECT_MESHES[number];

/**
 * Per-object mutable state. Every field is JSON-serialisable: this record is
 * what the persistence slice stores, and it is the only gameplay state an
 * object owns.
 */
export interface ObjectState {
  /** Door / gate swung open. */
  open?: boolean;
  /** Lamp or powered device energised. */
  on?: boolean;
  /** Valve position 0-4 (generic machinery). */
  level?: number;
  /** Lever thrown. */
  used?: boolean;
  /** Container has been opened at least once (contents are seeded then). */
  opened?: boolean;
  /** Remaining contents of a container. */
  contents?: ItemStack[];
  /** Pickup has been taken. */
  collected?: boolean;
  /** Someone is sitting on this seat. */
  seated?: boolean;
  /** Generic "has been read/used" marker. */
  visited?: boolean;
}
export type ObjectStateMap = Record<string, ObjectState>;

export interface ObjectArchetype {
  readonly key: string;
  readonly kind: ObjectKind;
  readonly label: string;
  readonly mesh: ObjectMesh;
  /** Interaction reach in metres. */
  readonly range: number;
  /** Bounding radius used for aiming and culling. */
  readonly radius: number;
  /** Visual height in metres (also the aim-centre offset). */
  readonly height: number;
  readonly dynamic: boolean;
  readonly mass: number;
  readonly material: SurfaceKind;
  readonly persistence: PersistencePolicy;
  readonly radii: StreamingRadii;
  readonly pickup?: { readonly itemId: ItemId; readonly count: number };
  readonly container?: { readonly itemId: ItemId; readonly min: number; readonly max: number };
  readonly signText?: string;
  readonly accent?: number;
  readonly initial?: ObjectState;
}

const NEAR: StreamingRadii = { full: 220, reduced: 420, background: 700 };
const STATIC_NEAR: StreamingRadii = { full: 180, reduced: 380, background: 620 };

/**
 * Data-driven object catalogue. Authored content (Phase 7+ and future missions)
 * registers new archetypes here without touching gameplay code.
 */
export const ARCHETYPES: readonly ObjectArchetype[] = [
  { key: 'supply-crate', kind: 'container', label: 'Supply crate', mesh: 'crate', range: 3.2, radius: 0.62, height: 0.86,
    dynamic: true, mass: 24, material: 'wood', persistence: 'world', radii: NEAR,
    container: { itemId: 'spare-parts', min: 2, max: 5 }, accent: 0x9a6b3f },
  { key: 'ration-box', kind: 'container', label: 'Ration box', mesh: 'crate', range: 3, radius: 0.5, height: 0.62,
    dynamic: true, mass: 12, material: 'wood', persistence: 'world', radii: NEAR,
    container: { itemId: 'field-ration', min: 1, max: 3 }, accent: 0x7d7a52 },
  { key: 'medical-case', kind: 'container', label: 'Medical case', mesh: 'chest', range: 3, radius: 0.55, height: 0.55,
    dynamic: true, mass: 9, material: 'wood', persistence: 'world', radii: NEAR,
    container: { itemId: 'first-aid', min: 1, max: 2 }, accent: 0xb8552f },
  { key: 'fuel-drum', kind: 'container', label: 'Fuel drum', mesh: 'barrel', range: 3.2, radius: 0.55, height: 1.05,
    dynamic: true, mass: 42, material: 'metal', persistence: 'world', radii: NEAR,
    container: { itemId: 'fuel-can', min: 1, max: 2 }, accent: 0x9d5a2c },
  { key: 'tool-roll', kind: 'pickup', label: 'Tool kit', mesh: 'toolbox', range: 2.8, radius: 0.4, height: 0.34,
    dynamic: true, mass: 6, material: 'metal', persistence: 'world', radii: NEAR,
    pickup: { itemId: 'tool-kit', count: 1 }, accent: 0x6e7f86 },
  { key: 'parts-bin', kind: 'pickup', label: 'Spare parts', mesh: 'toolbox', range: 2.6, radius: 0.34, height: 0.3,
    dynamic: true, mass: 4, material: 'metal', persistence: 'world', radii: NEAR,
    pickup: { itemId: 'spare-parts', count: 2 }, accent: 0x7f8a72 },
  { key: 'water-flask', kind: 'pickup', label: 'Water flask', mesh: 'bottle', range: 2.4, radius: 0.18, height: 0.32,
    dynamic: true, mass: 1.2, material: 'metal', persistence: 'world', radii: NEAR,
    pickup: { itemId: 'water-flask', count: 1 }, accent: 0x4f7f88 },
  { key: 'lantern-cell', kind: 'pickup', label: 'Lantern cell', mesh: 'bottle', range: 2.4, radius: 0.16, height: 0.26,
    dynamic: true, mass: 0.6, material: 'metal', persistence: 'world', radii: NEAR,
    pickup: { itemId: 'lantern-cell', count: 2 }, accent: 0x8f9a4a },
  { key: 'survey-post', kind: 'pickup', label: 'Survey tag', mesh: 'sign', range: 2.6, radius: 0.35, height: 1.15,
    dynamic: false, mass: 8, material: 'wood', persistence: 'world', radii: STATIC_NEAR,
    pickup: { itemId: 'survey-tag', count: 1 }, accent: 0xc8c2a6 },
  { key: 'field-lamp', kind: 'lamp', label: 'Field lamp', mesh: 'lamp', range: 3.2, radius: 0.3, height: 2.15,
    dynamic: false, mass: 30, material: 'metal', persistence: 'world', radii: STATIC_NEAR,
    initial: { on: false }, accent: 0x3f4e52 },
  { key: 'utility-switch', kind: 'switch', label: 'Utility switch', mesh: 'switch', range: 2.6, radius: 0.25, height: 1.25,
    dynamic: false, mass: 4, material: 'metal', persistence: 'world', radii: STATIC_NEAR,
    initial: { on: false }, accent: 0x8d8f80 },
  { key: 'service-valve', kind: 'valve', label: 'Service valve', mesh: 'valve', range: 2.6, radius: 0.3, height: 0.95,
    dynamic: false, mass: 18, material: 'metal', persistence: 'world', radii: STATIC_NEAR,
    initial: { level: 0 }, accent: 0x8a5a3a },
  { key: 'signal-lever', kind: 'lever', label: 'Signal lever', mesh: 'lever', range: 2.6, radius: 0.3, height: 1.1,
    dynamic: false, mass: 10, material: 'metal', persistence: 'world', radii: STATIC_NEAR,
    initial: { used: false }, accent: 0x7a5a86 },
  { key: 'access-gate', kind: 'door', label: 'Trail gate', mesh: 'gate', range: 3.4, radius: 1.05, height: 1.95,
    dynamic: false, mass: 60, material: 'wood', persistence: 'world', radii: STATIC_NEAR,
    initial: { open: false }, accent: 0x8a6134 },
  { key: 'rest-bench', kind: 'seat', label: 'Bench', mesh: 'bench', range: 2.8, radius: 0.85, height: 0.85,
    dynamic: false, mass: 35, material: 'wood', persistence: 'world', radii: STATIC_NEAR,
    initial: { seated: false }, accent: 0x8d6238 },
  { key: 'trail-sign', kind: 'sign', label: 'Trail sign', mesh: 'sign', range: 3.4, radius: 0.42, height: 2.05,
    dynamic: false, mass: 14, material: 'wood', persistence: 'world', radii: STATIC_NEAR,
    signText: 'Trailhead · service road · no through traffic', accent: 0xcdbb8e },
];

export const ARCHETYPE_BY_KEY: ReadonlyMap<string, ObjectArchetype> = new Map(ARCHETYPES.map((archetype) => [archetype.key, archetype]));

export function archetypeOrThrow(key: string): ObjectArchetype {
  const archetype = ARCHETYPE_BY_KEY.get(key);
  if (!archetype) throw new Error(`Unknown object archetype "${key}"`);
  return archetype;
}

export function initialState(archetype: ObjectArchetype): ObjectState { return { ...archetype.initial }; }

/** Slot for authored placement (levels, landmarks) using stable coordinates. */
export interface AuthoredPlacement {
  readonly id: string;
  readonly archetype: string;
  readonly x: number;
  readonly y?: number;
  readonly z: number;
  readonly yaw?: number;
  readonly state?: ObjectState;
}
