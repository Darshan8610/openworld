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
}
export const QUALITY: Record<QualityName, QualityPreset> = {
  low: { segments: 12, rootRadius: 2, viewDistance: 6800, pixelRatio: 1, maxPixels: 1_500_000, shadows: false, shadowSize: 1024, shadowExtent: 600, workers: 2,
    vegetationDensity: 0.55, vegetationDistance: 720, grassDistance: 140, propDistance: 800, geometryDetail: 'low', ambientOcclusion: false,
    instanceBudgets: [650, 250, 900, 4000, 450, 200, 160, 500, 250, 100], propBudgets: [160, 80, 16, 32, 8, 4, 24] },
  balanced: { segments: 20, rootRadius: 2, viewDistance: 8000, pixelRatio: 1.5, maxPixels: 2_600_000, shadows: true, shadowSize: 2048, shadowExtent: 700, workers: 3,
    vegetationDensity: 0.8, vegetationDistance: 1100, grassDistance: 220, propDistance: 1300, geometryDetail: 'full', ambientOcclusion: false,
    instanceBudgets: [2200, 800, 3000, 12000, 1400, 700, 500, 1800, 900, 350], propBudgets: [400, 160, 32, 64, 16, 8, 48] },
  high: { segments: 28, rootRadius: 3, viewDistance: 11000, pixelRatio: 2, maxPixels: 4_000_000, shadows: true, shadowSize: 2048, shadowExtent: 1100, workers: 4,
    vegetationDensity: 1, vegetationDistance: 1500, grassDistance: 300, propDistance: 1900, geometryDetail: 'full', ambientOcclusion: false,
    instanceBudgets: [4000, 1400, 5000, 22000, 2400, 1200, 900, 3200, 1600, 650], propBudgets: [700, 240, 48, 96, 24, 12, 80] },
  ultra: { segments: 36, rootRadius: 3, viewDistance: 14000, pixelRatio: 2, maxPixels: 6_500_000, shadows: true, shadowSize: 4096, shadowExtent: 900, workers: 4,
    vegetationDensity: 1, vegetationDistance: 2200, grassDistance: 420, propDistance: 2600, geometryDetail: 'ultra', ambientOcclusion: true,
    instanceBudgets: [6500, 2200, 8000, 36000, 3600, 2200, 1600, 5500, 2800, 1100], propBudgets: [1100, 360, 64, 128, 40, 20, 120] },
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
  origin: { rebaseDistance: 2048 },
  /**
   * Playable character. Metres and seconds: speeds in m/s, gravity in m/s²,
   * distances in metres, angles in degrees where named `…Deg`.
   */
  character: {
    height: 1.8,
    radius: 0.34,
    eyeHeight: 1.66,
    walkSpeed: 1.7,
    jogSpeed: 4.4,
    sprintSpeed: 7.6,
    crouchSpeed: 1.15,
    backpedalSpeed: 2.4,
    strafeSpeed: 3.0,
    acceleration: 26,
    deceleration: 32,
    airAcceleration: 9,
    gravity: 24,
    jumpHeight: 1.05,
    jumpCutMultiplier: 0.48,
    stepHeight: 0.45,
    groundSnap: 0.7,
    maxSlopeDeg: 48,
    slopeSlideAcceleration: 18,
    coyoteTime: 0.11,
    jumpBufferTime: 0.14,
    swimDepth: 1.15,
    swimFeetDepth: 1.25,
    swimSpeed: 2.2,
    swimAcceleration: 7,
    swimBuoyancy: 6,
    swimDrag: 1.6,
    swimVerticalSpeed: 1.8,
    maxHorizontalStep: 0.35,
  },
  /** Third-person / first-person player camera. */
  personCamera: {
    fov: 58,
    minDistance: 1.1,
    maxDistance: 8.5,
    defaultDistance: 4.2,
    shoulderOffset: 0.55,
    pitchMin: -1.15,
    pitchMax: 0.85,
    sensitivity: 1,
    collisionRadius: 0.35,
    fovSpeedGain: 9,
    firstPersonFov: 74,
  },
  camera: { fov: 62, near: 0.3, far: 40000, speed: 110, boost: 5, clearance: 12, damping: 7, routeHeight: 7, routeSpeed: 24 },
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
