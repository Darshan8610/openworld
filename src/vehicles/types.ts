/**
 * Phase 10 — shared vehicle contract.
 *
 * One identity/state/seat/damage model for every vehicle in the world, and a
 * single control structure. Specialised physics lives behind `VehicleController`
 * so a car never borrows aircraft aerodynamics and a boat never borrows road
 * friction. Every distance is metres, mass kilograms, force newtons, torque
 * newton-metres, angle radians, time seconds.
 */
import type { WorldPoint } from '../core/coordinates';
import type { SurfaceKind } from '../physics/surfaces';

/** Medium the vehicle is designed to operate in. */
export const VEHICLE_DOMAINS = ['land', 'air', 'water'] as const;
export type VehicleDomain = typeof VEHICLE_DOMAINS[number];

/**
 * Physics controller family. Each one is a distinct movement model; this is the
 * discriminator the factory switches on.
 */
export const VEHICLE_CLASSES = [
  'wheeled', 'motorcycle', 'aircraft', 'helicopter', 'watercraft', 'sailboat', 'submarine',
] as const;
export type VehicleClass = typeof VEHICLE_CLASSES[number];

/** Body silhouette used by the procedural geometry builder. */
export const VEHICLE_BODIES = [
  'hatchback', 'sedan', 'suv', 'pickup', 'van', 'truck', 'bus', 'sports', 'offroad',
  'motorcycle', 'bicycle', 'propplane', 'jet', 'glider', 'helicopter', 'drone',
  'rowboat', 'motorboat', 'speedboat', 'sailboat', 'ferry', 'jetski', 'submarine',
] as const;
export type VehicleBodyShape = typeof VEHICLE_BODIES[number];

export type SeatRole = 'driver' | 'passenger';

export interface SeatSpec {
  readonly id: string;
  readonly role: SeatRole;
  /** Seat anchor in body-local metres (x right, y up, z forward). */
  readonly local: WorldPoint;
  /** Where an occupant is placed when leaving, body-local. */
  readonly exit: WorldPoint;
  /** Eye offset from the seat anchor for the cockpit camera. */
  readonly eye?: WorldPoint;
}

export interface WheelSpec {
  readonly id: string;
  /** Suspension top attachment, body-local. */
  readonly local: WorldPoint;
  readonly radius: number;
  readonly width: number;
  readonly steered: boolean;
  readonly driven: boolean;
  /** Fraction of total brake torque applied here (0..1). */
  readonly brakeShare: number;
  /** Handbrake acts on these wheels only. */
  readonly handbrake: boolean;
  /** Suspension spring rate, N/m. */
  readonly stiffness: number;
  /** Suspension damper rate, N·s/m. */
  readonly damping: number;
  /** Relaxed spring length, metres. */
  readonly restLength: number;
  /** Maximum additional extension beyond rest before the ray misses, metres. */
  readonly maxTravel: number;
  /** Peak longitudinal grip multiplier for this axle. */
  readonly gripLong: number;
  /** Peak lateral grip multiplier for this axle. */
  readonly gripLat: number;
  /** Non-driven gear legs (aircraft) still steer/brake but take no engine torque. */
  readonly rollingResistance: number;
}

export interface DrivetrainSpec {
  /** Peak crank torque, N·m. */
  readonly peakTorque: number;
  /** Engine speed of peak torque, rev/min. */
  readonly peakTorqueRpm: number;
  readonly idleRpm: number;
  readonly maxRpm: number;
  /** Forward gear ratios, low to high. */
  readonly gears: readonly number[];
  readonly reverseRatio: number;
  readonly finalDrive: number;
  /** Rotational inertia of engine + driveline, kg·m². */
  readonly inertia: number;
  /** Upshift / downshift thresholds as a fraction of maxRpm. */
  readonly upshiftRpm: number;
  readonly downshiftRpm: number;
  /** Service brake torque at the wheels, N·m. */
  readonly brakeTorque: number;
  readonly handbrakeTorque: number;
  /** Engine braking coefficient. */
  readonly engineBraking: number;
  /** 0 = open differential, 1 = fully locked. */
  readonly differentialLock: number;
}

export interface AeroSpec {
  /** Reference wing area, m². */
  readonly wingArea: number;
  /** Zero-angle lift coefficient. */
  readonly liftZero: number;
  /** Lift-curve slope, per radian. */
  readonly liftSlope: number;
  /** Angle of attack where the wing stalls, radians. */
  readonly stallAngle: number;
  /** Parasitic drag coefficient. */
  readonly dragZero: number;
  /** Induced-drag factor (k in CD = CD0 + k·CL²). */
  readonly inducedDrag: number;
  /** Lateral (sideslip) force coefficient per radian. */
  readonly sideSlope: number;
  /** Control authority per unit dynamic pressure and area: pitch, roll, yaw. */
  readonly pitchAuthority: number;
  readonly rollAuthority: number;
  readonly yawAuthority: number;
  /** Aerodynamic damping about each body axis. */
  readonly pitchDamping: number;
  readonly rollDamping: number;
  readonly yawDamping: number;
  /**
   * Angle of attack the tailplane trims to with the stick centred, radians.
   * Without this an aircraft restores to zero AoA, where the wing cannot
   * generate enough lift to carry its own weight, and every aircraft mushes
   * into a permanent descent.
   */
  readonly trimAngle: number;
  /** Weathervane stability: restoring moment toward the trimmed attitude. */
  readonly pitchStability: number;
  readonly yawStability: number;
  /** Maximum thrust, newtons. */
  readonly maxThrust: number;
  /**
   * Propellers lose thrust with airspeed; jets barely do.
   * Thrust is scaled by max(0, 1 - speed/thrustFalloffSpeed) for propellers.
   */
  readonly propeller: boolean;
  readonly thrustFalloffSpeed: number;
  /** Extra lift and drag at full flap. */
  readonly flapLift: number;
  readonly flapDrag: number;
  /** Aerodynamic centre offset from the centre of mass, body-local. */
  readonly centre: WorldPoint;
}

export interface RotorSpec {
  /** Maximum main-rotor thrust at full collective, newtons. */
  readonly maxThrust: number;
  /** Rotor disc tilt authority from cyclic, radians. */
  readonly cyclicRange: number;
  /** Control torque per unit cyclic, N·m. */
  readonly cyclicAuthority: number;
  /** Tail-rotor yaw torque at full pedal, N·m. */
  readonly tailAuthority: number;
  /** Main-rotor reaction torque at full collective, N·m. */
  readonly reactionTorque: number;
  /** Rotor hub offset above the centre of mass, metres. */
  readonly hubHeight: number;
  /** Body-axis angular damping. */
  readonly angularDamping: number;
  /** Translational-lift gain at cruise airspeed. */
  readonly translationalLift: number;
  /** Ground-effect thrust gain, fades out above `groundEffectHeight`. */
  readonly groundEffect: number;
  readonly groundEffectHeight: number;
  /** Parasitic drag area, m². */
  readonly dragArea: number;
  /**
   * Drag area presented to vertical flow, m². Much larger than the axial area
   * — it is the fuselage plan view plus the rotor's own download — and it is
   * what limits a helicopter's climb and descent rate to sane figures.
   */
  readonly verticalDragArea: number;
  /** Rotor spin-up time constant, seconds. */
  readonly spoolTime: number;
}

export interface BuoyancyPoint {
  /** Sample position, body-local. */
  readonly local: WorldPoint;
  /** Displaced volume attributed to this point at full submersion, m³. */
  readonly volume: number;
}

export interface HullSpec {
  /** Displacement sample points. Their volumes should sum to the hull volume. */
  readonly points: readonly BuoyancyPoint[];
  /** Vertical distance from the sample plane over which submersion ramps, metres. */
  readonly submersionDepth: number;
  /** Quadratic drag areas along body forward / right / up, m². */
  readonly dragForward: number;
  readonly dragLateral: number;
  readonly dragVertical: number;
  /** Angular drag about body axes in water. */
  readonly angularDrag: number;
  /** Maximum propeller thrust, newtons. */
  readonly maxThrust: number;
  /** Reverse thrust as a fraction of forward. */
  readonly reverseFactor: number;
  /** Propeller position, body-local — thrust only applies while submerged. */
  readonly propeller: WorldPoint;
  /** Rudder yaw torque per m/s of flow at full deflection, N·m·s/m. */
  readonly rudderAuthority: number;
  /** Righting moment that keeps the hull upright, N·m per radian of heel. */
  readonly righting: number;
  /** Planing lift gain for fast hulls (0 for displacement hulls). */
  readonly planing: number;
}

export interface SailSpec {
  /** Sail area, m². */
  readonly area: number;
  /** Lift coefficient slope against apparent-wind angle. */
  readonly liftSlope: number;
  readonly dragZero: number;
  /** Closest sailable angle to the true wind, radians (the no-go zone). */
  readonly noGoAngle: number;
  /** Centre of effort above the waterline, metres. */
  readonly centreHeight: number;
  /** Keel lateral resistance, N·s/m. */
  readonly keelResistance: number;
  /** Heeling response; higher heels more in a gust. */
  readonly heelFactor: number;
}

export interface SubmarineSpec {
  /** Ballast change rate, fraction per second. */
  readonly ballastRate: number;
  /** Net vertical force swing between empty and full ballast, newtons. */
  readonly ballastForce: number;
  /** Dive-plane pitch authority per m/s of flow, N·m·s/m. */
  readonly planeAuthority: number;
  /** Maximum safe depth, metres below the surface. */
  readonly maxDepth: number;
}

export interface VehicleDimensions {
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

export interface VehicleSpec {
  readonly key: string;
  readonly label: string;
  readonly category: string;
  readonly vehicleClass: VehicleClass;
  readonly domain: VehicleDomain;
  readonly body: VehicleBodyShape;
  readonly mass: number;
  readonly dimensions: VehicleDimensions;
  /** Centre of mass relative to the geometric centre, body-local. */
  readonly centreOfMass: WorldPoint;
  /** Scales the box inertia tensor; < 1 makes the vehicle more eager to rotate. */
  readonly inertiaScale: number;
  readonly seats: readonly SeatSpec[];
  /** Structural health in arbitrary points; impacts subtract from it. */
  readonly maxHealth: number;
  /** Litres (or kWh); drained by the throttle. */
  readonly fuelCapacity: number;
  /** Fuel burn at full throttle, units per second. */
  readonly fuelBurn: number;
  /** Top speed used by the HUD and by streaming priority, m/s. */
  readonly topSpeed: number;
  readonly accent: number;
  readonly wheels?: readonly WheelSpec[];
  readonly drivetrain?: DrivetrainSpec;
  readonly aero?: AeroSpec;
  readonly rotor?: RotorSpec;
  readonly hull?: HullSpec;
  readonly sail?: SailSpec;
  readonly submarine?: SubmarineSpec;
  /** Where the deterministic planner may place this vehicle. */
  readonly spawn: VehicleSpawnRule;
}

export interface VehicleSpawnRule {
  /** `road` = carriageway/pullout, `shore` = water margin, `open` = flat ground. */
  readonly terrain: 'road' | 'pullout' | 'shore' | 'open';
  /** Relative placement weight within its terrain group. */
  readonly weight: number;
  /** Maximum ground slope (0..1) the planner will accept. */
  readonly maxSlope: number;
}

/**
 * One control structure for every class. A controller reads only the axes that
 * are meaningful for it, so the input mapper never needs to know what it drives.
 * All axes are normalised; -1..1 for bidirectional, 0..1 for unidirectional.
 */
export interface VehicleControlInput {
  throttle: number;
  brake: number;
  /** Steering / aileron-equivalent for ground and surface craft. */
  steer: number;
  handbrake: number;
  /** Elevator, helicopter fore-aft cyclic, submarine dive planes. */
  pitch: number;
  /** Ailerons, helicopter lateral cyclic. */
  roll: number;
  /** Rudder, helicopter pedals. */
  yaw: number;
  /** Helicopter collective, 0..1. */
  collective: number;
  /** Flap setting, 0..1. */
  flaps: number;
  /** Submarine ballast demand: -1 blow (rise), +1 flood (dive). */
  ballast: number;
  reverse: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  /** Request automatic gearbox; false drives the sequential gears manually. */
  automatic: boolean;
  /** Landing gear / retractable foils extended. */
  gearDown: boolean;
  /**
   * Engine running. Cleared when the tank is dry or the vehicle is wrecked: a
   * dead engine makes no torque, reads zero rpm and still drags on the
   * driveline, which is why it is an input rather than a derived flag.
   */
  ignition: boolean;
}

export const neutralControls = (): VehicleControlInput => ({
  ignition: true,
  throttle: 0, brake: 0, steer: 0, handbrake: 0, pitch: 0, roll: 0, yaw: 0,
  collective: 0, flaps: 0, ballast: 0, reverse: false, shiftUp: false, shiftDown: false,
  automatic: true, gearDown: true,
});

/** Ground answer the controllers need; mirrors `WorldQueries.groundFast`. */
export interface VehicleGroundSample {
  height: number;
  nx: number;
  ny: number;
  nz: number;
  surface: SurfaceKind;
}

/**
 * Water answer. Phase 9 owns the water bodies; Phase 10 consumes this interface
 * and ships a null provider, so watercraft physics is complete and testable
 * before any lake exists. `undefined` means "no water at this position".
 */
export interface VehicleWaterSample {
  /** Canonical world Y of the water surface. */
  surfaceY: number;
  /** Surface normal — wave slope once Phase 9 supplies real waves. */
  nx: number;
  ny: number;
  nz: number;
  /** Current/flow velocity in m/s. */
  flowX: number;
  flowZ: number;
  /** Depth from the surface to the bed, metres. */
  depth: number;
}
export type VehicleWaterProvider = (x: number, z: number) => VehicleWaterSample | undefined;

/** Real null provider: there is no water until Phase 9 lands one. */
export const NO_VEHICLE_WATER: VehicleWaterProvider = () => undefined;

/** Everything a controller may read about the world during a fixed step. */
export interface VehicleEnvironment {
  readonly gravity: number;
  /** Canonical ground sample. */
  ground(x: number, z: number, out: VehicleGroundSample): VehicleGroundSample;
  /** Water at a canonical XZ, or undefined where there is none. */
  water(x: number, z: number): VehicleWaterSample | undefined;
  /** Air density at an altitude, kg/m³. */
  airDensity(altitudeY: number): number;
  /** Ambient wind in canonical world metres per second. */
  readonly wind: WorldPoint;
}

/** Live telemetry: HUD, audio, effects and persistence all read this. */
export interface VehicleTelemetry {
  /** Ground speed, m/s. */
  speed: number;
  /** Signed forward speed, m/s (negative when reversing). */
  forwardSpeed: number;
  engineRpm: number;
  /** -1 reverse, 0 neutral, 1..n forward. */
  gear: number;
  /** 0..1 engine load for audio. */
  load: number;
  /** Fraction of wheels touching the ground. */
  grounded: number;
  /** Worst tyre saturation, 0..1 — drives skid audio and tyre smoke. */
  slip: number;
  /** Dominant surface under the contact patches. */
  surface: SurfaceKind;
  /** True airspeed, m/s. */
  airspeed: number;
  /** Angle of attack, radians. */
  angleOfAttack: number;
  /** Vertical speed, m/s. */
  verticalSpeed: number;
  /** Height above the terrain or water surface, metres. */
  altitude: number;
  stalled: boolean;
  /** Main-rotor fraction of nominal speed, 0..1. */
  rotorRpm: number;
  /** Fraction of the hull below the waterline, 0..1. */
  submersion: number;
  /** Metres below the surface for submarines. */
  depth: number;
  /** Apparent wind angle for sailing, radians. */
  apparentWind: number;
  inWater: boolean;
}

export const blankTelemetry = (): VehicleTelemetry => ({
  speed: 0, forwardSpeed: 0, engineRpm: 0, gear: 0, load: 0, grounded: 0, slip: 0,
  surface: 'grass', airspeed: 0, angleOfAttack: 0, verticalSpeed: 0, altitude: 0,
  stalled: false, rotorRpm: 0, submersion: 0, depth: 0, apparentWind: 0, inWater: false,
});
