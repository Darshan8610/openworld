import { distanceSqXZ } from './coordinates';

interface GridEntry<T> {
  value: T;
  x: number;
  z: number;
  cx: number;
  cz: number;
}

/**
 * Uniform hash grid used for "what is near me" queries across entities, objects,
 * pickups and (later) NPCs and vehicles. One implementation, no duplicated
 * per-system neighbourhood scans.
 */
export class SpatialGrid<T> {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, GridEntry<T>>();

  constructor(public readonly cellSize = 64) {
    if (!(cellSize > 0)) throw new Error('SpatialGrid cellSize must be positive');
  }

  private static key(cx: number, cz: number): string { return `${cx}:${cz}`; }

  set(id: string, x: number, z: number, value: T): void {
    const cx = Math.floor(x / this.cellSize), cz = Math.floor(z / this.cellSize);
    const existing = this.entries.get(id);
    if (existing && existing.cx === cx && existing.cz === cz) {
      existing.value = value; existing.x = x; existing.z = z;
      return;
    }
    if (existing) this.cells.get(SpatialGrid.key(existing.cx, existing.cz))?.delete(id);
    const key = SpatialGrid.key(cx, cz);
    let cell = this.cells.get(key);
    if (!cell) { cell = new Set(); this.cells.set(key, cell); }
    cell.add(id);
    this.entries.set(id, { value, x, z, cx, cz });
  }

  delete(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.cells.get(SpatialGrid.key(entry.cx, entry.cz))?.delete(id);
    this.entries.delete(id);
    return true;
  }

  get(id: string): T | undefined { return this.entries.get(id)?.value; }
  get size(): number { return this.entries.size; }

  /** Values within `radius`, nearest first. Radius is measured on the XZ plane. */
  near(x: number, z: number, radius: number): T[] {
    const hits: { value: T; d2: number }[] = [];
    const minX = Math.floor((x - radius) / this.cellSize), maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize), maxZ = Math.floor((z + radius) / this.cellSize);
    const limit = radius * radius;
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      const cell = this.cells.get(SpatialGrid.key(cx, cz));
      if (!cell) continue;
      for (const id of cell) {
        const entry = this.entries.get(id);
        if (!entry) continue;
        const d2 = distanceSqXZ(entry.x, entry.z, x, z);
        if (d2 <= limit) hits.push({ value: entry.value, d2 });
      }
    }
    hits.sort((a, b) => a.d2 - b.d2);
    return hits.map((hit) => hit.value);
  }

  /** Visit entries inside an axis-aligned XZ box without allocating. */
  forEachInBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (value: T) => void): void {
    const cx0 = Math.floor(minX / this.cellSize), cx1 = Math.floor(maxX / this.cellSize);
    const cz0 = Math.floor(minZ / this.cellSize), cz1 = Math.floor(maxZ / this.cellSize);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const cell = this.cells.get(SpatialGrid.key(cx, cz));
      if (!cell) continue;
      for (const id of cell) {
        const entry = this.entries.get(id);
        if (entry) visit(entry.value);
      }
    }
  }

  clear(): void { this.cells.clear(); this.entries.clear(); }
}
