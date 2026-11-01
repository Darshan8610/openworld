import type { MissionDef } from '../game/objectives';
import type { ActId, LandmarkRole } from './campaign';
import { landmark } from './campaign';

/**
 * Echoes of Blackwood Valley — authored campaign content.
 *
 * Pure data: the mission chain, the act mapping, waypoints and the story prop
 * anchors. The Mission Director drives this through the existing generic
 * ObjectiveRuntime (event / flag / reach objectives only), so the narrative
 * never bypasses the tested mission infrastructure.
 */

export interface StoryPoint { readonly x: number; readonly z: number; readonly radius: number; }

/** Offset helper: landmark anchor + local metres (world axes). */
function near(role: LandmarkRole, dx: number, dz: number, radius = 6): StoryPoint {
  const base = landmark(role);
  return { x: base.x + dx, z: base.z + dz, radius };
}

/**
 * Named interaction anchors. Story props, mission waypoints and cutscene
 * cameras all read these so the authored layer stays internally consistent.
 */
export const STORY_POINTS = {
  dinerForecourt: { ...landmark('diner'), radius: landmark('diner').radius } satisfies StoryPoint,
  utilityShed: near('diner', 17, 9),
  dinerRegister: near('diner', -3, 5),
  serviceParking: near('diner', 20, -7, 10),
  officeDesk: near('diner', -6, -4),
  motelForecourt: { ...landmark('motel'), radius: landmark('motel').radius } satisfies StoryPoint,
  roomFour: near('motel', 9, -5, 5),
  motelParking: near('motel', -4, 14, 10),
  forestryApproach: { ...landmark('forestry'), radius: landmark('forestry').radius + 6 } satisfies StoryPoint,
  forestryGate: near('forestry', 15, 4),
  dispatchDesk: near('forestry', -4, -3),
  radioRelay: near('forestry', 4, -4),
  terminal: near('forestry', 0, -5),
  truckKeys: near('forestry', -6, -5),
  truckParking: near('forestry', 26, 12, 10),
  towerApproach: { ...landmark('tower'), radius: landmark('tower').radius + 8 } satisfies StoryPoint,
  towerCabin: near('tower', 0, -4, 8),
  capacitorVault: near('tower', -5, -3, 5),
} as const;

export type StoryPointId = keyof typeof STORY_POINTS;

export interface StoryMission {
  readonly id: string;
  readonly act: ActId;
  readonly title: string;
  /** Objective line shown on the HUD banner. */
  readonly brief: string;
  readonly point: StoryPoint;
}

/**
 * The chain. Missions advance strictly in order: completing one starts the
 * next (the director also applies the act's weather/time preset on entry).
 */
export const STORY_MISSIONS: readonly StoryMission[] = [
  // Prologue — The Stranded Arrival (~15 min)
  { id: 'p_shelter', act: 'prologue', title: 'The Stranded Arrival', brief: 'Find shelter in the Blackwood Diner', point: STORY_POINTS.dinerForecourt },
  { id: 'p_power', act: 'prologue', title: 'The Stranded Arrival', brief: 'Restore power at the exterior utility shed', point: STORY_POINTS.utilityShed },
  { id: 'p_message', act: 'prologue', title: 'The Stranded Arrival', brief: 'Listen to the answering machine in the manager office', point: STORY_POINTS.officeDesk },
  // Act I — Across the Silent Highway (~30 min)
  { id: 'a1_keys', act: 'act1', title: 'Across the Silent Highway', brief: 'Take the service ignition keys from the diner register', point: STORY_POINTS.dinerRegister },
  { id: 'a1_drive', act: 'act1', title: 'Across the Silent Highway', brief: 'Drive the fog-blanketed highway to the Whispering Pines Motel', point: STORY_POINTS.motelForecourt },
  { id: 'a1_evelyn', act: 'act1', title: 'Across the Silent Highway', brief: 'Speak to whoever is barricaded in Room Four', point: STORY_POINTS.roomFour },
  // Act II — Shadows in the Forest (~45 min)
  { id: 'a2_trail', act: 'act2', title: 'Shadows in the Forest', brief: 'Take the logging trail to the Forestry Station', point: STORY_POINTS.forestryApproach },
  { id: 'a2_gate', act: 'act2', title: 'Shadows in the Forest', brief: 'Unlock the Forestry Station gate', point: STORY_POINTS.forestryGate },
  { id: 'a2_logs', act: 'act2', title: 'Shadows in the Forest', brief: 'Recover the three encrypted audio logs', point: STORY_POINTS.dispatchDesk },
  { id: 'a2_terminal', act: 'act2', title: 'Shadows in the Forest', brief: 'Reach the master communications terminal', point: STORY_POINTS.terminal },
  { id: 'a2_radio', act: 'act2', title: 'Shadows in the Forest', brief: 'Overhear the distress call from the Radio Tower', point: STORY_POINTS.radioRelay },
  // Act III — The Lookout Climax (~30 min)
  { id: 'a3_keys', act: 'act3', title: 'The Lookout', brief: 'Find the utility truck keys at the dispatch desk', point: STORY_POINTS.truckKeys },
  { id: 'a3_truck', act: 'act3', title: 'The Lookout', brief: 'Take the heavy utility truck', point: STORY_POINTS.truckParking },
  { id: 'a3_ascend', act: 'act3', title: 'The Lookout', brief: 'Ascend the switchback road to the Radio Lookout', point: STORY_POINTS.towerApproach },
  { id: 'a3_cabin', act: 'act3', title: 'The Lookout', brief: 'Enter the glass broadcast cabin', point: STORY_POINTS.towerCabin },
  { id: 'a3_overload', act: 'act3', title: 'The Lookout', brief: 'Overload the primary capacitor bank', point: STORY_POINTS.capacitorVault },
];

export const MISSION_CHAIN: readonly string[] = STORY_MISSIONS.map((mission) => mission.id);

export function storyMission(id: string): StoryMission | undefined {
  return STORY_MISSIONS.find((mission) => mission.id === id);
}

export function nextMissionId(id: string): string | undefined {
  const index = MISSION_CHAIN.indexOf(id);
  return index >= 0 && index + 1 < MISSION_CHAIN.length ? MISSION_CHAIN[index + 1] : undefined;
}

export function missionIndex(id: string): number { return MISSION_CHAIN.indexOf(id); }

const reach = (id: string, label: string, point: StoryPoint) =>
  ({ id, kind: 'reach' as const, label, point: { x: point.x, z: point.z, radius: point.radius } });
const flag = (id: string, label: string, name: string, value: boolean | number | string = true) =>
  ({ id, kind: 'flag' as const, label, flag: name, flagValue: value });
const interacted = (id: string, label: string, objectId: string, count = 1) =>
  ({ id, kind: 'event' as const, label, event: 'object:interacted' as const, match: { id: objectId }, count });
const boarded = (id: string, label: string, match: Record<string, string | number | boolean>) =>
  ({ id, kind: 'event' as const, label, event: 'vehicle:entered' as const, match: { actor: 'player', ...match } });

/** Generic ObjectiveRuntime definitions for the whole chain. */
export const STORY_MISSION_DEFS: readonly MissionDef[] = [
  { id: 'p_shelter', title: 'The Stranded Arrival', objectives: [reach('shelter', 'Reach the Blackwood Diner', STORY_POINTS.dinerForecourt)] },
  { id: 'p_power', title: 'The Stranded Arrival', objectives: [
    reach('shed', 'Get to the utility shed', STORY_POINTS.utilityShed),
    flag('breaker', 'Engage the breaker lever', 'breaker_diner'),
  ] },
  { id: 'p_message', title: 'The Stranded Arrival', objectives: [
    interacted('cassette', 'Play the office answering machine', 'story:cassette'),
  ] },
  { id: 'a1_keys', title: 'Across the Silent Highway', objectives: [
    interacted('keys', 'Search the diner register', 'story:register'),
  ] },
  { id: 'a1_drive', title: 'Across the Silent Highway', objectives: [
    boarded('board', 'Use a drivable vehicle', {}),
    reach('motel', 'Arrive at the Whispering Pines Motel', STORY_POINTS.motelForecourt),
  ] },
  { id: 'a1_evelyn', title: 'Across the Silent Highway', objectives: [
    flag('keycard', 'Get the Forestry Station keycard from Evelyn', 'evelyn_keycard'),
  ] },
  { id: 'a2_trail', title: 'Shadows in the Forest', objectives: [
    reach('station', 'Reach the Forestry Station', STORY_POINTS.forestryApproach),
  ] },
  { id: 'a2_gate', title: 'Shadows in the Forest', objectives: [
    reach('gate', 'Get to the station gate', STORY_POINTS.forestryGate),
    flag('unlock', 'Unlock the gate with Evelyn\u2019s keycard', 'gate_forestry'),
  ] },
  { id: 'a2_logs', title: 'Shadows in the Forest', objectives: [
    interacted('log1', 'Recover audio log 1 of 3', 'story:audio-log-1'),
    interacted('log2', 'Recover audio log 2 of 3', 'story:audio-log-2'),
    interacted('log3', 'Recover audio log 3 of 3', 'story:audio-log-3'),
  ] },
  { id: 'a2_terminal', title: 'Shadows in the Forest', objectives: [
    reach('terminal', 'Reach the master communications terminal', STORY_POINTS.terminal),
  ] },
  { id: 'a2_radio', title: 'Shadows in the Forest', objectives: [
    interacted('relay', 'Monitor the backup radio relay', 'story:radio-relay'),
  ] },
  { id: 'a3_keys', title: 'The Lookout', objectives: [
    interacted('truckkeys', 'Take the utility truck keys', 'story:truck-keys'),
  ] },
  { id: 'a3_truck', title: 'The Lookout', objectives: [
    boarded('truck', 'Board the heavy utility truck', { key: 'truck' }),
  ] },
  { id: 'a3_ascend', title: 'The Lookout', objectives: [
    reach('base', 'Reach the Radio Lookout', STORY_POINTS.towerApproach),
  ] },
  { id: 'a3_cabin', title: 'The Lookout', objectives: [
    reach('cabin', 'Enter the broadcast cabin', STORY_POINTS.towerCabin),
  ] },
  { id: 'a3_overload', title: 'The Lookout', objectives: [
    flag('overload', 'Overload the capacitor bank', 'transmitter_dead'),
  ] },
];

/** Waypoint for the active mission (first reach objective, else the brief point). */
export function waypointForMission(id: string): StoryPoint | null {
  const mission = storyMission(id);
  if (!mission) return null;
  const def = STORY_MISSION_DEFS.find((entry) => entry.id === id);
  const reachObjective = def?.objectives.find((objective) => objective.kind === 'reach');
  if (reachObjective && reachObjective.kind === 'reach' && reachObjective.point) {
    return { x: reachObjective.point.x, z: reachObjective.point.z, radius: reachObjective.point.radius };
  }
  return mission.point;
}
