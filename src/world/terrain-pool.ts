import type { TileRequest, TerrainResponse } from './tiles';

interface PendingJob {
  request: TileRequest;
  resolve: (result: TerrainResponse) => void;
  reject: (error: Error) => void;
  priority: number;
}
interface Slot { worker: Worker; job?: PendingJob }

/** Bounded, cancellable, nearest-first job queue. Workers never contend with RAF. */
export class TerrainPool {
  private readonly slots: Slot[] = [];
  private readonly jobs = new Map<number, PendingJob>();
  private readonly queue: PendingJob[] = [];
  private nextId = 0;
  private disposed = false;

  constructor(count: number, private readonly onError: (error: Error) => void) {
    for (let i = 0; i < Math.max(1, Math.min(count, navigator.hardwareConcurrency || 4)); i++) {
      const worker = new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module', name: `terrain-${i}` });
      const slot: Slot = { worker };
      worker.onmessage = ({ data }: MessageEvent<TerrainResponse>) => {
        const job = this.jobs.get(data.id);
        slot.job = undefined;
        if (job) {
          this.jobs.delete(data.id);
          job.resolve(data);
        }
        this.pump();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        const error = new Error(event.message || 'Terrain worker failed');
        if (slot.job) {
          this.jobs.delete(slot.job.request.id);
          slot.job.reject(error);
          slot.job = undefined;
        }
        this.onError(error);
        this.pump();
      };
      this.slots.push(slot);
    }
  }

  request(request: Omit<TileRequest, 'id'>, priority: number): Promise<TerrainResponse> {
    if (this.disposed) return Promise.reject(new Error('Terrain pool disposed'));
    return new Promise((resolve, reject) => {
      const job = { request: { ...request, id: this.nextId++ }, resolve, reject, priority };
      this.jobs.set(job.request.id, job);
      this.queue.push(job);
      this.queue.sort((a, b) => a.priority - b.priority || a.request.id - b.request.id);
      this.pump();
    });
  }

  private pump(): void {
    if (this.disposed) return;
    for (const slot of this.slots) {
      if (slot.job) continue;
      const job = this.queue.shift();
      if (!job) return;
      slot.job = job;
      slot.worker.postMessage(job.request);
    }
  }

  /** Reject stale requests before a seed or quality change; in-flight results are epoch-checked. */
  cancelPending(): void {
    for (const job of this.queue) {
      this.jobs.delete(job.request.id);
      job.reject(new Error('Cancelled'));
    }
    this.queue.length = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    for (const slot of this.slots) {
      slot.worker.terminate();
      if (slot.job) {
        this.jobs.delete(slot.job.request.id);
        slot.job.reject(new Error('Terrain pool disposed'));
      }
    }
    this.slots.length = 0;
  }

  get pending(): number { return this.jobs.size; }
}
