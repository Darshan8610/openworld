import type { Discovery, MapPoint } from '../discovery/discovery';
import type { WorldQueries } from '../world/world-queries';

/** Bounded local chart. No invented road links or unstreamed building markers. */
export class DiscoveryPanel {
  private readonly root = document.createElement('section');
  private readonly canvas = document.createElement('canvas');
  private readonly info = document.createElement('p');
  private readonly abort = new AbortController();
  private center: MapPoint = { x: 0, z: 0 };
  private radius = 1500;
  private lastDraw = -Infinity;
  private open = false;
  private readonly toggle = document.createElement('button');
  constructor(private readonly discovery: Discovery, private readonly queries: () => WorldQueries, save: (slot: number) => void, load: (slot: number) => void) {
    this.root.className = 'discovery-panel'; this.root.hidden = true;
    this.root.setAttribute('aria-label', 'World map and save slots');
    this.root.innerHTML = '<h2>World chart</h2><p>North is −Z · click to set a waypoint · undiscovered land is shaded</p>';
    this.canvas.width = 320; this.canvas.height = 320;
    this.canvas.setAttribute('aria-label', 'Local terrain and road map');
    this.root.append(this.canvas, this.info);
    const button = (label: string, action: () => void) => {
      const b = document.createElement('button'); b.textContent = label; b.onclick = action; this.root.append(b);
    };
    button('Zoom in', () => { this.radius = Math.max(250, this.radius / 2); this.lastDraw = -Infinity; });
    button('Zoom out', () => { this.radius = Math.min(12000, this.radius * 2); this.lastDraw = -Infinity; });
    button('Clear waypoint', () => this.discovery.setWaypoint(null));
    for (let i = 1; i <= 3; i++) { button(`Save ${i}`, () => save(i)); button(`Load ${i}`, () => load(i)); }
    button('Close map', () => this.setOpen(false));
    this.toggle.className = 'discovery-toggle'; this.toggle.textContent = 'Map · M'; this.toggle.onclick = () => this.setOpen(!this.open);
    document.body.append(this.root, this.toggle);
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      this.discovery.setWaypoint({ x: this.center.x + ((e.clientX - r.left) / r.width * 2 - 1) * this.radius, z: this.center.z + ((e.clientY - r.top) / r.height * 2 - 1) * this.radius });
      this.lastDraw = -Infinity;
    }, { signal: this.abort.signal });
    document.addEventListener('keydown', e => {
      if ((e.target as HTMLElement)?.closest('input,select,textarea')) return;
      if (e.code === 'KeyM' && !e.repeat) this.setOpen(!this.open);
      if (e.code === 'Escape') this.setOpen(false);
    }, { signal: this.abort.signal });
  }
  get isOpen(): boolean { return this.open; }
  private setOpen(open: boolean): void {
    this.open = open; this.root.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open));
    if (open) { document.exitPointerLock(); this.root.querySelector('button')?.focus(); this.lastDraw = -Infinity; }
    else this.toggle.focus();
  }
  update(position: MapPoint, yaw: number, now: number): void {
    if (!this.open || now - this.lastDraw < 500) return;
    this.lastDraw = now; this.center = { x: position.x, z: position.z };
    const ctx = this.canvas.getContext('2d'); if (!ctx) return;
    const q = this.queries();
    const colours = ['#638565', '#365c58', '#ad9c65', '#7d8985', '#c5d3d2'];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const p = { x: position.x + ((x + .5) / 16 - 1) * this.radius, z: position.z + ((y + .5) / 16 - 1) * this.radius };
      ctx.fillStyle = this.discovery.discovered(p) ? colours[q.climateAt(p.x, p.z).dominant]! : '#1b2c30';
      ctx.fillRect(x * 10, y * 10, 10, 10);
    }
    const roads = q.field.roads;
    const mid = Math.round((position.z - roads.center(0, position.x)) / 2048);
    ctx.strokeStyle = '#e0c78f'; ctx.lineWidth = 2;
    for (let c = mid - 7; c <= mid + 7; c++) {
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const x = position.x + (i / 32 - 1) * this.radius;
        const z = roads.center(c, x), py = 160 + (z - position.z) / this.radius * 160;
        if (i === 0) ctx.moveTo(0, py); else ctx.lineTo(i * 5, py);
      }
      ctx.stroke();
    }
    ctx.save(); ctx.translate(160, 160); ctx.rotate(yaw); ctx.fillStyle = '#f5faf0'; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill(); ctx.restore();
    const w = this.discovery.waypoint;
    if (w) { ctx.fillStyle = '#e6b377'; ctx.beginPath(); ctx.arc(160 + (w.x - position.x) / this.radius * 160, 160 + (w.z - position.z) / this.radius * 160, 5, 0, Math.PI * 2); ctx.fill(); }
    this.info.textContent = `${position.x.toFixed(0)}, ${position.z.toFixed(0)} · span ${this.radius * 2} m` + (w ? ` · waypoint ${Math.hypot(w.x - position.x, w.z - position.z).toFixed(0)} m (direct, not a route)` : '');
  }
  dispose(): void { this.abort.abort(); this.root.remove(); this.toggle.remove(); }
}
