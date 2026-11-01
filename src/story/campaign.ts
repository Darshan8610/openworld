import type { WeatherKind } from '../environment/weather';

/**
 * Echoes of Blackwood Valley — campaign configuration.
 *
 * The story campaign binds the infinite engine to a one-square-kilometre zone
 * around a fixed seed (`1k5om4l-ek66rv`, verified against the real building
 * placement validators: four authored landmark sites register cleanly, the
 * cluster spans 618 x 475 m, and the lookout sits ~60 m above the valley
 * floor). Nothing in the engine is removed: `?story=0` restores the endless
 * sandbox, and streaming, biomes, seeds and the floating origin keep working
 * underneath — the campaign only confines the player and layers content.
 */

export interface StoryBounds {
  readonly minX: number; readonly maxX: number;
  readonly minZ: number; readonly maxZ: number;
}

export type LandmarkRole = 'diner' | 'motel' | 'forestry' | 'tower';

export interface LandmarkDef {
  readonly id: string;
  readonly name: string;
  readonly role: LandmarkRole;
  /** Authored building id (BuildingManager.registerAuthored → `authored:<id>`). */
  readonly buildingId: string;
  readonly template: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** Interaction/trigger radius around the anchor, metres. */
  readonly radius: number;
}

export type ActId = 'prologue' | 'act1' | 'act2' | 'act3' | 'finale';

export interface ActDef {
  readonly id: ActId;
  readonly label: string;
  readonly weather: WeatherKind;
  /** Sky hour applied when the act begins (null keeps the current clock). */
  readonly hour: number | null;
}

export const CAMPAIGN = {
  id: 'blackwood',
  title: 'Echoes of Blackwood Valley',
  /** The one seed the story is authored against. URL seeds still override. */
  seed: '1k5om4l-ek66rv',
  /** 19:30 — twilight; the acts walk the clock into midnight and back to dawn. */
  initialHour: 19.5,
  /** One-square-kilometre zone: exactly 1000 x 1000 m around the landmarks. */
  bounds: { minX: -632.5, maxX: 367.5, minZ: -767.5, maxZ: 232.5 } satisfies StoryBounds,
  /** Where the stranded arrival places Jack after the opening cinematic. */
  arrival: { x: -415, z: -68 },
  landmarks: [
    {
      id: 'diner', name: 'Blackwood Diner & Gas', role: 'diner',
      buildingId: 'blackwood-diner', template: 'workshop',
      x: -441.30384339642796, z: -55.65113418110711, yaw: 0, radius: 14,
    },
    {
      id: 'motel', name: 'Whispering Pines Motel', role: 'motel',
      buildingId: 'whispering-pines', template: 'lodge',
      x: -211.4256154497543, z: -220.17955079748296, yaw: 0, radius: 16,
    },
    {
      id: 'forestry', name: 'Abandoned Forestry Station', role: 'forestry',
      buildingId: 'forestry-station', template: 'cabin',
      x: 9.61108910658475, z: -30.024929148897485, yaw: 0, radius: 16,
    },
    {
      id: 'tower', name: 'Coastal Radio Lookout', role: 'tower',
      buildingId: 'radio-lookout', template: 'cabin',
      x: 176.32473270423412, z: -504.74385325050787, yaw: 0, radius: 16,
    },
  ] as readonly LandmarkDef[],
  acts: [
    // Weather presets per act. The front system accepts ONE override kind at a
    // time (fog and rain cannot combine), so continuous valley drizzle is
    // expressed through the storm/fog presets rather than a second channel.
    { id: 'prologue', label: 'Prologue — The Stranded Arrival', weather: 'fog', hour: 19.5 },
    { id: 'act1', label: 'Act I — Across the Silent Highway', weather: 'fog', hour: null },
    { id: 'act2', label: 'Act II — Shadows in the Forest', weather: 'storm', hour: 23.4 },
    { id: 'act3', label: 'Act III — The Lookout', weather: 'storm', hour: 2.2 },
    { id: 'finale', label: 'Dawn', weather: 'clear', hour: 5.6 },
  ] as readonly ActDef[],
} as const;

/** Convenience list for world wiring (building registration, props). */
export const LANDMARKS = CAMPAIGN.landmarks;

export type CampaignConfig = typeof CAMPAIGN;

export function landmark(role: LandmarkRole): LandmarkDef {
  const found = CAMPAIGN.landmarks.find((entry) => entry.role === role);
  if (!found) throw new Error(`Missing landmark: ${role}`);
  return found;
}

export function act(id: ActId): ActDef {
  const found = CAMPAIGN.acts.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing act: ${id}`);
  return found;
}

export function boundsCenter(bounds: StoryBounds = CAMPAIGN.bounds): { x: number; z: number } {
  return { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
}

export function withinBounds(x: number, z: number, bounds: StoryBounds = CAMPAIGN.bounds, margin = 0): boolean {
  return x >= bounds.minX - margin && x <= bounds.maxX + margin &&
    z >= bounds.minZ - margin && z <= bounds.maxZ + margin;
}

/** Clamp a canonical world position into the campaign zone (axis-aligned). */
export function clampToBounds<T extends { x: number; z: number }>(point: T, bounds: StoryBounds = CAMPAIGN.bounds): T {
  point.x = Math.min(bounds.maxX, Math.max(bounds.minX, point.x));
  point.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, point.z));
  return point;
}

/** Invariant used by the campaign gate test: the zone is exactly 1 km square. */
export function boundsSize(bounds: StoryBounds = CAMPAIGN.bounds): { width: number; depth: number } {
  return { width: bounds.maxX - bounds.minX, depth: bounds.maxZ - bounds.minZ };
}
