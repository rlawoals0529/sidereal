/**
 * Key to intent, as a pure function, for the two keyboard-driven controls on this page.
 *
 * Separated from the elements so the behaviour is testable in a plain node runner: this repo
 * has no DOM in its test environment, and a keyboard contract that can only be checked by
 * hand is one that regresses silently. What is left in the DOM layer is `focus()` and
 * `preventDefault()`, which are the parts a browser suite is for.
 */

export type ListIntent =
  | { t: "move"; by: number }
  | { t: "edge"; to: "first" | "last" }
  | { t: "none" };

/**
 * Both axes move the register.
 *
 * The list is vertical on a wide screen and horizontal under 720px, and a reader should not
 * have to work out which one they are looking at before they can move. Accepting both is what
 * every real list does and it costs two map entries.
 */
export function listIntent(key: string): ListIntent {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return { t: "move", by: 1 };
    case "ArrowUp":
    case "ArrowLeft":
      return { t: "move", by: -1 };
    case "PageDown":
      return { t: "move", by: 10 };
    case "PageUp":
      return { t: "move", by: -10 };
    case "Home":
      return { t: "edge", to: "first" };
    case "End":
      return { t: "edge", to: "last" };
    default:
      return { t: "none" };
  }
}

export type PaletteIntent =
  | { t: "move"; by: number }
  | { t: "edge"; to: "first" | "last" }
  | { t: "cancel" }
  | { t: "none" };

/**
 * The palette picker is a radio group, so it wraps and Escape abandons.
 *
 * Wrapping here and not in the register is not an inconsistency: a palette list is a closed set
 * of alternatives with no meaningful first or last, which is exactly the case the radio-group
 * pattern is specified for.
 */
export function paletteIntent(key: string): PaletteIntent {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return { t: "move", by: 1 };
    case "ArrowUp":
    case "ArrowLeft":
      return { t: "move", by: -1 };
    case "Home":
      return { t: "edge", to: "first" };
    case "End":
      return { t: "edge", to: "last" };
    case "Escape":
      return { t: "cancel" };
    default:
      return { t: "none" };
  }
}

/** Wrapping index, for the radio group. Negative `by` from index 0 lands on the last option. */
export const wrap = (index: number, by: number, count: number): number =>
  count === 0 ? 0 : (((index + by) % count) + count) % count;
