import { CONFIG } from '../config';

/** Fixed simulation clock, bounded catch-up, and interpolation alpha for Phase 4. */
export class FixedLoop {
  private previous = 0;
  private accumulator = 0;
  fps = 60;
  frameMs = 16.67;
  droppedTime = 0;

  tick(timestamp: number, update: (dt: number) => void, render: (alpha: number, dt: number) => void): void {
    if (!this.previous) { this.previous = timestamp; return; }
    const raw = Math.max(0, (timestamp - this.previous) / 1000);
    this.previous = timestamp;
    const dt = Math.min(raw, CONFIG.physics.fixedStep * CONFIG.physics.maxSubSteps);
    if (raw > dt) this.droppedTime += raw - dt;
    if (raw > 0 && raw < 1) {
      this.frameMs += (raw * 1000 - this.frameMs) * 0.04;
      this.fps = 1000 / this.frameMs;
    }
    this.accumulator += dt;
    while (this.accumulator >= CONFIG.physics.fixedStep) {
      update(CONFIG.physics.fixedStep);
      this.accumulator -= CONFIG.physics.fixedStep;
    }
    render(this.accumulator / CONFIG.physics.fixedStep, dt);
  }

  reset(): void { this.previous = 0; this.accumulator = 0; }
}
