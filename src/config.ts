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
  /** Radius around the player inside which water surface tiles stream. */
  waterRadius: number;
  /** Hard cap on simultaneously rendered water surface tiles. */
  waterTiles: number;
  /** Grid segments for near / mid / far water tiles. */
  waterSegments: readonly [number, number, number];
  /** Hard cap on live simulated particles (precipitation, splashes, spray). */
  particleBudget: number;
  /** Water surface shading complexity: 0 = flat shading, 1 = waves, 2 = waves + foam + sparkle. */
  waterDetail: 0 | 1 | 2;
}
export const QUALITY: Record<QualityName, QualityPreset> = {
  low: { segments: 12, rootRadius: 2, viewDistance: 6800, pixelRatio: 1, maxPixels: 1_500_000, shadows: false, shadowSize: 1024, shadowExtent: 600, workers: 2,
    vegetationDensity: 0.55, vegetationDistance: 720, grassDistance: 140, propDistance: 800, geometryDetail: 'low', ambientOcclusion: false,
    instanceBudgets: [650, 250, 900, 4000, 450, 200, 160, 500, 250, 100], propBudgets: [160, 80, 16, 32, 8, 4, 24], objectBudget: 28, physicsBodies: 20,
    waterRadius: 900, waterTiles: 24, waterSegments: [24, 12, 6], particleBudget: 900, waterDetail: 0 },
  balanced: { segments: 20, rootRadius: 2, viewDistance: 8000, pixelRatio: 1.5, maxPixels: 2_600_000, shadows: true, shadowSize: 2048, shadowExtent: 700, workers: 3,
    vegetationDensity: 0.8, vegetationDistance: 1100, grassDistance: 220, propDistance: 1300, geometryDetail: 'full', ambientOcclusion: false,
    instanceBudgets: [2200, 800, 3000, 12000, 1400, 700, 500, 1800, 900, 350], propBudgets: [400, 160, 32, 64, 16, 8, 48], objectBudget: 56, physicsBodies: 40,
    waterRadius: 1400, waterTiles: 40, waterSegments: [32, 16, 8], particleBudget: 2200, waterDetail: 1 },
  high: { segments: 28, rootRadius: 3, viewDistance: 11000, pixelRatio: 2, maxPixels: 4_000_000, shadows: true, shadowSize: 2048, shadowExtent: 1100, workers: 4,
    vegetationDensity: 1, vegetationDistance: 1500, grassDistance: 300, propDistance: 1900, geometryDetail: 'full', ambientOcclusion: false,
    instanceBudgets: [4000, 1400, 5000, 22000, 2400, 1200, 900, 3200, 1600, 650], propBudgets: [700, 240, 48, 96, 24, 12, 80], objectBudget: 88, physicsBodies: 64,
    waterRadius: 2000, waterTiles: 64, waterSegments: [48, 24, 10], particleBudget: 4200, waterDetail: 2 },
  ultra: { segments: 36, rootRadius: 3, viewDistance: 14000, pixelRatio: 2, maxPixels: 6_500_000, shadows: true, shadowSize: 4096, shadowExtent: 900, workers: 4,
    vegetationDensity: 1, vegetationDistance: 2200, grassDistance: 420, propDistance: 2600, geometryDetail: 'ultra', ambientOcclusion: true,
    instanceBudgets: [6500, 2200, 8000, 36000, 3600, 2200, 1600, 5500, 2800, 1100], propBudgets: [1100, 360, 64, 128, 40, 20, 120], objectBudget: 128, physicsBodies: 96,
    waterRadius: 2600, waterTiles: 88, waterSegments: [64, 32, 12], particleBudget: 6000, waterDetail: 2 },
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
  /**
   * Phase 4 simulation budget. The physics world runs on the same 120 Hz fixed
   * step as the simulation clock so gameplay never depends on render rate.
   */
  physics: {
    fixedStep: 1 / 120,
    maxSubSteps: 8,
    gravity: -9.81,
    /** Hard caps: the world may not create rigid bodies without bound. */
    maxBodies: 640,
    maxColliders: 1280,
    /** Physics-local frame is rebuilt by translating every body on origin shifts. */
    collisionSkin: 0.002,
    /** Streamed terrain ground colliders (heightfields) that follow the player. */
    ground: {
      radius: 430,
      minLevel: 4,
      maxTiles: 12,
      updateInterval: 0.25,
      maxRebuildMsPerFrame: 6,
    },
    debugVertexBudget: 120_000,
    stepBudgetMs: 4,
  },
  /**
   * Phase 9 hydrology. Basins sit on a coarse lattice and only flood genuine
   * depressions; rivers follow analytic corridors with a downhill floor.
   * Distances are metres, depths metres, probabilities 0..1.
   */
  water: {
    /** Lattice edge of the basin generator, metres. */
    basinCell: 3072,
    /** Fraction of cells that may contain a lake; requires a real depression. */
    lakeChance: 0.85,
    /** Fraction of cells that may contain a large basin sea. */
    seaChance: 0.035,
    lakeRadius: [200, 880] as [number, number],
    seaRadius: [820, 1900] as [number, number],
    lakeDepth: [3.5, 22] as [number, number],
    seaDepth: [26, 78] as [number, number],
    /** How full a basin is filled toward its spill point (0..1). */
    fill: 0.72,
    /** Freeboard kept below the lowest rim probe, metres. */
    freeboard: 0.8,
    /** Minimum rim-to-centre drop for a basin to hold water, metres. */
    minBasinDepth: 2.2,
    /** Bounded memo of tiles proven to contain no water. */
    dryTileLimit: 4096,
    /** A sample thinner than this is shoreline, not water. */
    minSampleDepth: 0.06,
    /** Long-lived basin descriptor cache; eviction only costs recomputation. */
    basinCacheLimit: 512,
    /** Spacing between river corridors, metres. */
    riverSpacing: 3584,
    /** Half-width of the wetted channel, metres. */
    riverHalfWidth: [6, 22] as [number, number],
    /** Depth at the thalweg, metres. */
    riverDepth: [1.1, 3.2] as [number, number],
    /** The channel floor sits this far below the monotone landform profile. */
    riverInset: 0.55,
    /** Rejection radius around a river centreline, metres. */
    riverReach: 300,
    riverWaveAmplitude: 0.09,
    pondWaveAmplitude: 0.04,
    lakeWaveAmplitude: 0.1,
    seaWaveAmplitude: 0.34,
    /** Water surface streaming tick, seconds. */
    updateInterval: 0.25,
    /** Water surface tile edge, metres. */
    tileSize: 256,
    /** Underwater fog and tint ratios relative to the surface values. */
    underwater: { fogScale: 0.12, tintR: 0.05, tintG: 0.16, tintB: 0.19 },
    /** Buoyancy constants — water density in kg/m³, drag as force per (m/s)². */
    buoyancy: { density: 1025, drag: 900, angularDrag: 6, maxBodies: 160 },
  },
  /**
   * Phase 9 weather. A front field moves through canonical space, so different
   * regions see different weather; the local state eases toward its target.
   */
  weather: {
    /** Seconds for the front field to drift one full cycle. */
    secondsPerCycle: 900,
    /** Transition half-life in seconds — weather never snaps. */
    transitionHalfLife: 45,
    /** Global wind speed range, metres per second. */
    windSpeed: [0.6, 17] as [number, number],
    /** Snow falls when the local climate temperature is below this. */
    snowTemperature: 0.42,
    rainWetnessRate: 0.35,
    dryWetnessRate: 0.02,
    snowCoverRate: 0.02,
    snowMeltRate: 0.03,
  },
  /** Phase 9 particles. Bounded pool, distance-faded, wind-driven. */
  particles: {
    /** Hard pool size per quality preset is `QUALITY[q].particleBudget`. */
    maxEmitters: 48,
    /** Precipitation volume that follows the player, metres. */
    precipitationBox: 46,
    precipitationHeight: 26,
    splashLifetime: 1.6,
    updateInterval: 1 / 60,
  },
  /**
   * Entity streaming distances and population caps. Level 0 is full fidelity;
   * level 3 is data-only and has no visual representation.
   */
  entities: {
    cellSize: 64,
    fullDistance: 90,
    reducedDistance: 280,
    backgroundDistance: 950,
    maxFull: 24,
    maxReduced: 72,
    maxBackground: 320,
  },
} as const;
