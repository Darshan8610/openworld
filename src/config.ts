/** All distances are metres, all angles radians, and world time is in hours. */
export type QualityName = 'low' | 'balanced' | 'high' | 'ultra';
export type GeometryDetail = 'low' | 'full' | 'ultra';
export interface QualityPreset {
  segments: number;
  rootRadius: number;
  viewDistance: number;
  pixelRatio: number;
  maxPixels: number;
  shadows: boolean;
  shadowSize: number;
  /** Half-width of the sun shadow frustum in metres. */
  shadowExtent: number;
  workers: number;
  vegetationDensity: number;
  vegetationDistance: number;
  grassDistance: number;
  propDistance: number;
  geometryDetail: GeometryDetail;
  ambientOcclusion: boolean;
  /** Fixed allocation order matches PLANT_KINDS (ten global batches). */
  instanceBudgets: readonly [number, number, number, number, number, number, number, number, number, number];
  /** guardrail, reflector, route sign, direction sign, bench, kiosk, bollard. */
  propBudgets: readonly [number, number, number, number, number, number, number];
  /** Maximum simultaneously streamed interactive world objects. */
  objectBudget: number;
  /** Maximum simultaneous prop rigid bodies (crates, drums, salvage). */
  physicsBodies: number;
}
export const QUALITY: Record<QualityName, QualityPreset> = {
  low: { segments: 12, rootRadius: 2, viewDistance: 6800, pixelRatio: 1, maxPixels: 1_500_000, shadows: false, shadowSize: 1024, shadowExtent: 600, workers: 2,
    vegetationDensity: 0.55, vegetationDistance: 720, grassDistance: 140, propDistance: 800, geometryDetail: 'low', ambientOcclusion: false,
    instanceBudgets: [650, 250, 900, 4000, 450, 200, 160, 500, 250, 100], propBudgets: [160, 80, 16, 32, 8, 4, 24], objectBudget: 28, physicsBodies: 20 },
  balanced: { segments: 20, rootRadius: 2, viewDistance: 8000, pixelRatio: 1.5, maxPixels: 2_600_000, shadows: true, shadowSize: 2048, shadowExtent: 700, workers: 3,
    vegetationDensity: 0.8, vegetationDistance: 1100, grassDistance: 220, propDistance: 1300, geometryDetail: 'full', ambientOcclusion: false,
    instanceBudgets: [2200, 800, 3000, 12000, 1400, 700, 500, 1800, 900, 350], propBudgets: [400, 160, 32, 64, 16, 8, 48], objectBudget: 56, physicsBodies: 40 },
  high: { segments: 28, rootRadius: 3, viewDistance: 11000, pixelRatio: 2, maxPixels: 4_000_000, shadows: true, shadowSize: 2048, shadowExtent: 1100, workers: 4,
    vegetationDensity: 1, vegetationDistance: 1500, grassDistance: 300, propDistance: 1900, geometryDetail: 'full', ambientOcclusion: false,
    instanceBudgets: [4000, 1400, 5000, 22000, 2400, 1200, 900, 3200, 1600, 650], propBudgets: [700, 240, 48, 96, 24, 12, 80], objectBudget: 88, physicsBodies: 64 },
  ultra: { segments: 36, rootRadius: 3, viewDistance: 14000, pixelRatio: 2, maxPixels: 6_500_000, shadows: true, shadowSize: 4096, shadowExtent: 900, workers: 4,
    vegetationDensity: 1, vegetationDistance: 2200, grassDistance: 420, propDistance: 2600, geometryDetail: 'ultra', ambientOcclusion: true,
    instanceBudgets: [6500, 2200, 8000, 36000, 3600, 2200, 1600, 5500, 2800, 1100], propBudgets: [1100, 360, 64, 128, 40, 20, 120], objectBudget: 128, physicsBodies: 96 },
};
export const CONFIG = {
  terrain: {
    rootSize: 4096,
    maxDepth: 5,
    splitDistance: 1.8,
    cacheLimit: 480,
    updateInterval: 0.22,
    skirtFraction: 0.045,
  },
  vegetation: { updateInterval: 0.3, moveThreshold: 24, wind: 0.8 },
  roads: { updateInterval: 0.25, corridorSpacing: 2048, laneWidth: 3.6, shoulderWidth: 1.4, pulloutSpacing: 1536 },
  objects: {
    /** Streaming tick for interactive objects, seconds. */
    updateInterval: 0.3,
    /** Canonical placement cell edge, metres. */
    cellSize: 512,
    /** Cells loaded around the player (1 = 3×3). */
    loadRadius: 2,
    /** Reach for the context interaction prompt, metres. */
    interactionRange: 6.5,
    /** Half-angle of the aim cone in degrees. */
    coneDegrees: 17,
    /** Spacing of guarded roadside caches, metres. */
    cacheSpacing: 384,
    /** Spacing of off-road survey posts, metres. */
    postSpacing: 768,
  },
  physics: { fixedStep: 1 / 120, maxSubSteps: 8 },
  origin: { rebaseDistance: 2048 },
  camera: { fov: 62, near: 0.3, far: 40000, speed: 110, boost: 5, clearance: 2.6, damping: 7, routeHeight: 7, routeSpeed: 24 },
  sky: {
    initialHour: 17.6,
    secondsPerDay: 720,
    latitude: 46,
    axialTilt: 18,
    starCount: 2600,
    environmentInterval: 8,
  },
} as const;
