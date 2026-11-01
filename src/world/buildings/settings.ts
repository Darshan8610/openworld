import type { QualityName } from '../../config';

export const BUILDING_SETTINGS = {
  stationSpacing: 640,
  maxFoundationRelief: 2.8,
  siteCache: 256,
  refreshSeconds: 0.4,
  interiorEnter: 26,
  interiorLeave: 42,
  collisionRange: 90,
  interactionRange: 3,
  doorSpeed: 1.7,
  maxDoorModifications: 512,
} as const;
export const BUILDING_QUALITY: Record<QualityName, { range: number; shells: number; interiors: number; lights: number }> = {
  low: { range: 1100, shells: 10, interiors: 1, lights: 1 },
  balanced: { range: 1600, shells: 18, interiors: 2, lights: 2 },
  high: { range: 2200, shells: 28, interiors: 3, lights: 3 },
  ultra: { range: 2800, shells: 36, interiors: 4, lights: 4 },
};
