import { hashSeed, seededRandom } from '../../utils/random';
import { CONFIG, QUALITY } from '../../config';
import { RoadNetwork } from '../road-network';
import { BUILDING_TEMPLATES } from './templates';
import { BUILDING_SETTINGS } from './settings';
import { buildingToWorld, distanceXZ, finitePoint, worldToBuilding } from './coordinates';
import type { BuildingDescriptor, BuildingTemplate, Point3 } from './types';

export interface BuildingTerrainQuery { height: (x: number, z: number) => number; roads: RoadNetwork }
export interface AuthoredBuilding { id: string; template: string; x: number; z: number; y?: number; yaw: number }

/** Pure, random-access roadside lots. The cache includes rejections and is bounded. */
export class BuildingPlacementField {
  private readonly cache = new Map<string, BuildingDescriptor | null>();
  private readonly authored = new Map<string, BuildingDescriptor>();
  private readonly seedId: string;
  constructor(readonly seed: string, private readonly terrain: BuildingTerrainQuery) { this.seedId = hashSeed(seed).toString(16); }

  get(corridor: number, cell: number, side: -1 | 1): BuildingDescriptor | undefined {
    if (![corridor, cell].every(Number.isSafeInteger)) return undefined;
    const id = `b1:${this.seedId}:${corridor}:${cell}:${side}`;
    if (this.cache.has(id)) return this.cache.get(id) ?? undefined;
    const random = seededRandom(hashSeed(`${this.seed}:${corridor}:${cell}:${side}`));
    const template = BUILDING_TEMPLATES.all[Math.floor(random() * BUILDING_TEMPLATES.all.length)]!;
    const station = (cell + 0.5) * BUILDING_SETTINGS.stationSpacing + (random() - 0.5) * 200;
    const point = this.terrain.roads.point(corridor, station, side * (50 + random() * 14));
    const road = this.terrain.roads.at(corridor, station, point.z);
    const yaw = Math.atan2(-side * road.normalX, -side * road.normalZ);
    const position = { x: point.x, y: 0, z: point.z };
    const candidate: BuildingDescriptor = { id, template: template.id, source: 'generated', position, yaw, foundationBottom: 0, seed: this.seed };
    const relief = this.measureSite(candidate, template);
    position.y = relief.max + 0.14; candidate.foundationBottom = relief.min - 0.35;
    const valid = relief.max - relief.min <= BUILDING_SETTINGS.maxFoundationRelief && this.roadClear(candidate, template);
    this.cache.set(id, valid ? candidate : null);
    if (this.cache.size > BUILDING_SETTINGS.siteCache) this.cache.delete(this.cache.keys().next().value!);
    return valid ? candidate : undefined;
  }

  getById(id: string): BuildingDescriptor | undefined {
    const authored = this.authored.get(id);
    if (authored) return authored;
    const match = /^b1:([0-9a-f]+):(-?\d+):(-?\d+):(-?1)$/.exec(id);
    if (!match || match[1] !== this.seedId) return undefined;
    return this.get(Number(match[2]), Number(match[3]), Number(match[4]) as -1 | 1);
  }

  nearby(x: number, z: number, radius: number): BuildingDescriptor[] {
    if (![x, z, radius].every(Number.isFinite) || radius < 0 || radius > 12000) throw new Error('Invalid building query radius');
    const roads = this.terrain.roads;
    const firstCorridor = Math.floor((z - radius - 260) / CONFIG.roads.corridorSpacing), lastCorridor = Math.ceil((z + radius + 260) / CONFIG.roads.corridorSpacing);
    const firstCell = Math.floor((x - radius - 180) / BUILDING_SETTINGS.stationSpacing), lastCell = Math.floor((x + radius + 180) / BUILDING_SETTINGS.stationSpacing);
    const result: BuildingDescriptor[] = [];
    for (let corridor = firstCorridor; corridor <= lastCorridor; corridor++) for (let cell = firstCell; cell <= lastCell; cell++) for (const side of [-1, 1] as const) {
      // Reject remote lots without expensive terrain sampling.
      const middle = (cell + 0.5) * BUILDING_SETTINGS.stationSpacing;
      if (Math.abs(roads.center(corridor, middle) - z) > radius + 320) continue;
      const building = this.get(corridor, cell, side);
      if (building && Math.hypot(building.position.x - x, building.position.z - z) <= radius && !this.overlapsAuthored(building)) result.push(building);
    }
    for (const building of this.authored.values()) if (Math.hypot(building.position.x - x, building.position.z - z) <= radius) result.push(building);
    return result.sort((a, b) => Math.hypot(a.position.x - x, a.position.z - z) - Math.hypot(b.position.x - x, b.position.z - z) || a.id.localeCompare(b.id));
  }

  nearest(position: Point3): BuildingDescriptor | undefined {
    for (const radius of [900, 1800, 3600, 7200]) { const result = this.nearby(position.x, position.z, radius)[0]; if (result) return result; }
    return undefined;
  }

  /** Stable reservations are also evaluated in terrain workers, before packing plants. */
  reserved(x: number, z: number, padding = 3): boolean {
    if (this.isAuthoredReserved(x, z, padding)) return true;
    const corridor = Math.round((z - this.terrain.roads.center(0, x)) / CONFIG.roads.corridorSpacing);
    if (Math.abs(z - this.terrain.roads.center(corridor, x)) > 120 + padding) return false;
    const sample = this.terrain.roads.sample(x, z);
    const cell = Math.floor(sample.station / BUILDING_SETTINGS.stationSpacing);
    for (let offset = -1; offset <= 1; offset++) for (const side of [-1, 1] as const) {
      const building = this.get(sample.corridor, cell + offset, side);
      if (building && this.containsLot(building, x, z, padding)) return true;
    }
    return false;
  }
  isAuthoredReserved(x: number, z: number, padding = 3): boolean {
    for (const building of this.authored.values()) if (this.containsLot(building, x, z, padding)) return true;
    return false;
  }
  containsLot(building: BuildingDescriptor, x: number, z: number, padding = 3): boolean {
    const template = BUILDING_TEMPLATES.get(building.template), local = worldToBuilding(building, { x, y: building.position.y, z });
    return Math.abs(local.x) < template.width / 2 + padding && local.z > -template.depth / 2 - padding && local.z < template.depth / 2 + 10 + padding;
  }

  registerAuthored(input: AuthoredBuilding): BuildingDescriptor {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || this.authored.size >= 64) throw new Error('Invalid authored building id or authored building budget exceeded');
    const id = `authored:${input.id}`;
    if (this.authored.has(id)) throw new Error('Duplicate authored building id');
    const template = BUILDING_TEMPLATES.get(input.template);
    const candidate: BuildingDescriptor = { id, source: 'authored', template: input.template, seed: this.seed, yaw: input.yaw, position: { x: input.x, y: input.y ?? 0, z: input.z }, foundationBottom: 0 };
    if (!finitePoint(candidate.position) || !Number.isFinite(input.yaw)) throw new Error('Invalid authored transform');
    const relief = this.measureSite(candidate, template);
    if (relief.max - relief.min > BUILDING_SETTINGS.maxFoundationRelief || !this.roadClear(candidate, template)) throw new Error('Authored site is too steep or intersects a road formation');
    if (input.y !== undefined && (input.y < relief.max + 0.05 || input.y - relief.min > 4)) throw new Error('Authored foundation cannot float or bury its floor');
    candidate.position.y = input.y ?? relief.max + 0.14;
    candidate.foundationBottom = relief.min - 0.35;
    if (this.overlapsAuthored(candidate)) throw new Error('Authored buildings overlap');
    this.authored.set(id, candidate);
    return candidate;
  }
  private overlapsAuthored(candidate: BuildingDescriptor): boolean {
    const template = BUILDING_TEMPLATES.get(candidate.template);
    for (const building of this.authored.values()) {
      const other = BUILDING_TEMPLATES.get(building.template);
      if (distanceXZ(candidate.position, building.position) < Math.hypot(template.width, template.depth + 6) / 2 + Math.hypot(other.width, other.depth + 6) / 2 + 4) return true;
    }
    return false;
  }
  private roadClear(building: BuildingDescriptor, template: BuildingTemplate): boolean {
    // Interior samples matter for larger authored footprints: all four corners
    // can sit clear while the middle still straddles a road. Keep gaps <= 12 m.
    const nx = Math.ceil((template.width + 4) / 12), nz = Math.ceil((template.depth + 12) / 12);
    for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) {
      const x = -template.width / 2 - 2 + ix * (template.width + 4) / nx;
      const z = -template.depth / 2 - 2 + iz * (template.depth + 12) / nz;
      const p = buildingToWorld(building, { x, y: 0, z });
      const road = this.terrain.roads.sample(p.x, p.z);
      if (Math.abs(road.lateral) < 25 + road.pullout * 12) return false;
    }
    return true;
  }
  private measureSite(building: BuildingDescriptor, template: BuildingTemplate): { min: number; max: number } {
    let min = Infinity, max = -Infinity;
    const sample = (x: number, z: number) => { const h = this.terrain.height(x, z); min = Math.min(min, h); max = Math.max(max, h); };
    // Near buildings resolve to maxDepth terrain. Bound the linear triangles
    // by ALL enclosing vertices for every preset, independent of active quality.
    const corners = [-1, 1].flatMap((x) => [-1, 1].map((z) => buildingToWorld(building, {
      x: x * (template.width / 2 + 0.15), y: 0,
      z: z < 0 ? -template.depth / 2 - 0.15 : template.depth / 2 + 3.4,
    })));
    const left = Math.min(...corners.map((p) => p.x)), right = Math.max(...corners.map((p) => p.x));
    const top = Math.min(...corners.map((p) => p.z)), bottom = Math.max(...corners.map((p) => p.z));
    for (const preset of Object.values(QUALITY)) {
      const step = (CONFIG.terrain.rootSize / 2 ** CONFIG.terrain.maxDepth) / preset.segments;
      const x0 = Math.floor(left / step), x1 = Math.ceil(right / step);
      const z0 = Math.floor(top / step), z1 = Math.ceil(bottom / step);
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) sample(ix * step, iz * step);
    }
    return { min, max };
  }
  get stats() { return { cachedSites: this.cache.size, authoredSites: this.authored.size }; }
}
