/**
 * Data-driven vehicle catalogue.
 *
 * Every entry is pure data: adding a vehicle never requires touching gameplay,
 * physics or rendering code. Suspension rates are *derived from mass* rather
 * than hand-typed, so a 1.1 t hatchback and a 14 t bus both sit at the right
 * ride height and neither bottoms out nor floats.
 */
import type {
  AeroSpec, BuoyancyPoint, DrivetrainSpec, HullSpec, RotorSpec, SailSpec, SeatSpec,
  SubmarineSpec, VehicleSpec, WheelSpec,
} from './types';

interface AxleOptions {
  /** Half the track width, metres. */
  readonly halfTrack: number;
  /** Front axle Z (positive = forward), rear axle Z (negative). */
  readonly frontZ: number;
  readonly rearZ: number;
  readonly radius: number;
  readonly mass: number;
  readonly drive: 'fwd' | 'rwd' | 'awd';
  readonly restLength: number;
  readonly travel: number;
  /** Fraction of rest length the suspension compresses under static load. */
  readonly sag?: number;
  /** Damping ratio; 1 is critically damped. Road cars run well under 1. */
  readonly zeta?: number;
  readonly gripLong?: number;
  readonly gripLat?: number;
  readonly rollingResistance?: number;
  /** Suspension attach height relative to the centre of mass. */
  readonly attachY?: number;
  readonly frontBrakeShare?: number;
}

/**
 * Build a four-wheel set, ordered FL, FR, RL, RR so the anti-roll pass can
 * pair `(i, i+1)` as one axle.
 */
function axles(options: AxleOptions): WheelSpec[] {
  const {
    halfTrack, frontZ, rearZ, radius, mass, drive, restLength, travel,
    sag = 0.34, zeta = 0.45, gripLong = 1, gripLat = 1, rollingResistance = 0.014,
    attachY = 0, frontBrakeShare = 0.62,
  } = options;
  const corner = mass / 4;
  // k chosen so static load compresses the spring by `sag` of its rest length.
  const stiffness = (corner * 9.81) / Math.max(0.02, restLength * sag);
  const damping = 2 * zeta * Math.sqrt(stiffness * corner);
  const rearBrakeShare = 1 - frontBrakeShare;

  const make = (id: string, x: number, z: number, steered: boolean, driven: boolean, brakeShare: number, handbrake: boolean): WheelSpec => ({
    id, local: { x, y: attachY, z }, radius, width: radius * 0.42,
    steered, driven, brakeShare, handbrake,
    stiffness, damping, restLength, maxTravel: travel,
    gripLong, gripLat, rollingResistance,
  });

  const frontDriven = drive !== 'rwd';
  const rearDriven = drive !== 'fwd';
  return [
    make('front-left', -halfTrack, frontZ, true, frontDriven, frontBrakeShare / 2, false),
    make('front-right', halfTrack, frontZ, true, frontDriven, frontBrakeShare / 2, false),
    make('rear-left', -halfTrack, rearZ, false, rearDriven, rearBrakeShare / 2, true),
    make('rear-right', halfTrack, rearZ, false, rearDriven, rearBrakeShare / 2, true),
  ];
}

/** Two-wheel set for motorcycles and bicycles, front first. */
function twoWheels(options: { frontZ: number; rearZ: number; radius: number; mass: number; restLength: number; travel: number; gripLong?: number; gripLat?: number; rolling?: number }): WheelSpec[] {
  const { frontZ, rearZ, radius, mass, restLength, travel, gripLong = 1.08, gripLat = 1.02, rolling = 0.012 } = options;
  const corner = mass / 2;
  const stiffness = (corner * 9.81) / Math.max(0.02, restLength * 0.3);
  const damping = 2 * 0.5 * Math.sqrt(stiffness * corner);
  const make = (id: string, z: number, steered: boolean, driven: boolean, brakeShare: number, handbrake: boolean): WheelSpec => ({
    id, local: { x: 0, y: 0, z }, radius, width: radius * 0.2,
    steered, driven, brakeShare, handbrake,
    stiffness, damping, restLength, maxTravel: travel,
    gripLong, gripLat, rollingResistance: rolling,
  });
  return [make('front', frontZ, true, false, 0.65, false), make('rear', rearZ, false, true, 0.35, true)];
}

/** Tricycle undercarriage for aircraft: nose leg first, then the main gear pair. */
function tricycleGear(options: { noseZ: number; mainZ: number; halfTrack: number; radius: number; mass: number; restLength: number; travel: number }): WheelSpec[] {
  const { noseZ, mainZ, halfTrack, radius, mass, restLength, travel } = options;
  const corner = mass / 3;
  const stiffness = (corner * 9.81) / Math.max(0.02, restLength * 0.25);
  const damping = 2 * 0.62 * Math.sqrt(stiffness * corner);
  const make = (id: string, x: number, z: number, steered: boolean, brakeShare: number): WheelSpec => ({
    id, local: { x, y: 0, z }, radius, width: radius * 0.35,
    steered, driven: false, brakeShare, handbrake: false,
    stiffness, damping, restLength, maxTravel: travel,
    gripLong: 0.95, gripLat: 0.92, rollingResistance: 0.022,
  });
  return [
    make('nose', 0, noseZ, true, 0),
    make('main-left', -halfTrack, mainZ, false, 0.5),
    make('main-right', halfTrack, mainZ, false, 0.5),
  ];
}

/** Helicopter skids: stiff, undriven, unsteered legs. */
function skids(halfTrack: number, mass: number): WheelSpec[] {
  const corner = mass / 4;
  const stiffness = (corner * 9.81) / 0.08;
  const damping = 2 * 0.85 * Math.sqrt(stiffness * corner);
  const make = (id: string, x: number, z: number): WheelSpec => ({
    id, local: { x, y: 0, z }, radius: 0.12, width: 0.1,
    steered: false, driven: false, brakeShare: 0.25, handbrake: false,
    stiffness, damping, restLength: 0.32, maxTravel: 0.14,
    gripLong: 1.4, gripLat: 1.4, rollingResistance: 0.9,
  });
  return [make('skid-fl', -halfTrack, 1.2), make('skid-fr', halfTrack, 1.2), make('skid-rl', -halfTrack, -1.2), make('skid-rr', halfTrack, -1.2)];
}

interface EngineOptions {
  readonly peakTorque: number;
  readonly peakTorqueRpm?: number;
  readonly maxRpm?: number;
  readonly gears: readonly number[];
  readonly finalDrive: number;
  readonly brakeTorque: number;
  readonly differentialLock?: number;
  readonly inertia?: number;
}

function engine(options: EngineOptions): DrivetrainSpec {
  const {
    peakTorque, peakTorqueRpm = 3400, maxRpm = 6400, gears, finalDrive,
    brakeTorque, differentialLock = 0.25, inertia = 0.42,
  } = options;
  return {
    peakTorque, peakTorqueRpm, idleRpm: 820, maxRpm, gears,
    reverseRatio: (gears[0] ?? 3.2) * 1.08, finalDrive, inertia,
    upshiftRpm: 0.88, downshiftRpm: 0.38,
    brakeTorque, handbrakeTorque: brakeTorque * 0.55,
    engineBraking: 0.34, differentialLock,
  };
}

const seat = (id: string, role: SeatSpec['role'], x: number, y: number, z: number, exitX: number): SeatSpec => ({
  id, role, local: { x, y, z }, exit: { x: exitX, y: y - 0.3, z }, eye: { x: 0, y: 0.62, z: 0.1 },
});

/** Standard two-front/two-rear cabin. */
const cabin4 = (halfWidth: number, seatY: number, frontZ: number, rearZ: number): SeatSpec[] => [
  seat('driver', 'driver', -halfWidth * 0.45, seatY, frontZ, -halfWidth - 0.65),
  seat('front-passenger', 'passenger', halfWidth * 0.45, seatY, frontZ, halfWidth + 0.65),
  seat('rear-left', 'passenger', -halfWidth * 0.45, seatY, rearZ, -halfWidth - 0.65),
  seat('rear-right', 'passenger', halfWidth * 0.45, seatY, rearZ, halfWidth + 0.65),
];

const cabin2 = (halfWidth: number, seatY: number, z: number): SeatSpec[] => [
  seat('driver', 'driver', -halfWidth * 0.42, seatY, z, -halfWidth - 0.7),
  seat('passenger', 'passenger', halfWidth * 0.42, seatY, z, halfWidth + 0.7),
];

const saddle = (): SeatSpec[] => [
  { id: 'rider', role: 'driver', local: { x: 0, y: 0.28, z: -0.08 }, exit: { x: -0.95, y: -0.2, z: 0 }, eye: { x: 0, y: 0.6, z: 0.05 } },
];

/** Box of buoyancy samples: bow/stern × port/starboard × keel. */
function hullPoints(length: number, width: number, depth: number, volume: number): BuoyancyPoint[] {
  const halfL = length * 0.42, halfW = width * 0.38;
  const share = volume / 6;
  return [
    { local: { x: -halfW, y: -depth, z: halfL }, volume: share },
    { local: { x: halfW, y: -depth, z: halfL }, volume: share },
    { local: { x: -halfW, y: -depth, z: 0 }, volume: share * 1.2 },
    { local: { x: halfW, y: -depth, z: 0 }, volume: share * 1.2 },
    { local: { x: -halfW, y: -depth, z: -halfL }, volume: share * 0.8 },
    { local: { x: halfW, y: -depth, z: -halfL }, volume: share * 0.8 },
  ];
}

/**
 * A hull must displace more than it weighs or it sinks. Displacement is sized
 * from the mass with a reserve-buoyancy factor, which is how a real hull is
 * specified.
 */
function hull(options: {
  length: number; width: number; mass: number; reserve?: number; draft?: number;
  maxThrust: number; rudder: number; planing?: number; dragForward?: number; dragLateral?: number;
}): HullSpec {
  const { length, width, mass, reserve = 2.6, draft = 0.3, maxThrust, rudder, planing = 0, dragForward = 0.8, dragLateral = 7.5 } = options;
  const volume = (mass / 1000) * reserve;
  return {
    points: hullPoints(length, width, draft, volume),
    submersionDepth: Math.max(0.25, draft * 2.2),
    dragForward, dragLateral, dragVertical: dragLateral * 1.1,
    angularDrag: 1.5,
    maxThrust, reverseFactor: 0.4,
    propeller: { x: 0, y: -draft, z: -length * 0.44 },
    rudderAuthority: rudder,
    righting: mass * 9.5,
    planing,
  };
}

const PROP_AERO = (options: { wingArea: number; maxThrust: number; mass: number; falloff?: number }): AeroSpec => ({
  wingArea: options.wingArea,
  liftZero: 0.22, liftSlope: 5.0, stallAngle: 0.29,
  dragZero: 0.031, inducedDrag: 0.055, sideSlope: 1.6,
  pitchAuthority: 0.95, rollAuthority: 0.62, yawAuthority: 0.34,
  pitchDamping: 1.5, rollDamping: 0.52, yawDamping: 0.95,
  pitchStability: 1.25, yawStability: 0.95,
  maxThrust: options.maxThrust, propeller: true, thrustFalloffSpeed: options.falloff ?? 92,
  flapLift: 0.52, flapDrag: 0.055,
  centre: { x: 0, y: 0, z: -0.22 },
});

const ROTOR = (options: { mass: number; hub: number; thrustRatio?: number }): RotorSpec => ({
  maxThrust: options.mass * 9.81 * (options.thrustRatio ?? 1.7),
  cyclicRange: 0.33, cyclicAuthority: options.mass * 1.9,
  tailAuthority: options.mass * 2.3, reactionTorque: options.mass * 0.62,
  hubHeight: options.hub, angularDamping: 0.85,
  translationalLift: 0.16, groundEffect: 0.2, groundEffectHeight: 5.5,
  dragArea: 2.4, spoolTime: 1.6,
});

const SUB: SubmarineSpec = { ballastRate: 0.3, ballastForce: 42_000, planeAuthority: 2800, maxDepth: 240 };

const SAIL: SailSpec = {
  area: 26, liftSlope: 1.25, dragZero: 0.18, noGoAngle: 0.76,
  centreHeight: 3.4, keelResistance: 2600, heelFactor: 0.6,
};

/** The shipped catalogue. Extend it with data, never with new control flow. */
export const VEHICLE_CATALOG: readonly VehicleSpec[] = [
  // ---- Road vehicles --------------------------------------------------------
  {
    key: 'hatchback', label: 'Compact Hatchback', category: 'Hatchback', vehicleClass: 'wheeled', domain: 'land',
    body: 'hatchback', mass: 1180, dimensions: { length: 3.95, width: 1.72, height: 1.46 },
    centreOfMass: { x: 0, y: -0.22, z: -0.04 }, inertiaScale: 0.86,
    seats: cabin4(0.86, 0.1, 0.42, -0.72), maxHealth: 100, fuelCapacity: 45, fuelBurn: 0.0024,
    topSpeed: 48, accent: 0xc2543f,
    wheels: axles({ halfTrack: 0.75, frontZ: 1.28, rearZ: -1.26, radius: 0.31, mass: 1180, drive: 'fwd', restLength: 0.34, travel: 0.14, attachY: -0.1 }),
    drivetrain: engine({ peakTorque: 168, gears: [3.55, 2.05, 1.38, 1.03, 0.82], finalDrive: 4.05, brakeTorque: 2200 }),
    spawn: { terrain: 'road', weight: 1.0, maxSlope: 0.3 },
  },
  {
    key: 'sedan', label: 'Touring Sedan', category: 'Sedan', vehicleClass: 'wheeled', domain: 'land',
    body: 'sedan', mass: 1460, dimensions: { length: 4.72, width: 1.82, height: 1.45 },
    centreOfMass: { x: 0, y: -0.24, z: -0.02 }, inertiaScale: 0.9,
    seats: cabin4(0.9, 0.1, 0.52, -0.86), maxHealth: 110, fuelCapacity: 58, fuelBurn: 0.0029,
    topSpeed: 56, accent: 0x33506b,
    wheels: axles({ halfTrack: 0.8, frontZ: 1.5, rearZ: -1.46, radius: 0.33, mass: 1460, drive: 'rwd', restLength: 0.34, travel: 0.15, attachY: -0.1 }),
    drivetrain: engine({ peakTorque: 285, gears: [3.4, 2.02, 1.42, 1.0, 0.78, 0.64], finalDrive: 3.46, brakeTorque: 2950 }),
    spawn: { terrain: 'road', weight: 1.0, maxSlope: 0.3 },
  },
  {
    key: 'suv', label: 'Crossover SUV', category: 'SUV', vehicleClass: 'wheeled', domain: 'land',
    body: 'suv', mass: 1980, dimensions: { length: 4.76, width: 1.95, height: 1.78 },
    centreOfMass: { x: 0, y: -0.18, z: -0.03 }, inertiaScale: 0.95,
    seats: cabin4(0.95, 0.2, 0.55, -0.9), maxHealth: 135, fuelCapacity: 70, fuelBurn: 0.0036,
    topSpeed: 52, accent: 0x44504a,
    wheels: axles({ halfTrack: 0.86, frontZ: 1.45, rearZ: -1.46, radius: 0.37, mass: 1980, drive: 'awd', restLength: 0.4, travel: 0.2, attachY: -0.08, gripLat: 0.95 }),
    drivetrain: engine({ peakTorque: 360, gears: [3.9, 2.3, 1.55, 1.12, 0.86, 0.7], finalDrive: 3.7, brakeTorque: 3600, differentialLock: 0.6 }),
    spawn: { terrain: 'road', weight: 0.9, maxSlope: 0.36 },
  },
  {
    key: 'offroad', label: 'Expedition 4x4', category: 'Off-road', vehicleClass: 'wheeled', domain: 'land',
    body: 'offroad', mass: 2240, dimensions: { length: 4.5, width: 1.98, height: 1.95 },
    centreOfMass: { x: 0, y: -0.12, z: -0.02 }, inertiaScale: 1.0,
    seats: cabin4(0.95, 0.24, 0.5, -0.85), maxHealth: 160, fuelCapacity: 80, fuelBurn: 0.0042,
    topSpeed: 42, accent: 0x7d7141,
    wheels: axles({ halfTrack: 0.9, frontZ: 1.36, rearZ: -1.38, radius: 0.44, mass: 2240, drive: 'awd', restLength: 0.52, travel: 0.3, sag: 0.3, zeta: 0.52, attachY: -0.02, gripLong: 1.1, gripLat: 0.9, rollingResistance: 0.024 }),
    drivetrain: engine({ peakTorque: 430, peakTorqueRpm: 2600, maxRpm: 5200, gears: [4.6, 2.72, 1.8, 1.3, 1.0, 0.82], finalDrive: 4.3, brakeTorque: 3900, differentialLock: 0.95 }),
    spawn: { terrain: 'pullout', weight: 0.85, maxSlope: 0.46 },
  },
  {
    key: 'pickup', label: 'Utility Pickup', category: 'Pickup', vehicleClass: 'wheeled', domain: 'land',
    body: 'pickup', mass: 2150, dimensions: { length: 5.4, width: 1.96, height: 1.86 },
    centreOfMass: { x: 0, y: -0.2, z: 0.18 }, inertiaScale: 1.05,
    seats: cabin2(0.92, 0.22, 0.6), maxHealth: 150, fuelCapacity: 76, fuelBurn: 0.0039,
    topSpeed: 46, accent: 0xb8b2a6,
    wheels: axles({ halfTrack: 0.88, frontZ: 1.62, rearZ: -1.68, radius: 0.4, mass: 2150, drive: 'rwd', restLength: 0.46, travel: 0.24, attachY: -0.05, gripLat: 0.9 }),
    drivetrain: engine({ peakTorque: 400, peakTorqueRpm: 2800, maxRpm: 5400, gears: [4.2, 2.5, 1.68, 1.22, 0.94, 0.76], finalDrive: 3.9, brakeTorque: 3500, differentialLock: 0.45 }),
    spawn: { terrain: 'pullout', weight: 0.95, maxSlope: 0.4 },
  },
  {
    key: 'van', label: 'Delivery Van', category: 'Van', vehicleClass: 'wheeled', domain: 'land',
    body: 'van', mass: 2600, dimensions: { length: 5.4, width: 2.02, height: 2.42 },
    centreOfMass: { x: 0, y: -0.1, z: -0.1 }, inertiaScale: 1.1,
    seats: cabin2(0.95, 0.42, 1.2), maxHealth: 140, fuelCapacity: 72, fuelBurn: 0.0041,
    topSpeed: 42, accent: 0xd7d3cb,
    wheels: axles({ halfTrack: 0.9, frontZ: 1.55, rearZ: -1.72, radius: 0.37, mass: 2600, drive: 'rwd', restLength: 0.4, travel: 0.18, attachY: -0.12, gripLat: 0.86 }),
    drivetrain: engine({ peakTorque: 380, peakTorqueRpm: 2400, maxRpm: 4800, gears: [4.1, 2.4, 1.6, 1.15, 0.9, 0.74], finalDrive: 3.9, brakeTorque: 3700 }),
    spawn: { terrain: 'road', weight: 0.75, maxSlope: 0.28 },
  },
  {
    key: 'truck', label: 'Heavy Haulage Truck', category: 'Heavy truck', vehicleClass: 'wheeled', domain: 'land',
    body: 'truck', mass: 9200, dimensions: { length: 7.8, width: 2.5, height: 3.3 },
    centreOfMass: { x: 0, y: -0.4, z: -0.3 }, inertiaScale: 1.2,
    seats: cabin2(1.05, 0.9, 2.3), maxHealth: 260, fuelCapacity: 300, fuelBurn: 0.011,
    topSpeed: 33, accent: 0x9c3b35,
    wheels: axles({ halfTrack: 1.08, frontZ: 2.4, rearZ: -2.3, radius: 0.52, mass: 9200, drive: 'rwd', restLength: 0.42, travel: 0.2, sag: 0.28, zeta: 0.58, attachY: -0.3, gripLat: 0.82, rollingResistance: 0.02 }),
    drivetrain: engine({ peakTorque: 1850, peakTorqueRpm: 1300, maxRpm: 2600, gears: [8.2, 5.4, 3.7, 2.6, 1.8, 1.3, 1.0, 0.78], finalDrive: 4.2, brakeTorque: 14_000, differentialLock: 0.7, inertia: 1.4 }),
    spawn: { terrain: 'road', weight: 0.45, maxSlope: 0.24 },
  },
  {
    key: 'bus', label: 'Regional Coach', category: 'Bus', vehicleClass: 'wheeled', domain: 'land',
    body: 'bus', mass: 12_400, dimensions: { length: 11.2, width: 2.55, height: 3.4 },
    centreOfMass: { x: 0, y: -0.5, z: 0 }, inertiaScale: 1.25,
    seats: [
      seat('driver', 'driver', -0.8, 0.75, 4.1, -1.7),
      seat('passenger-1', 'passenger', 0.7, 0.75, 3.2, 1.7),
      seat('passenger-2', 'passenger', -0.7, 0.75, 1.2, -1.7),
      seat('passenger-3', 'passenger', 0.7, 0.75, -0.8, 1.7),
    ],
    maxHealth: 300, fuelCapacity: 320, fuelBurn: 0.012, topSpeed: 31, accent: 0x2f6f8c,
    wheels: axles({ halfTrack: 1.1, frontZ: 3.6, rearZ: -3.3, radius: 0.52, mass: 12_400, drive: 'rwd', restLength: 0.4, travel: 0.18, sag: 0.26, zeta: 0.6, attachY: -0.45, gripLat: 0.8, rollingResistance: 0.019 }),
    drivetrain: engine({ peakTorque: 1600, peakTorqueRpm: 1250, maxRpm: 2500, gears: [7.2, 4.6, 3.1, 2.1, 1.5, 1.08, 0.82], finalDrive: 4.5, brakeTorque: 16_000, inertia: 1.5 }),
    spawn: { terrain: 'road', weight: 0.35, maxSlope: 0.22 },
  },
  {
    key: 'sports', label: 'Sports Coupé', category: 'Sports car', vehicleClass: 'wheeled', domain: 'land',
    body: 'sports', mass: 1320, dimensions: { length: 4.4, width: 1.9, height: 1.24 },
    centreOfMass: { x: 0, y: -0.34, z: -0.08 }, inertiaScale: 0.78,
    seats: cabin2(0.86, 0.02, 0.1), maxHealth: 90, fuelCapacity: 62, fuelBurn: 0.0045,
    topSpeed: 82, accent: 0xd8a32b,
    wheels: axles({ halfTrack: 0.82, frontZ: 1.4, rearZ: -1.36, radius: 0.34, mass: 1320, drive: 'rwd', restLength: 0.26, travel: 0.1, sag: 0.3, zeta: 0.58, attachY: -0.2, gripLong: 1.22, gripLat: 1.25, rollingResistance: 0.012, frontBrakeShare: 0.66 }),
    drivetrain: engine({ peakTorque: 480, peakTorqueRpm: 4600, maxRpm: 7800, gears: [3.2, 2.18, 1.6, 1.24, 1.0, 0.84, 0.7], finalDrive: 3.55, brakeTorque: 4200, differentialLock: 0.75, inertia: 0.3 }),
    spawn: { terrain: 'road', weight: 0.6, maxSlope: 0.24 },
  },
  {
    key: 'ambulance', label: 'Emergency Ambulance', category: 'Emergency', vehicleClass: 'wheeled', domain: 'land',
    body: 'van', mass: 3100, dimensions: { length: 5.9, width: 2.1, height: 2.65 },
    centreOfMass: { x: 0, y: -0.15, z: -0.1 }, inertiaScale: 1.12,
    seats: cabin2(0.98, 0.5, 1.4), maxHealth: 160, fuelCapacity: 90, fuelBurn: 0.0048,
    topSpeed: 44, accent: 0xe8e8ea,
    wheels: axles({ halfTrack: 0.92, frontZ: 1.72, rearZ: -1.86, radius: 0.39, mass: 3100, drive: 'rwd', restLength: 0.42, travel: 0.2, attachY: -0.14, gripLat: 0.88 }),
    drivetrain: engine({ peakTorque: 430, peakTorqueRpm: 2600, maxRpm: 5000, gears: [4.2, 2.5, 1.7, 1.2, 0.92, 0.75], finalDrive: 4.0, brakeTorque: 4200 }),
    spawn: { terrain: 'road', weight: 0.3, maxSlope: 0.28 },
  },
  {
    key: 'motorcycle', label: 'Trail Motorcycle', category: 'Motorcycle', vehicleClass: 'motorcycle', domain: 'land',
    body: 'motorcycle', mass: 196, dimensions: { length: 2.12, width: 0.78, height: 1.18 },
    centreOfMass: { x: 0, y: -0.1, z: 0 }, inertiaScale: 0.62,
    seats: saddle(), maxHealth: 50, fuelCapacity: 14, fuelBurn: 0.0016, topSpeed: 58, accent: 0x2e3338,
    wheels: twoWheels({ frontZ: 0.72, rearZ: -0.72, radius: 0.33, mass: 196, restLength: 0.3, travel: 0.2 }),
    drivetrain: engine({ peakTorque: 68, peakTorqueRpm: 6200, maxRpm: 10_500, gears: [2.8, 1.95, 1.5, 1.22, 1.0, 0.86], finalDrive: 3.1, brakeTorque: 760, inertia: 0.12 }),
    spawn: { terrain: 'pullout', weight: 0.8, maxSlope: 0.38 },
  },
  {
    key: 'scooter', label: 'City Scooter', category: 'Scooter', vehicleClass: 'motorcycle', domain: 'land',
    body: 'motorcycle', mass: 124, dimensions: { length: 1.86, width: 0.7, height: 1.12 },
    centreOfMass: { x: 0, y: -0.14, z: 0 }, inertiaScale: 0.6,
    seats: saddle(), maxHealth: 36, fuelCapacity: 7, fuelBurn: 0.0008, topSpeed: 24, accent: 0x5f8fa8,
    wheels: twoWheels({ frontZ: 0.62, rearZ: -0.6, radius: 0.22, mass: 124, restLength: 0.22, travel: 0.12 }),
    drivetrain: engine({ peakTorque: 18, peakTorqueRpm: 5200, maxRpm: 8200, gears: [3.4, 1.9], finalDrive: 3.4, brakeTorque: 340, inertia: 0.08 }),
    spawn: { terrain: 'road', weight: 0.5, maxSlope: 0.26 },
  },
  {
    key: 'bicycle', label: 'Touring Bicycle', category: 'Bicycle', vehicleClass: 'motorcycle', domain: 'land',
    body: 'bicycle', mass: 96, dimensions: { length: 1.76, width: 0.6, height: 1.1 },
    centreOfMass: { x: 0, y: -0.05, z: 0 }, inertiaScale: 0.55,
    seats: saddle(), maxHealth: 24, fuelCapacity: 0, fuelBurn: 0, topSpeed: 13, accent: 0x9aa7ad,
    wheels: twoWheels({ frontZ: 0.54, rearZ: -0.56, radius: 0.34, mass: 96, restLength: 0.1, travel: 0.04, gripLong: 0.95, gripLat: 0.9, rolling: 0.009 }),
    drivetrain: engine({ peakTorque: 34, peakTorqueRpm: 900, maxRpm: 2000, gears: [3.4, 2.3, 1.7, 1.25, 0.95], finalDrive: 2.6, brakeTorque: 230, inertia: 0.06 }),
    spawn: { terrain: 'pullout', weight: 0.7, maxSlope: 0.3 },
  },

  // ---- Aircraft -------------------------------------------------------------
  {
    key: 'lightplane', label: 'Light Propeller Aircraft', category: 'Propeller aircraft', vehicleClass: 'aircraft', domain: 'air',
    body: 'propplane', mass: 1060, dimensions: { length: 8.3, width: 11.0, height: 2.7 },
    centreOfMass: { x: 0, y: -0.1, z: 0 }, inertiaScale: 1.0,
    seats: cabin2(0.56, 0.1, 0.4), maxHealth: 80, fuelCapacity: 160, fuelBurn: 0.0085, topSpeed: 72, accent: 0xe4e7ea,
    wheels: tricycleGear({ noseZ: 1.5, mainZ: -0.52, halfTrack: 1.52, radius: 0.26, mass: 1060, restLength: 0.62, travel: 0.2 }),
    aero: PROP_AERO({ wingArea: 16.2, maxThrust: 3100, mass: 1060 }),
    drivetrain: engine({ peakTorque: 100, gears: [1], finalDrive: 1, brakeTorque: 1400 }),
    spawn: { terrain: 'open', weight: 0.5, maxSlope: 0.07 },
  },
  {
    key: 'jet', label: 'Light Business Jet', category: 'Jet', vehicleClass: 'aircraft', domain: 'air',
    body: 'jet', mass: 7400, dimensions: { length: 15.6, width: 16.3, height: 4.6 },
    centreOfMass: { x: 0, y: -0.2, z: 0 }, inertiaScale: 1.1,
    seats: cabin4(0.72, 0.1, 3.2, 1.2), maxHealth: 200, fuelCapacity: 2400, fuelBurn: 0.06, topSpeed: 210, accent: 0xdfe3e8,
    wheels: tricycleGear({ noseZ: 4.6, mainZ: -0.9, halfTrack: 2.4, radius: 0.34, mass: 7400, restLength: 0.9, travel: 0.3 }),
    aero: {
      wingArea: 28.5, liftZero: 0.14, liftSlope: 5.4, stallAngle: 0.26,
      dragZero: 0.021, inducedDrag: 0.042, sideSlope: 1.9,
      pitchAuthority: 1.15, rollAuthority: 0.9, yawAuthority: 0.4,
      pitchDamping: 1.9, rollDamping: 0.6, yawDamping: 1.2,
      pitchStability: 1.5, yawStability: 1.15,
      maxThrust: 23_000, propeller: false, thrustFalloffSpeed: 400,
      flapLift: 0.6, flapDrag: 0.07, centre: { x: 0, y: 0, z: -0.45 },
    },
    drivetrain: engine({ peakTorque: 100, gears: [1], finalDrive: 1, brakeTorque: 9000 }),
    spawn: { terrain: 'open', weight: 0.2, maxSlope: 0.05 },
  },
  {
    key: 'glider', label: 'High-Performance Glider', category: 'Glider', vehicleClass: 'aircraft', domain: 'air',
    body: 'glider', mass: 420, dimensions: { length: 7.0, width: 17.4, height: 1.6 },
    centreOfMass: { x: 0, y: -0.05, z: 0 }, inertiaScale: 0.95,
    seats: [seat('pilot', 'driver', 0, 0.05, 0.6, -0.9)], maxHealth: 50, fuelCapacity: 0, fuelBurn: 0, topSpeed: 62, accent: 0xf2f4f6,
    wheels: tricycleGear({ noseZ: 0.9, mainZ: -0.2, halfTrack: 0.5, radius: 0.18, mass: 420, restLength: 0.34, travel: 0.1 }),
    aero: {
      wingArea: 12.4, liftZero: 0.3, liftSlope: 5.8, stallAngle: 0.3,
      dragZero: 0.011, inducedDrag: 0.025, sideSlope: 1.4,
      pitchAuthority: 0.9, rollAuthority: 0.58, yawAuthority: 0.3,
      pitchDamping: 1.4, rollDamping: 0.5, yawDamping: 0.9,
      pitchStability: 1.1, yawStability: 0.85,
      maxThrust: 0, propeller: true, thrustFalloffSpeed: 60,
      flapLift: 0.4, flapDrag: 0.05, centre: { x: 0, y: 0, z: -0.18 },
    },
    drivetrain: engine({ peakTorque: 50, gears: [1], finalDrive: 1, brakeTorque: 500 }),
    spawn: { terrain: 'open', weight: 0.3, maxSlope: 0.06 },
  },
  {
    key: 'helicopter', label: 'Utility Helicopter', category: 'Helicopter', vehicleClass: 'helicopter', domain: 'air',
    body: 'helicopter', mass: 2400, dimensions: { length: 12.5, width: 2.6, height: 3.4 },
    centreOfMass: { x: 0, y: -0.3, z: 0 }, inertiaScale: 1.0,
    seats: cabin4(0.78, 0.1, 1.6, 0.2), maxHealth: 150, fuelCapacity: 600, fuelBurn: 0.03, topSpeed: 68, accent: 0x3c4a52,
    wheels: skids(1.05, 2400),
    rotor: ROTOR({ mass: 2400, hub: 1.75 }),
    spawn: { terrain: 'open', weight: 0.3, maxSlope: 0.12 },
  },
  {
    key: 'drone', label: 'Survey Quadrotor', category: 'Drone', vehicleClass: 'helicopter', domain: 'air',
    body: 'drone', mass: 18, dimensions: { length: 0.9, width: 0.9, height: 0.3 },
    centreOfMass: { x: 0, y: 0, z: 0 }, inertiaScale: 0.7,
    seats: [], maxHealth: 12, fuelCapacity: 20, fuelBurn: 0.02, topSpeed: 24, accent: 0x23282c,
    wheels: skids(0.3, 18),
    rotor: { ...ROTOR({ mass: 18, hub: 0.14, thrustRatio: 2.6 }), spoolTime: 0.3, angularDamping: 2.4, dragArea: 0.2, groundEffectHeight: 1.4 },
    spawn: { terrain: 'open', weight: 0.25, maxSlope: 0.3 },
  },

  // ---- Watercraft -----------------------------------------------------------
  {
    key: 'rowboat', label: 'Timber Rowboat', category: 'Rowboat', vehicleClass: 'watercraft', domain: 'water',
    body: 'rowboat', mass: 160, dimensions: { length: 3.6, width: 1.42, height: 0.72 },
    centreOfMass: { x: 0, y: -0.14, z: 0 }, inertiaScale: 0.9,
    seats: [seat('rower', 'driver', 0, 0.06, -0.2, -0.95), seat('bow', 'passenger', 0, 0.06, 0.85, 0.95)],
    maxHealth: 40, fuelCapacity: 0, fuelBurn: 0, topSpeed: 3.2, accent: 0x8a6134,
    hull: hull({ length: 3.6, width: 1.42, mass: 160, maxThrust: 420, rudder: 420, draft: 0.2, dragForward: 1.4, dragLateral: 9 }),
    spawn: { terrain: 'shore', weight: 0.9, maxSlope: 0.25 },
  },
  {
    key: 'motorboat', label: 'Cabin Motorboat', category: 'Motorboat', vehicleClass: 'watercraft', domain: 'water',
    body: 'motorboat', mass: 980, dimensions: { length: 6.4, width: 2.3, height: 1.7 },
    centreOfMass: { x: 0, y: -0.24, z: -0.1 }, inertiaScale: 0.95,
    seats: cabin2(1.0, 0.3, 0.4), maxHealth: 90, fuelCapacity: 120, fuelBurn: 0.007, topSpeed: 16, accent: 0xe6e9ec,
    hull: hull({ length: 6.4, width: 2.3, mass: 980, maxThrust: 7200, rudder: 5200, draft: 0.4, planing: 1.6 }),
    spawn: { terrain: 'shore', weight: 0.8, maxSlope: 0.2 },
  },
  {
    key: 'speedboat', label: 'Offshore Speedboat', category: 'Speedboat', vehicleClass: 'watercraft', domain: 'water',
    body: 'speedboat', mass: 1250, dimensions: { length: 7.8, width: 2.4, height: 1.5 },
    centreOfMass: { x: 0, y: -0.26, z: -0.2 }, inertiaScale: 0.88,
    seats: cabin2(1.0, 0.24, 0.2), maxHealth: 85, fuelCapacity: 180, fuelBurn: 0.012, topSpeed: 32, accent: 0xb62f3c,
    hull: hull({ length: 7.8, width: 2.4, mass: 1250, maxThrust: 18_500, rudder: 7400, draft: 0.35, planing: 3.4, dragForward: 0.55 }),
    spawn: { terrain: 'shore', weight: 0.5, maxSlope: 0.2 },
  },
  {
    key: 'jetski', label: 'Personal Watercraft', category: 'Jet ski', vehicleClass: 'watercraft', domain: 'water',
    body: 'jetski', mass: 340, dimensions: { length: 3.2, width: 1.2, height: 1.05 },
    centreOfMass: { x: 0, y: -0.14, z: -0.05 }, inertiaScale: 0.75,
    seats: saddle(), maxHealth: 40, fuelCapacity: 60, fuelBurn: 0.008, topSpeed: 26, accent: 0x1f8ab0,
    hull: hull({ length: 3.2, width: 1.2, mass: 340, maxThrust: 5400, rudder: 2600, draft: 0.22, planing: 3.0, dragForward: 0.5, dragLateral: 6 }),
    spawn: { terrain: 'shore', weight: 0.7, maxSlope: 0.25 },
  },
  {
    key: 'ferry', label: 'Passenger Ferry', category: 'Ferry', vehicleClass: 'watercraft', domain: 'water',
    body: 'ferry', mass: 48_000, dimensions: { length: 28.0, width: 8.4, height: 6.2 },
    centreOfMass: { x: 0, y: -1.2, z: 0 }, inertiaScale: 1.2,
    seats: [
      seat('helm', 'driver', -1.0, 2.4, 9.4, -4.6),
      seat('deck-1', 'passenger', 1.0, 0.9, 2.0, 4.6),
      seat('deck-2', 'passenger', -1.0, 0.9, -3.0, -4.6),
    ],
    maxHealth: 600, fuelCapacity: 4000, fuelBurn: 0.06, topSpeed: 11, accent: 0x44627a,
    hull: hull({ length: 28, width: 8.4, mass: 48_000, maxThrust: 180_000, rudder: 320_000, draft: 1.5, dragForward: 1.1, dragLateral: 14 }),
    spawn: { terrain: 'shore', weight: 0.12, maxSlope: 0.1 },
  },
  {
    key: 'sailboat', label: 'Cruising Sailboat', category: 'Sailboat', vehicleClass: 'sailboat', domain: 'water',
    body: 'sailboat', mass: 2600, dimensions: { length: 9.4, width: 3.0, height: 2.2 },
    centreOfMass: { x: 0, y: -0.9, z: 0 }, inertiaScale: 1.0,
    seats: cabin2(1.2, 0.3, -1.6), maxHealth: 110, fuelCapacity: 40, fuelBurn: 0.002, topSpeed: 9, accent: 0xf0f2f4,
    hull: hull({ length: 9.4, width: 3.0, mass: 2600, maxThrust: 3200, rudder: 14_000, draft: 0.75, dragForward: 1.0, dragLateral: 16 }),
    sail: SAIL,
    spawn: { terrain: 'shore', weight: 0.45, maxSlope: 0.18 },
  },
  {
    key: 'submarine', label: 'Research Submersible', category: 'Submarine', vehicleClass: 'submarine', domain: 'water',
    body: 'submarine', mass: 9800, dimensions: { length: 11.0, width: 2.9, height: 2.9 },
    centreOfMass: { x: 0, y: -0.35, z: 0 }, inertiaScale: 1.0,
    seats: cabin2(0.8, 0, 0.6), maxHealth: 220, fuelCapacity: 800, fuelBurn: 0.01, topSpeed: 9, accent: 0x3b4a45,
    hull: {
      ...hull({ length: 11, width: 2.9, mass: 9800, reserve: 1.08, maxThrust: 26_000, rudder: 34_000, draft: 1.2, dragForward: 1.2, dragLateral: 9 }),
      righting: 9800 * 3.2,
    },
    submarine: SUB,
    spawn: { terrain: 'shore', weight: 0.15, maxSlope: 0.15 },
  },
];

const BY_KEY = new Map<string, VehicleSpec>(VEHICLE_CATALOG.map((entry) => [entry.key, entry]));

export const vehicleSpec = (key: string): VehicleSpec | undefined => BY_KEY.get(key);

export function vehicleSpecOrThrow(key: string): VehicleSpec {
  const found = BY_KEY.get(key);
  if (!found) throw new Error(`Unknown vehicle spec "${key}"`);
  return found;
}

export const vehicleKeys = (): readonly string[] => [...BY_KEY.keys()];

/** Catalogue filtered by the terrain family the deterministic planner uses. */
export function vehiclesForTerrain(terrain: VehicleSpec['spawn']['terrain']): readonly VehicleSpec[] {
  return VEHICLE_CATALOG.filter((entry) => entry.spawn.terrain === terrain);
}
