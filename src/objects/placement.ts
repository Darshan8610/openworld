import { CONFIG } from '../config';
import { hashSeed, seededRandom } from '../utils/random';
import { cellRandom } from '../world/vegetation-field';
import type { WorldQueries } from '../world/world-queries';
import type { ObjectState } from './archetypes';

/**
 * Deterministic world-object placement.
 *
 * Objects are planned per canonical `cellSize` cell and only emitted when their
 * position actually falls inside that cell, so every candidate is produced by
 * exactly one cell owner — no duplicates, no gaps, no per-frame randomness.
 * Placement is a pure function of (seed, cell coords, world queries), which is
 * what lets the persistence layer store only *changes* rather than positions.
 */
export const OBJECT_CELL_SIZE = CONFIG.objects.cellSize;

export interface PlacedObject {
  /** Stable identifier: derived from seed + placement slot, never a counter. */
  readonly id: string;
  readonly archetype: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Placement family, useful for debug filters and persistence policy. */
  readonly source: 'road-cache' | 'pullout' | 'utility' | 'wild';
  readonly state?: ObjectState;
}

export interface PlacementInputs {
  readonly seed: string;
  readonly queries: WorldQueries;
}

interface Emitter {
  (archetype: string, id: string, x: number, z: number, source: PlacedObject['source'], yaw?: number): void;
}

const MAX_STATIC_SLOPE = 0.34;
const MAX_DYNAMIC_SLOPE = 0.7;

/** Plan every object whose canonical position lies inside the given cell. */
export function planObjectCell(cellX: number, cellZ: number, inputs: PlacementInputs): PlacedObject[] {
  const { queries, seed } = inputs;
  const size = OBJECT_CELL_SIZE;
  const left = cellX * size, top = cellZ * size, right = left + size, bottom = top + size;
  const seedHash = hashSeed(seed);
  const out: PlacedObject[] = [];
  const occupied: { x: number; z: number }[] = [];

  const emit: Emitter = (archetype, id, x, z, source, yawOffset = 0) => {
    if (x < left || x >= right || z < top || z >= bottom) return;
    const slope = queries.slope(x, z);
    const limit = archetype === 'survey-post' || archetype === 'field-lamp' ? MAX_DYNAMIC_SLOPE : MAX_STATIC_SLOPE;
    if (slope > limit) return;
    for (const other of occupied) {
      if (Math.hypot(other.x - x, other.z - z) < 1.15) return;
    }
    const road = queries.road(x, z);
    // Never place on the carriageway, shoulder or the graded cut/fill formation.
    if (Math.abs(road.lateral) < 8.6) return;
    // Face the road so signs, gates and lamps read correctly from the verge.
    const centre = queries.nearestRoadPoint(x, z);
    const yaw = (Math.abs(road.lateral) < 26 ? Math.atan2(centre.x - x, centre.z - z) : cellRandom(Math.round(x), Math.round(z), seedHash, 0x71a3) * Math.PI * 2) + yawOffset;
    const jitter = cellRandom(Math.round(x * 4), Math.round(z * 4), seedHash, 0x2f1d);
    const y = queries.height(x, z) + 0.03 + jitter * 0.04;
    occupied.push({ x, z });
    out.push({ id, archetype, x, y, z, yaw, source });
  };

  // ---- Roadside supply caches -------------------------------------------------
  const cache = CONFIG.objects.cacheSpacing;
  const firstStation = Math.floor((left - 24) / cache) * cache;
  const lastStation = Math.ceil((right + 24) / cache) * cache;
  const corridorMin = Math.floor((top - 320) / CONFIG.roads.corridorSpacing) - 1;
  const corridorMax = Math.ceil((bottom + 320) / CONFIG.roads.corridorSpacing) + 1;

  const cacheKinds = ['supply-crate', 'tool-roll', 'parts-bin', 'water-flask', 'lantern-cell', 'fuel-drum', 'ration-box', 'medical-case'];

  for (let corridor = corridorMin; corridor <= corridorMax; corridor++) {
    for (let station = firstStation; station <= lastStation; station += cache) {
      const index = Math.round(station / cache);
      const pick = cacheKinds[Math.floor(cellRandom(index, corridor, seedHash, 0x51ed) * cacheKinds.length)]!;
      const side = cellRandom(index, corridor, seedHash, 0x77b1) < 0.5 ? -1 : 1;
      const lateral = side * (9.4 + cellRandom(index, corridor, seedHash, 0x1a2b) * 2.6);
      const point = queries.field.roads.point(corridor, station, lateral);
      emit(pick, `obj.cache.${corridor}.${index}`, point.x, point.z, 'road-cache');

      // A second, smaller item to make each stop read as a place rather than a prop.
      const secondary = cacheKinds[Math.floor(cellRandom(index + 7, corridor, seedHash, 0x63a9) * cacheKinds.length)]!;
      const secondaryPoint = queries.field.roads.point(corridor, station + 3.5, lateral + side * 0.9);
      emit(secondary, `obj.cache.${corridor}.${index}.b`, secondaryPoint.x, secondaryPoint.z, 'road-cache');

      // Every third cache has a lamp + switch pair, wired together by proximity.
      if (cellRandom(index, corridor, seedHash, 0x4c21) < 0.34) {
        const lampPoint = queries.field.roads.point(corridor, station - 5.5, lateral + side * 1.6);
        emit('field-lamp', `obj.lamp.${corridor}.${index}`, lampPoint.x, lampPoint.z, 'utility');
        const switchPoint = queries.field.roads.point(corridor, station - 6.6, lateral + side * 1.2);
        emit('utility-switch', `obj.switch.${corridor}.${index}`, switchPoint.x, switchPoint.z, 'utility');
      }
    }

    // ---- Off-road survey posts ------------------------------------------------
    const post = CONFIG.objects.postSpacing;
    const firstPost = Math.floor((left - 40) / post) * post;
    for (let station = firstPost; station <= right + 40; station += post) {
      const index = Math.round(station / post);
      const side = cellRandom(index, corridor, seedHash, 0x3b7f) < 0.5 ? -1 : 1;
      const point = queries.field.roads.point(corridor, station, side * (17 + cellRandom(index, corridor, seedHash, 0x5e2d) * 9));
      emit('survey-post', `obj.post.${corridor}.${index}`, point.x, point.z, 'wild');
    }

    // ---- Overlook rest areas --------------------------------------------------
    const pullout = CONFIG.roads.pulloutSpacing;
    const firstPullout = Math.floor((left - 60) / pullout) * pullout;
    for (let centre = firstPullout; centre <= right + 60; centre += pullout) {
      const pulloutIndex = Math.round(centre / pullout);
      const at = (offset: number, lateral: number) => queries.field.roads.point(corridor, centre + offset, lateral);
      const bench = at(-2, 20.5); emit('rest-bench', `obj.rest.${corridor}.${pulloutIndex}.bench`, bench.x, bench.z, 'pullout');
      const gate = at(7, 18.5); emit('access-gate', `obj.rest.${corridor}.${pulloutIndex}.gate`, gate.x, gate.z, 'pullout');
      const sign = at(-9, 18.8); emit('trail-sign', `obj.rest.${corridor}.${pulloutIndex}.sign`, sign.x, sign.z, 'pullout');
      const crate = at(12, 21.5); emit('supply-crate', `obj.rest.${corridor}.${pulloutIndex}.crate`, crate.x, crate.z, 'pullout');
      const medical = at(14.5, 22.6); emit('medical-case', `obj.rest.${corridor}.${pulloutIndex}.case`, medical.x, medical.z, 'pullout');
      const valve = at(3, 24.5); emit('service-valve', `obj.rest.${corridor}.${pulloutIndex}.valve`, valve.x, valve.z, 'utility');
      const lever = at(5, 25.4); emit('signal-lever', `obj.rest.${corridor}.${pulloutIndex}.lever`, lever.x, lever.z, 'utility');
    }
  }

  // ---- Wild scatter away from the road -------------------------------------
  const rng = seededRandom(seedHash ^ (cellX * 73856093) ^ (cellZ * 19349663));
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    const x = left + 40 + rng() * (size - 80);
    const z = top + 40 + rng() * (size - 80);
    if (queries.slope(x, z) > MAX_STATIC_SLOPE) continue;
    const road = queries.road(x, z);
    if (Math.abs(road.lateral) < 8.6) continue;
    const kind = rng() < 0.45 ? 'survey-post' : rng() < 0.5 ? 'ration-box' : 'water-flask';
    const jitter = Math.round((rng() - 0.5) * 4096);
    const id = `obj.wild.${cellX}.${cellZ}.${i}.${jitter}`;
    const occupiedBefore = occupied.length;
    emit(kind, id, x, z, 'wild');
    if (occupied.length === occupiedBefore) continue;
  }

  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export const objectCellKey = (cellX: number, cellZ: number): string => `${cellX}:${cellZ}`;

/** Cells covering a radius around a canonical position, nearest first. */
export function cellsAround(x: number, z: number, radiusCells: number): { cellX: number; cellZ: number; distance: number }[] {
  const centreX = Math.floor(x / OBJECT_CELL_SIZE), centreZ = Math.floor(z / OBJECT_CELL_SIZE);
  const cells: { cellX: number; cellZ: number; distance: number }[] = [];
  for (let dz = -radiusCells; dz <= radiusCells; dz++) for (let dx = -radiusCells; dx <= radiusCells; dx++) {
    const cellX = centreX + dx, cellZ = centreZ + dz;
    const centreCellX = (cellX + 0.5) * OBJECT_CELL_SIZE, centreCellZ = (cellZ + 0.5) * OBJECT_CELL_SIZE;
    cells.push({ cellX, cellZ, distance: Math.hypot(centreCellX - x, centreCellZ - z) });
  }
  cells.sort((a, b) => a.distance - b.distance);
  return cells;
}
