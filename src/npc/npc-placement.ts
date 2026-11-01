import { CONFIG } from '../config';
import { hashSeed, seededRandom } from '../utils/random';
import type { WorldQueries } from '../world/world-queries';
import type { NpcAnchors, NpcRole, PlacedNpc } from './types';
import { NPC_ROLES } from './types';

/**
 * Deterministic NPC placement.
 *
 * Two populations, both planned per canonical cell:
 *
 *  - **Roadside** — projected from corridor stations onto the verge, so people
 *    exist where the player actually travels. The verge is searched outward from
 *    the graded formation because the road cut can be steep for tens of metres;
 *    a station whose surroundings are a cliff is skipped rather than placed badly.
 *  - **Wild** — a bounded number of candidates on walkable open ground away from
 *    the carriageway, so crossing a meadow can still meet someone.
 *
 * Placement is a pure function of `(seed, cell, world queries)`, and every
 * candidate is emitted by exactly one owning cell. That is what lets the
 * persistence layer store only changes rather than positions.
 */
export const NPC_CELL_SIZE = CONFIG.npc.cellSize;
/** Distance between roadside candidates along a corridor, metres. */
export const NPC_STATION_SPACING = 176;

export interface NpcPlacementInputs {
  readonly seed: string;
  readonly queries: WorldQueries;
}

/** Maximum walkable slope for a placement anchor (0..1 over 45°). */
const MAX_ANCHOR_SLOPE = 0.55;
/** Candidate verge distances from the centreline, metres, nearest first. */
const VERGE_OFFSETS = [13, 19, 26, 34, 44, 56, 70, 86] as const;
/** Wild candidates attempted per cell. */
const WILD_ATTEMPTS = 3;
/** Minimum spacing between two NPCs placed in the same cell, metres. */
const MIN_SPACING = 55;
/** Never place inside the graded formation, metres. */
const ROAD_CLEARANCE = 10;

export function planNpcCell(cellX: number, cellZ: number, inputs: NpcPlacementInputs): PlacedNpc[] {
  const { queries, seed } = inputs;
  const size = NPC_CELL_SIZE;
  const left = cellX * size, top = cellZ * size, right = left + size, bottom = top + size;
  const random = seededRandom(hashSeed(`${seed}:npc:${cellX}:${cellZ}`));
  const out: PlacedNpc[] = [];
  const placed: { x: number; z: number }[] = [];

  const inside = (x: number, z: number) => x >= left && x < right && z >= top && z < bottom;
  const clear = (x: number, z: number) => {
    if (queries.slope(x, z) > MAX_ANCHOR_SLOPE) return false;
    if (Math.abs(queries.road(x, z).lateral) < ROAD_CLEARANCE) return false;
    return placed.every((other) => Math.hypot(other.x - x, other.z - z) >= MIN_SPACING);
  };

  const corridorMin = Math.floor((top - 420) / CONFIG.roads.corridorSpacing) - 1;
  const corridorMax = Math.ceil((bottom + 420) / CONFIG.roads.corridorSpacing) + 1;
  const stationMin = Math.floor((left - 260) / NPC_STATION_SPACING);
  const stationMax = Math.ceil((right + 260) / NPC_STATION_SPACING);

  // ---- Roadside population ---------------------------------------------------
  for (let corridor = corridorMin; corridor <= corridorMax; corridor++) {
    for (let slot = stationMin; slot <= stationMax; slot++) {
      if (random() > 0.55) continue;
      const side = random() < 0.5 ? -1 : 1;
      const jitter = (random() - 0.5) * 70;
      const station = slot * NPC_STATION_SPACING + jitter;
      const verge = findVerge(queries, corridor, station, side, random);
      if (!verge) continue;
      if (!inside(verge.x, verge.z) || !clear(verge.x, verge.z)) continue;

      const role = pickRole(random);
      const anchors = buildAnchors(queries, verge.x, verge.z, random);
      if (!anchors) continue;
      const centre = queries.field.roads.point(corridor, station, 0);
      placed.push({ x: verge.x, z: verge.z });
      out.push({
        id: `npc.${cellX}.${cellZ}.r${corridor}.${slot}`,
        role,
        x: verge.x,
        y: queries.height(verge.x, verge.z),
        z: verge.z,
        yaw: Math.atan2(centre.x - verge.x, centre.z - verge.z),
        anchors,
      });
    }
  }

  // ---- Wild population -------------------------------------------------------
  for (let attempt = 0; attempt < WILD_ATTEMPTS; attempt++) {
    const x = left + 40 + random() * (size - 80);
    const z = top + 40 + random() * (size - 80);
    if (!clear(x, z)) continue;
    const anchors = buildAnchors(queries, x, z, random);
    if (!anchors) continue;
    placed.push({ x, z });
    out.push({
      id: `npc.${cellX}.${cellZ}.w${attempt}`,
      role: pickRole(random),
      x,
      y: queries.height(x, z),
      z,
      yaw: random() * Math.PI * 2,
      anchors,
    });
  }

  return out;
}

/**
 * Walk outward from the formation until the ground is walkable. Road cuts and
 * fills are steep right beside the shoulder, so the first offsets are often
 * rejected; a station surrounded by cliffs returns undefined.
 */
function findVerge(
  queries: WorldQueries,
  corridor: number,
  station: number,
  side: number,
  random: () => number,
): { x: number; z: number } | undefined {
  for (const offset of VERGE_OFFSETS) {
    const lateral = side * (offset + random() * 4);
    const point = queries.field.roads.point(corridor, station, lateral);
    if (queries.slope(point.x, point.z) > MAX_ANCHOR_SLOPE) continue;
    if (Math.abs(queries.road(point.x, point.z).lateral) < ROAD_CLEARANCE) continue;
    return point;
  }
  return undefined;
}

/**
 * Three anchors for the daily schedule around a spawn point. Each is searched
 * locally for walkable ground and falls back to the spawn point itself, so a
 * schedule can never send an NPC into a cliff or off the edge of a pass.
 */
function buildAnchors(queries: WorldQueries, x: number, z: number, random: () => number): NpcAnchors | undefined {
  const around = (distance: number, spread: number) => {
    for (let i = 0; i < 6; i++) {
      const angle = random() * Math.PI * 2;
      const radius = distance * (0.55 + random() * spread);
      const px = x + Math.cos(angle) * radius;
      const pz = z + Math.sin(angle) * radius;
      if (queries.slope(px, pz) > MAX_ANCHOR_SLOPE) continue;
      return { x: px, y: queries.height(px, pz), z: pz };
    }
    return { x, y: queries.height(x, z), z };
  };
  const home = around(30, 0.9);
  const work = around(70, 1.1);
  const leisure = around(46, 1.2);
  if (!home || !work || !leisure) return undefined;
  return { home, work, leisure };
}

function pickRole(random: () => number): NpcRole {
  // Weighted: wanderers and travellers are the common population, workers man
  // the verge through the day, watchers are rarer.
  const roll = random();
  if (roll < 0.34) return NPC_ROLES[0]!;
  if (roll < 0.62) return NPC_ROLES[1]!;
  if (roll < 0.82) return NPC_ROLES[3]!;
  return NPC_ROLES[2]!;
}

/** Streaming cells around a canonical position, nearest first. */
export function npcCellsAround(x: number, z: number, radiusCells: number): { cellX: number; cellZ: number; distance: number }[] {
  const centreX = Math.floor(x / NPC_CELL_SIZE), centreZ = Math.floor(z / NPC_CELL_SIZE);
  const cells: { cellX: number; cellZ: number; distance: number }[] = [];
  for (let dz = -radiusCells; dz <= radiusCells; dz++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const cellX = centreX + dx, cellZ = centreZ + dz;
      const centreCellX = (cellX + 0.5) * NPC_CELL_SIZE, centreCellZ = (cellZ + 0.5) * NPC_CELL_SIZE;
      cells.push({ cellX, cellZ, distance: Math.hypot(centreCellX - x, centreCellZ - z) });
    }
  }
  cells.sort((a, b) => a.distance - b.distance);
  return cells;
}

export const npcCellKey = (cellX: number, cellZ: number): string => `${cellX}:${cellZ}`;
