import type { Discovery, MapPoint } from '../discovery/discovery';
import type { WorldQueries } from '../world/world-queries';
import { planRoute } from '../discovery/navigation';

/**
 * Phase 11 — live minimap.
 *
 * A small north-up corner canvas: discovered-world tint, nearby road
 * corridors, waypoint + route and the player arrow. Only canonical metres are
 * read, so floating-origin shifts are invisible. Redraws are throttled to
 * ~5 Hz (and skipped entirely when nothing moved). The DOM document is
 * injectable so the drawing logic can be tested without a browser.
 */

export interface MinimapPlayer { x: number; z: number; yaw: number }

const BIOME_COLOURS = ['#638565', '#365c58', '#ad9c65', '#7d8985', '#c5d3d2'];

export class Minimap {
  readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lastDraw = -1e9;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private lastYaw = Number.NaN;
  private waypoint: MapPoint | null = null;
  private enabled = true;

  constructor(
    private readonly discovery: Discovery,
    private readonly queries: () => WorldQueries,
    container: { appendChild(node: unknown): void },
    size = 144,
    private readonly radius = 500,
    doc: { createElement(tag: string): unknown } = document,
  ) {
    const canvas = doc.createElement('canvas') as HTMLCanvasElement;
    canvas.className = 'minimap';
    canvas.width = size;
    canvas.height = size;
    canvas.title = 'Minimap — north-up, roads appear as they are surveyed';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('minimap 2D context unavailable');
    this.element = canvas;
    this.ctx = ctx;
    container.appendChild(canvas);
  }

  setEnabled(visible: boolean): void {
    this.enabled = visible;
    (this.element as { style?: CSSStyleDeclaration }).style!.display = visible ? '' : 'none';
  }
  isVisible(): boolean { return this.enabled; }

  setWaypoint(point: MapPoint | null): void {
    this.waypoint = point;
    this.lastDraw = -1e9; // force redraw
  }

  /** Feed player state; redraws at most every 200 ms when visibly changed. */
  update(player: MinimapPlayer, nowMs: number): void {
    if (!this.enabled) return;
    const moved = Math.hypot(player.x - this.lastX, player.z - this.lastZ);
    const turned = Math.abs(player.yaw - this.lastYaw);
    if (nowMs - this.lastDraw < 200 && moved < 2 && turned < 0.08) return;
    this.lastDraw = nowMs;
    this.lastX = player.x;
    this.lastZ = player.z;
    this.lastYaw = player.yaw;
    this.draw(player);
  }

  private toScreen(player: MinimapPlayer, x: number, z: number): { sx: number; sy: number } {
    const size = this.element.width;
    const scale = size / 2 / this.radius;
    return { sx: size / 2 + (x - player.x) * scale, sy: size / 2 - (z - player.z) * scale };
  }

  private draw(player: MinimapPlayer): void {
    const size = this.element.width;
    const ctx = this.ctx;
    const q = this.queries();
    const scale = size / 2 / this.radius;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#10151c';
    ctx.fillRect(0, 0, size, size);

    // Discovered cells tinted by their analytic biome colour; unknown stays dark.
    const block = Math.max(4, Math.round(256 * scale));
    const startX = Math.floor((player.x - this.radius) / 256) * 256;
    const startZ = Math.floor((player.z - this.radius) / 256) * 256;
    for (let wx = startX; wx <= player.x + this.radius; wx += 256) {
      for (let wz = startZ; wz <= player.z + this.radius; wz += 256) {
        if (!this.discovery.discovered({ x: wx + 128, z: wz + 128 })) continue;
        const { sx, sy } = this.toScreen(player, wx + 128, wz + 128);
        ctx.fillStyle = BIOME_COLOURS[q.climateAt(wx + 128, wz + 128).dominant] ?? '#638565';
        ctx.fillRect(Math.round(sx - block / 2), Math.round(sy - block / 2), block + 1, block + 1);
      }
    }

    // Roads: analytic centrelines near the player (honest — no invented links).
    const roads = q.field.roads;
    const mid = Math.round((player.z - roads.center(0, player.x)) / 2048);
    ctx.strokeStyle = 'rgba(224,199,143,0.75)';
    ctx.lineWidth = 1.5;
    for (let c = mid - 1; c <= mid + 1; c++) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= 32; i++) {
        const x = player.x + (i / 16 - 1) * this.radius;
        const z = roads.center(c, x);
        const { sx, sy } = this.toScreen(player, x, z);
        if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }

    // Route line: recomputed from the current player position (bounded work).
    if (this.waypoint) {
      const plan = planRoute(roads, player, this.waypoint);
      if (plan.kind === 'corridor' && plan.points.length > 1) {
        ctx.strokeStyle = 'rgba(90,178,255,0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        let first = true;
        for (const point of plan.points) {
          const { sx, sy } = this.toScreen(player, point.x, point.z);
          if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
      const { sx, sy } = this.toScreen(player, this.waypoint.x, this.waypoint.z);
      if (sx > 6 && sx < size - 6 && sy > 6 && sy < size - 6) {
        ctx.fillStyle = '#ffd447';
        ctx.beginPath();
        ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Clamp to the rim so off-map targets stay findable.
        const dx = sx - size / 2, dy = sy - size / 2;
        const len = Math.hypot(dx, dy) || 1;
        const rx = size / 2 + (dx / len) * (size / 2 - 6);
        const ry = size / 2 + (dy / len) * (size / 2 - 6);
        ctx.fillStyle = '#ffd447';
        ctx.beginPath();
        ctx.moveTo(rx, ry - 4.5);
        ctx.lineTo(rx - 4, ry + 3.5);
        ctx.lineTo(rx + 4, ry + 3.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Player arrow (yaw is canonical; arrow rotates in world space).
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(player.yaw);
    ctx.fillStyle = '#66d1ff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(-4.5, 5);
    ctx.lineTo(4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }

  dispose(): void { (this.element as { remove?: () => void }).remove?.(); }
}
