/** Canonical metres only: exploration is independent of render-origin shifts. */
export interface MapPoint { x: number; z: number }
export interface DiscoveryState { cells: string[]; waypoint: MapPoint | null }
export const DISCOVERY_LIMIT = 8192;
export const CELL_SIZE = 256;
export const validPoint = (p: MapPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.z) && Math.abs(p.x) <= 1e12 && Math.abs(p.z) <= 1e12;
export class Discovery {
  private cells = new Set<string>();
  waypoint: MapPoint | null = null;
  visit(p: MapPoint): boolean {
    if (!validPoint(p)) return false;
    const key = `${Math.floor(p.x / CELL_SIZE)}:${Math.floor(p.z / CELL_SIZE)}`;
    if (this.cells.has(key) || this.cells.size >= DISCOVERY_LIMIT) return false;
    this.cells.add(key);
    return true;
  }
  discovered(p: MapPoint): boolean { return this.cells.has(`${Math.floor(p.x / CELL_SIZE)}:${Math.floor(p.z / CELL_SIZE)}`); }
  setWaypoint(p: MapPoint | null): void {
    if (p && !validPoint(p)) throw new Error('Invalid waypoint');
    this.waypoint = p ? { ...p } : null;
  }
  snapshot(): DiscoveryState { return { cells: [...this.cells], waypoint: this.waypoint ? { ...this.waypoint } : null }; }
  restore(state: DiscoveryState): void { this.cells = new Set(state.cells); this.setWaypoint(state.waypoint); }
}
