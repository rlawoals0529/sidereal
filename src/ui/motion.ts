/**
 * One answer to "does this viewer want motion", for the whole page.
 *
 * Read once and passed down, including into the renderer through `SkyOptions`. Two components
 * each calling `matchMedia` is how half a page stops animating and the other half does not, and
 * the half that keeps going is always the one nobody tested.
 *
 * For some people reduced motion is a symptom trigger rather than a taste, so the chrome's
 * answer is to remove the animation rather than to shorten it.
 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  // `matchMedia` is missing in some embedded webviews, where the safe reading is "no preference
  // expressed" rather than a thrown error on the first line of boot.
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/** Fires when the preference changes mid-session, which happens: it follows a system setting. */
export function onReducedMotionChange(fn: (reduced: boolean) => void): () => void {
  try {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const handler = (e: MediaQueryListEvent) => fn(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  } catch {
    return () => {};
  }
}
