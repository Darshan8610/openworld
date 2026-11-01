/** All distances are metres, all angles radians, and world time is in hours. */
export type QualityName = 'low' | 'balanced' | 'high';
export interface QualityPreset {
  segments: number;
  rootRadius: number;
  viewDistance: number;
  pixelRatio: number;
  shadows: boolean;
  shadowSize: number;
  /** Half-width of the sun shadow frustum in metres. */
  shadowExtent: number;
  workers: number;
  vegetationDensity: number;
  vegetationDistance: number;
  grassDistance: number;
  /** Fixed allocation order: pine, aspen, shrub, grass, rock. */
  instanceBudgets: readonly [number, number, number, number, number];
}
export const QUALITY: Record<QualityName, QualityPreset> = {
  low: { segments: 12, rootRadius: 2, viewDistance: 6800, pixelRatio: 1, shadows: false, shadowSize: 1024, shadowExtent: 600, workers: 2,
    vegetationDensity: 0.55, vegetationDistance: 720, grassDistance: 140, instanceBudgets: [900, 350, 1400, 6500, 700] },
  balanced: { segments: 20, rootRadius: 2, viewDistance: 8000, pixelRatio: 1.5, shadows: true, shadowSize: 2048, shadowExtent: 700, workers: 3,
    vegetationDensity: 0.8, vegetationDistance: 1100, grassDistance: 220, instanceBudgets: [2200, 800, 3500, 14000, 1600] },
  high: { segments: 28, rootRadius: 3, viewDistance: 11000, pixelRatio: 2, shadows: true, shadowSize: 2048, shadowExtent: 1200, workers: 4,
    vegetationDensity: 1, vegetationDistance: 1500, grassDistance: 300, instanceBudgets: [4000, 1400, 6000, 24000, 2800] },
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
  vegetation: { updateInterval: 0.3, moveThreshold: 24, wind: 0.8 },
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
