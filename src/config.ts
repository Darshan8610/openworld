/** All distances are metres, all angles radians, and world time is in hours. */
export type QualityName = 'low' | 'balanced' | 'high';
export interface QualityPreset {
  segments: number;
  rootRadius: number;
  viewDistance: number;
  pixelRatio: number;
  shadows: boolean;
  shadowSize: number;
  workers: number;
}
export const QUALITY: Record<QualityName, QualityPreset> = {
  low: { segments: 12, rootRadius: 2, viewDistance: 6800, pixelRatio: 1, shadows: false, shadowSize: 1024, workers: 2 },
  balanced: { segments: 20, rootRadius: 2, viewDistance: 8000, pixelRatio: 1.5, shadows: true, shadowSize: 1024, workers: 3 },
  high: { segments: 28, rootRadius: 3, viewDistance: 11000, pixelRatio: 2, shadows: true, shadowSize: 2048, workers: 4 },
};
export const CONFIG = {
  terrain: {
    rootSize: 4096,
    maxDepth: 5,
    splitDistance: 1.8,
    cacheLimit: 420,
    updateInterval: 0.22,
    skirtFraction: 0.045,
  },
  origin: { rebaseDistance: 2048 },
  camera: { fov: 62, near: 0.5, far: 40000, speed: 110, boost: 5, clearance: 12, damping: 7 },
  sky: {
    initialHour: 17.6,
    secondsPerDay: 720,
    latitude: 46,
    axialTilt: 18,
    starCount: 2600,
    environmentInterval: 8,
  },
  physics: { fixedStep: 1 / 120, maxSubSteps: 8 },
} as const;
