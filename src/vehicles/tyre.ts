/**
 * Tyre force model.
 *
 * A reduced Pacejka "magic formula" gives a real slip curve: force rises
 * steeply with slip, peaks just past the linear region, then falls away into
 * the sliding regime. That falloff is what makes a car break traction and
 * recover rather than behave like a velocity clamp, and it is why longitudinal
 * and lateral forces must be combined through a friction ellipse instead of
 * being applied independently.
 *
 * Surface grip comes from the shared `physics/surfaces` table, so asphalt, snow
 * and ice differ here for exactly the same reason footsteps and props differ.
 */
import { gripFor } from '../physics/surfaces';
import type { SurfaceKind } from '../physics/surfaces';

export interface TyreCoefficients {
  /** Stiffness factor. */
  readonly b: number;
  /** Shape factor. */
  readonly c: number;
  /** Curvature factor (0..1); higher drops more force after the peak. */
  readonly e: number;
}

/**
 * Coefficients are chosen so the curve peaks where a real tyre does — about
 * 14 % slip ratio longitudinally and about 9° of slip angle laterally — and
 * then falls to roughly 70 % of peak in full slide. `c` sets the asymptote and
 * `e` sets where the peak lands; both matter, which is why they are tuned
 * together rather than copied from a textbook table in different units.
 */
export const LONGITUDINAL: TyreCoefficients = { b: 11, c: 1.75, e: 0.53 };
export const LATERAL: TyreCoefficients = { b: 9.2, c: 1.75, e: 0.44 };

/**
 * Normalised force (−1..~1) for a slip input. `slip` is a slip ratio for the
 * longitudinal case and a slip angle in radians for the lateral case.
 */
export function magicFormula(slip: number, coefficients: TyreCoefficients): number {
  const { b, c, e } = coefficients;
  const bs = b * slip;
  return Math.sin(c * Math.atan(bs - e * (bs - Math.atan(bs))));
}

export interface TyreInput {
  /** Normal load on the contact patch, newtons. */
  readonly load: number;
  /** Wheel-plane forward velocity of the contact patch, m/s. */
  readonly longitudinalSpeed: number;
  /** Wheel-plane lateral velocity of the contact patch, m/s. */
  readonly lateralSpeed: number;
  /** Wheel rim speed ωR, m/s. */
  readonly rimSpeed: number;
  readonly surface: SurfaceKind;
  /** Per-axle peak grip multipliers. */
  readonly gripLong: number;
  readonly gripLat: number;
}

export interface TyreForces {
  /** Force along the wheel plane, newtons (positive = accelerating). */
  longitudinal: number;
  /** Force across the wheel plane, newtons (positive = toward wheel right). */
  lateral: number;
  /** Slip ratio actually used. */
  slipRatio: number;
  /** Slip angle actually used, radians. */
  slipAngle: number;
  /** 0..1 saturation of the friction ellipse; ≥ 1 means the tyre is sliding. */
  saturation: number;
}

export const blankTyreForces = (): TyreForces => ({
  longitudinal: 0, lateral: 0, slipRatio: 0, slipAngle: 0, saturation: 0,
});

/** Below this the slip definitions are singular, so they are blended out. */
const LOW_SPEED = 2.2;

/**
 * Solve one contact patch. The low-speed region blends toward a pseudo-static
 * formulation so a stationary vehicle does not produce infinite slip, which is
 * the classic failure mode of a naive slip-ratio implementation.
 */
export function solveTyre(input: TyreInput, out: TyreForces = blankTyreForces()): TyreForces {
  const { load, longitudinalSpeed, lateralSpeed, rimSpeed, surface } = input;
  if (load <= 0) {
    out.longitudinal = 0; out.lateral = 0; out.slipRatio = 0; out.slipAngle = 0; out.saturation = 0;
    return out;
  }
  const speed = Math.hypot(longitudinalSpeed, lateralSpeed);
  const reference = Math.max(Math.abs(longitudinalSpeed), LOW_SPEED);

  const slipRatio = (rimSpeed - longitudinalSpeed) / reference;
  const slipAngle = Math.atan2(-lateralSpeed, reference);

  // Surface grip from the shared material table, so tyres, feet and props agree.
  const base = gripFor(surface, speed);
  const peakLong = load * base * input.gripLong;
  const peakLat = load * base * input.gripLat;

  let fx = magicFormula(slipRatio, LONGITUDINAL) * peakLong;
  let fy = magicFormula(slipAngle, LATERAL) * peakLat;

  // Friction ellipse: a tyre cannot deliver peak braking and peak cornering at once.
  const nx = peakLong > 0 ? fx / peakLong : 0;
  const ny = peakLat > 0 ? fy / peakLat : 0;
  const saturation = Math.hypot(nx, ny);
  if (saturation > 1) {
    fx /= saturation;
    fy /= saturation;
  }

  out.longitudinal = fx;
  out.lateral = fy;
  out.slipRatio = slipRatio;
  out.slipAngle = slipAngle;
  out.saturation = saturation;
  return out;
}
