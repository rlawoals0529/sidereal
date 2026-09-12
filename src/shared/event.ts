/**
 * The one shape every feed is normalized into, and the reason there is only one.
 *
 * Four sources with four schemas would mean four renderers, and a renderer per source is
 * how a sky ends up looking like four skies. Normalizing at the edge of the system means
 * the sky code knows about `SkyEvent` and nothing else, and adding a fifth feed is a new
 * normalizer rather than a new branch in the hot loop.
 *
 * Every field here is something the source actually told us. There is no field for
 * anything we inferred, which is deliberate: see `place` for the one case where we do
 * infer, and how it is kept honest.
 */

/** What kind of real-world thing happened. The renderer switches on this and nothing else. */
export type EventKind = "edit" | "quake" | "orbit" | "aurora";

/**
 * How a coordinate was arrived at.
 *
 * `measured` means the source gave us this latitude and longitude for this event.
 * `regional` means we placed it by something coarser that we do know, and the UI must say
 * so when asked. A Wikipedia edit has no location; its wiki's primary region is real
 * metadata about the wiki, and calling that the editor's position would be a lie printed
 * in pixels.
 */
export type Placement = "measured" | "regional";

export type SkyEvent = {
  /** Stable id from the source where one exists, so a replayed batch cannot double-render. */
  id: string;
  kind: EventKind;
  /** When it happened in the world, epoch ms. Not when we received it. */
  at: number;
  lat: number;
  lon: number;
  placement: Placement;
  /**
   * 0..1, and its meaning is per-kind and documented in that kind's normalizer:
   * quake  - Richter mapped through a fixed curve, not rescaled to the current window
   * edit   - bytes changed, clamped
   * orbit  - always 1, the ISS is the ISS
   * aurora - OVATION probability at that cell
   *
   * Fixed curves, never relative to the batch. A magnitude that means something different
   * depending on what else arrived is a magnitude that means nothing.
   */
  magnitude: number;
  /** What it actually was, in words, for the panel. Never generated or embellished. */
  label: string;
  /** Which feed said so. The panel shows this; it is the evidence. */
  source: string;
};
