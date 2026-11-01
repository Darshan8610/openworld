import { CONFIG } from '../config';
import type { StreamingRadii } from '../core/entities';
import type { NpcDefinition, NpcRole } from './types';

/**
 * Role catalogue.
 *
 * Roles are generic population behaviours (walking the verge, working the
 * roadside, watching the route, travelling through), never characters. Authored
 * NPCs from later phases register here or reuse these definitions; nothing in
 * this file invents names, factions, dialogue or story.
 */
const RADII: StreamingRadii = {
  full: CONFIG.npc.fullDistance,
  reduced: CONFIG.npc.reducedDistance,
  background: CONFIG.npc.streamDistance,
};

export const NPC_DEFINITIONS: Readonly<Record<NpcRole, NpcDefinition>> = {
  wanderer: {
    role: 'wanderer', label: 'Trail wanderer', accent: 0x6f907c, heightScale: 1, speedScale: 0.92,
    schedule: 'roamer', radii: RADII, curious: true, alertDistance: 15,
  },
  worker: {
    role: 'worker', label: 'Trail worker', accent: 0xb2673a, heightScale: 0.98, speedScale: 0.82,
    schedule: 'settler', radii: RADII, curious: false, alertDistance: 11,
  },
  watcher: {
    role: 'watcher', label: 'Route watcher', accent: 0x3b5068, heightScale: 1.02, speedScale: 1,
    schedule: 'warden', radii: RADII, curious: true, alertDistance: 22,
  },
  traveller: {
    role: 'traveller', label: 'Road traveller', accent: 0x8a6f9c, heightScale: 1.01, speedScale: 1.08,
    schedule: 'roamer', radii: RADII, curious: true, alertDistance: 13,
  },
};

export function definitionFor(role: NpcRole): NpcDefinition {
  return NPC_DEFINITIONS[role];
}
