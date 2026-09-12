/**
 * The palettes a visitor is allowed to be drawn in.
 *
 * `hello` carries a palette string straight off the wire, and it ends up in every other
 * visitor's `Presence` and from there into a CSS custom property. An allowlist is the whole
 * defence: without it this is a string a stranger chose being handed to everyone else's
 * renderer, and "the client will sanitise it" is not a defence the client can offer on
 * behalf of other clients.
 *
 * This array is the single source of truth, not a mirror of one. The UI slice imports it
 * rather than keeping its own copy, because a server allowlist and a client picker that
 * drift apart fail in the most confusing possible way: a palette that exists in the menu
 * and hangs up the socket when you choose it.
 *
 * The names are the real twilight phases, which fits a sky where nothing is decorative:
 * each one is a defined solar elevation, not a mood.
 */
export const PALETTES = ["civil", "nautical", "astronomical", "night"] as const;

export type Palette = (typeof PALETTES)[number];

/** What an occupant is drawn in until they say otherwise. */
export const DEFAULT_PALETTE: Palette = "astronomical";

const ALLOWED: ReadonlySet<string> = new Set(PALETTES);

/**
 * Note the length check before the set lookup. `Set.has` on a 50 MB string is not free, and
 * the point of a validator is that the cheapest test runs first.
 */
export function isPalette(value: unknown): value is Palette {
  return typeof value === "string" && value.length <= 32 && ALLOWED.has(value);
}
