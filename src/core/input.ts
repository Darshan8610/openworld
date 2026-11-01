/** Input owns listeners and pointer-lock lifecycle; no DOM listeners leak on reset. */
export class Input {
  readonly keys = new Set<string>();
  lookX = 0;
  lookY = 0;
  wheel = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly abort = new AbortController();
  onActivity?: () => void;
  onShortcut?: (key: string) => void;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const options = { signal: this.abort.signal };
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, select, textarea, button') || target.isContentEditable) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3'].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (!event.repeat) this.onShortcut?.(event.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown'].includes(event.code)) this.onActivity?.();
    }, options);
    window.addEventListener('keyup', (event) => this.keys.delete(event.code), options);
    window.addEventListener('blur', () => this.clear(), options);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clear(); }, options);
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      this.dragging = true;
      this.lastX = event.clientX; this.lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      this.onActivity?.();
    }, options);
    canvas.addEventListener('pointerup', () => { this.dragging = false; }, options);
    canvas.addEventListener('pointercancel', () => { this.dragging = false; }, options);
    window.addEventListener('pointermove', (event) => {
      const locked = document.pointerLockElement === canvas;
      if (!locked && !this.dragging) return;
      this.lookX += locked ? event.movementX : event.clientX - this.lastX;
      this.lookY += locked ? event.movementY : event.clientY - this.lastY;
      this.lastX = event.clientX; this.lastY = event.clientY;
    }, options);
    canvas.addEventListener('wheel', (event) => { event.preventDefault(); this.wheel += Math.sign(event.deltaY); }, { ...options, passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
  }

  down(...codes: string[]): boolean { return codes.some((code) => this.keys.has(code)); }
  consumeLook(): { x: number; y: number } { const result = { x: this.lookX, y: this.lookY }; this.lookX = 0; this.lookY = 0; return result; }
  async lock(): Promise<void> { this.canvas.focus({ preventScroll: true }); try { await this.canvas.requestPointerLock(); } catch { /* Drag-look remains available when embedding denies lock. */ } }
  clear(): void { this.keys.clear(); this.lookX = 0; this.lookY = 0; this.dragging = false; }
  dispose(): void { this.abort.abort(); this.clear(); if (document.pointerLockElement === this.canvas) document.exitPointerLock(); }
}
