/** Phase 7 contracts: data uses canonical, double-precision world metres. */
export interface Point3 { x: number; y: number; z: number }
export interface Bounds3 { min: Point3; max: Point3 }
export const BUILDING_MATERIALS = ['stone', 'plaster', 'timber', 'floor', 'roof', 'metal', 'glass', 'window', 'linen', 'ceramic', 'light'] as const;
export type BuildingMaterial = typeof BUILDING_MATERIALS[number];
export interface BuildingPart {
  id: string;
  center: Point3;
  size: Point3;
  material: BuildingMaterial;
  stage: 'shell' | 'interior';
  shape?: 'box' | 'gable' | 'cylinder';
  rotation?: Point3;
  solid?: boolean;
  /** Only explicit floors, thresholds, steps and landings can ground an actor. */
  walkable?: boolean;
}
export interface BuildingRoom extends Bounds3 {
  id: string;
  name: string;
  floor: number;
  acoustic: 'wood-room' | 'large-room' | 'workshop';
  light: Point3;
}
export interface BuildingDoor {
  id: string;
  name: string;
  /** Hinge, not leaf centre. Closed leaf extends along local +X. */
  hinge: Point3;
  width: number;
  height: number;
  thickness: number;
  yaw: number;
  openAngle: number;
  rooms: readonly [string | null, string];
}
export interface BuildingNavNode { id: string; position: Point3; room: string | null }
export interface BuildingNavEdge { from: string; to: string; door?: string; kind: 'walk' | 'stairs' | 'entrance' }
export interface BuildingTemplate {
  id: string;
  name: string;
  width: number;
  depth: number;
  height: number;
  parts: readonly BuildingPart[];
  rooms: readonly BuildingRoom[];
  doors: readonly BuildingDoor[];
  nodes: readonly BuildingNavNode[];
  edges: readonly BuildingNavEdge[];
  entrance: Point3;
}
export interface BuildingDescriptor {
  id: string;
  template: string;
  source: 'generated' | 'authored';
  position: Point3;
  yaw: number;
  /** Canonical foundation bottom, sampled at placement time, never camera-relative. */
  foundationBottom: number;
  seed: string;
}
export interface BuildingCollider {
  id: string;
  buildingId: string;
  center: Point3;
  half: Point3;
  yaw: number;
  material: BuildingMaterial;
  kind: 'static' | 'kinematic';
  walkable: boolean;
}
export interface BuildingGraph {
  buildingId: string;
  nodes: readonly BuildingNavNode[];
  edges: readonly (BuildingNavEdge & { blocked: boolean })[];
}
export interface BuildingInteraction {
  id: string;
  buildingId: string;
  position: Point3;
  range: number;
  label: () => string;
  /** Returns false for invalid range, occlusion, cooldown or unloaded collision. */
  interact: (actor: Point3) => boolean;
}
export type BuildingEvent =
  | { type: 'BuildingStreamedIn' | 'BuildingStreamedOut' | 'InteriorLoaded' | 'InteriorUnloaded'; buildingId: string }
  | { type: 'PlayerEnteredBuilding' | 'PlayerExitedBuilding'; buildingId: string; roomId: string }
  | { type: 'BuildingRoomChanged'; buildingId: string; roomId: string; acoustic: BuildingRoom['acoustic'] }
  | { type: 'BuildingDoorChanged'; buildingId: string; doorId: string; open: boolean }
  | { type: 'BuildingDoorBlocked'; buildingId: string; doorId: string }
  | { type: 'BuildingStorageWarning'; message: string };
/** Optional host-system ports. They are deliberately not a second physics/ECS engine. */
export interface BuildingPorts {
  physics?: {
    /** Host converts canonical coordinates to physics-local space, exactly once. */
    upsertCollider: (collider: BuildingCollider) => void;
    removeCollider: (id: string) => void;
    /** Optional host shape-overlap guard for all human/NPC/prop occupants. */
    canMoveKinematic?: (next: BuildingCollider) => boolean;
  };
  interactions?: { register: (interaction: BuildingInteraction) => () => void };
  navigation?: { setBuildingGraph: (graph: BuildingGraph) => void; removeBuildingGraph: (id: string) => void };
  events?: (event: BuildingEvent) => void;
}
export interface RoomLocation { building: BuildingDescriptor; room: BuildingRoom }
export interface DoorSnapshot { id: string; open: boolean; angle: number; position: Point3 }
export interface BuildingSnapshot {
  id: string; template: string; name: string; position: Point3; yaw: number;
  entrance: Point3; interiorLoaded: boolean; doors: DoorSnapshot[];
}
