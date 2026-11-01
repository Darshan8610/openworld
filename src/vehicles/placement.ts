import { CONFIG } from '../config';
import { hashSeed } from '../utils/random';
import { cellRandom } from '../world/vegetation-field';
import { vehiclesForTerrain } from './catalog';
import type { VehicleSpec } from './types';
import type { WorldQueries } from '../world/world-queries';

/**
 * Deterministic vehicle placement.
 *
 * Mirrors the object planner's contract exactly: vehicles are planned per
 * canonical cell and only emitted when their position actually falls inside
 * that cell, so every candidate has exactly one cell owner — no duplicates
 * across cell boundaries, no gaps, and no per-frame randomness. Placement is a
 * pure function of (seed, cell coords, world queries), which is what lets the
 * persistence layer store only vehicles the player has *changed* rather than
 * every vehicle in an infinite world.
 *
 * Road and pullout placement is driven by the Phase 3 road network through
 * `queries.field.roads`, so vehicles sit on the real carriageway geometry
 * rather than being scattered and snapped.
 */
export const VEHICLE_CELL_SIZE = CONFIG.vehicles.cellSize;

export interface PlacedVehicle {
  /** Stable identifier derived from seed + placement slot, never a counter. */
  readonly id: string;
  /** Catalogue key; resolve with `vehicleSpec`. */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly source: VehicleSpec['spawn']['terrain'];
}

export interface VehiclePlacementInputs {
  readonly seed: string;
  readonly queries: WorldQueries;
}

export const vehicleCellKey = (cellX: number, cellZ: number): string => `${cellX}:${cellZ}`;

/** Cells overlapping a radius around a point, nearest first. */
export function vehicleCellsAround(x: number, z: number, radiusCells: number): { cellX: number; cellZ: number; distance: number }[] {
  const size = VEHICLE_CELL_SIZE;
  const centreX = Math.floor(x / size);
  const centreZ = Math.floor(z / size);
  const out: { cellX: number; cellZ: number; distance: number }[] = [];
  for (let dz = -radiusCells; dz <= radiusCells; dz++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const cellX = centreX + dx;
      const cellZ = centreZ + dz;
      const midX = (cellX + 0.5) * size;
      const midZ = (cellZ + 0.5) * size;
      out.push({ cellX, cellZ, distance: Math.hypot(midX - x, midZ - z) });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/** Weighted pick from a terrain group; `roll` is 0..1. */
function pickSpec(group: readonly VehicleSpec[], roll: number): VehicleSpec | undefined {
  if (group.length === 0) return undefined;
  let total = 0;
  for (const spec of group) total += spec.spawn.weight;
  if (total <= 0) return group[0];
  let cursor = roll * total;
  for (const spec of group) {
    cursor -= spec.spawn.weight;
    if (cursor <= 0) return spec;
  }
  return group[group.length - 1];
}

/** Plan every vehicle whose canonical position lies inside the given cell. */
export function planVehicleCell(cellX: number, cellZ: number, inputs: VehiclePlacementInputs): PlacedVehicle[] {
  const { queries, seed } = inputs;
  const size = VEHICLE_CELL_SIZE;
  const left = cellX * size, top = cellZ * size, right = left + size, bottom = top + size;
  const seedHash = hashSeed(seed);
  const out: PlacedVehicle[] = [];
  const occupied: { x: number; z: number }[] = [];

  const roadGroup = vehiclesForTerrain('road');
  const pulloutGroup = vehiclesForTerrain('pullout');
  const shoreGroup = vehiclesForTerrain('shore');
  const openGroup = vehiclesForTerrain('open');

  const emit = (spec: VehicleSpec | undefined, id: string, x: number, z: number, yaw: number, source: PlacedVehicle['source']): void => {
    if (!spec) return;
    // Exactly one cell owns each candidate.
    if (x < left || x >= right || z < top || z >= bottom) return;
    if (queries.slope(x, z) > spec.spawn.maxSlope) return;
    const gap = CONFIG.vehicles.spacing;
    for (const other of occupied) {
      if (Math.hypot(other.x - x, other.z - z) < gap) return;
    }
    occupied.push({ x, z });
    // Rest the hull just above the ground; the suspension settles it on the
    // first few fixed steps rather than spawning it interpenetrating.
    const y = queries.height(x, z) + spec.dimensions.height * 0.5;
    out.push({ id, key: spec.key, x, y, z, yaw, source });
  };

  // ---- On the carriageway and in pullouts -----------------------------------
  // Walk the Phase 3 road corridors that cross this cell rather than sampling
  // the world and hoping to land on tarmac.
  const spacing = CONFIG.roads.pulloutSpacing;
  const firstStation = Math.floor((left - size) / spacing) * spacing;
  const lastStation = Math.ceil((right + size) / spacing) * spacing;
  const corridorMin = Math.floor((top - size) / CONFIG.roads.corridorSpacing) - 1;
  const corridorMax = Math.ceil((bottom + size) / CONFIG.roads.corridorSpacing) + 1;

  for (let corridor = corridorMin; corridor <= corridorMax; corridor++) {
    for (let station = firstStation; station <= lastStation; station += spacing) {
      const index = Math.round(station / spacing);

      // Not every stop has a vehicle: an infinite world full of parked cars
      // reads as a car park, not a road.
      if (cellRandom(index, corridor, seedHash, 0x4d21) < 0.52) {
        const side = cellRandom(index, corridor, seedHash, 0x1f07) < 0.5 ? -1 : 1;
        const lateral = side * (6.2 + cellRandom(index, corridor, seedHash, 0x2b93) * 2.4);
        const point = queries.field.roads.point(corridor, station, lateral);
        const spec = pickSpec(pulloutGroup, cellRandom(index, corridor, seedHash, 0x7c15));
        // Park parallel to the carriageway, facing either way.
        const ahead = queries.field.roads.point(corridor, station + 6, lateral);
        const heading = Math.atan2(ahead.x - point.x, ahead.z - point.z);
        const flipped = cellRandom(index, corridor, seedHash, 0x66ab) < 0.5 ? 0 : Math.PI;
        emit(spec, `veh.pullout.${corridor}.${index}`, point.x, point.z, heading + flipped, 'pullout');
      }

      // A rarer vehicle stopped on the road itself, between pullouts.
      if (cellRandom(index, corridor, seedHash, 0x58e3) < 0.22) {
        const offset = spacing * (0.35 + cellRandom(index, corridor, seedHash, 0x3a4f) * 0.3);
        const lateral = (cellRandom(index, corridor, seedHash, 0x11c8) < 0.5 ? -1 : 1) * 1.9;
        const point = queries.field.roads.point(corridor, station + offset, lateral);
        const ahead = queries.field.roads.point(corridor, station + offset + 6, lateral);
        const spec = pickSpec(roadGroup, cellRandom(index, corridor, seedHash, 0x9d71));
        const heading = Math.atan2(ahead.x - point.x, ahead.z - point.z);
        emit(spec, `veh.road.${corridor}.${index}`, point.x, point.z, heading, 'road');
      }
    }
  }

  // ---- Shoreline craft --------------------------------------------------------
  // Scan a coarse lattice and keep the samples that sit on a genuine water
  // margin: land that is barely above the waterline with water alongside.
  const lattice = 128;
  for (let gx = left; gx < right; gx += lattice) {
    for (let gz = top; gz < bottom; gz += lattice) {
      const jx = gx + cellRandom(gx, gz, seedHash, 0x24f1) * lattice;
      const jz = gz + cellRandom(gx, gz, seedHash, 0x55a2) * lattice;
      if (cellRandom(Math.round(jx), Math.round(jz), seedHash, 0x7e39) > 0.16) continue;
      const surface = queries.surface(jx, jz);
      if (surface !== 'water' && surface !== 'sand' && surface !== 'gravel') continue;
      const spec = pickSpec(shoreGroup, cellRandom(Math.round(jx), Math.round(jz), seedHash, 0x4812));
      const yaw = cellRandom(Math.round(jx), Math.round(jz), seedHash, 0x6d04) * Math.PI * 2;
      emit(spec, `veh.shore.${Math.round(jx)}.${Math.round(jz)}`, jx, jz, yaw, 'shore');
    }
  }

  // ---- Open ground (airstrips, flat clearings) -------------------------------
  for (let gx = left; gx < right; gx += lattice) {
    for (let gz = top; gz < bottom; gz += lattice) {
      const jx = gx + cellRandom(gx, gz, seedHash, 0x3c77) * lattice;
      const jz = gz + cellRandom(gx, gz, seedHash, 0x18be) * lattice;
      if (cellRandom(Math.round(jx), Math.round(jz), seedHash, 0x2a66) > 0.07) continue;
      // Aircraft need genuinely flat ground and clear separation from the road.
      const road = queries.road(jx, jz);
      if (Math.abs(road.lateral) < 30) continue;
      const spec = pickSpec(openGroup, cellRandom(Math.round(jx), Math.round(jz), seedHash, 0x5f90));
      const yaw = cellRandom(Math.round(jx), Math.round(jz), seedHash, 0x7311) * Math.PI * 2;
      emit(spec, `veh.open.${Math.round(jx)}.${Math.round(jz)}`, jx, jz, yaw, 'open');
    }
  }

  return out;
}
