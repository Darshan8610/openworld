export const clamp = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Frame-rate-independent exponential approach. */
export const damp = (a: number, b: number, rate: number, dt: number): number => lerp(a, b, 1 - Math.exp(-rate * dt));
export const mod = (n: number, d: number): number => ((n % d) + d) % d;
