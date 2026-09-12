/**
 * The shared arithmetic behind every `magnitude`, and the rule all four normalizers obey.
 *
 * `magnitude` is 0..1 and each kind's curve is FIXED. None of these functions can see the
 * batch, which is the point: the obvious implementation is to find the largest value in the
 * batch and divide by it, and that produces a sky where a magnitude 3 quake is blinding on
 * a quiet night and invisible on a busy one. The same real event would render differently
 * depending on what else happened to arrive in the same tick, so the brightness would carry
 * no information about the event at all.
 *
 * Every curve below therefore takes a single measurement and a hard-coded domain. Change a
 * domain and you have changed what the sky means, which is why each one is written down
 * next to the curve that uses it.
 */

/** Bring a value into 0..1. Also the last line of defence against a NaN reaching the renderer. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Map a value from a fixed input domain onto 0..1, clamping outside it.
 *
 * The domain is an argument rather than something derived from the data on purpose. If you
 * find yourself wanting to pass `Math.max(...batch)` here, read the comment at the top of
 * this file again.
 */
export function linearOn(value: number, domainMin: number, domainMax: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp01((value - domainMin) / (domainMax - domainMin));
}
