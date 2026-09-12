/**
 * The two seams between this interface and the halves it does not own.
 *
 * The renderer lives in `src/sky/` and the realtime backend in `src/worker/`, both written by
 * someone else. Nothing in `src/ui/` imports from either. It imports from here, and the day
 * those land, integration is a matter of making one module match one file rather than a search
 * through every panel for an assumption about how the canvas works.
 *
 * The types are deliberately small. A wide port is a port that has to be re-agreed every time
 * either side changes, and the only things this interface genuinely needs from a renderer are
 * "take these events", "tell me what is under this pixel", and "ring this one".
 */
import type { EventKind, SkyEvent } from "../shared/event.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * How long a light stays in the sky, and therefore how long it stays in the keyboard list.
 *
 * This is a CONTRACT, not a preference, and it is here rather than in either half because
 * both have to hold the same answer. The register beside the canvas is how a keyboard user
 * reaches a light; if the renderer retires an event the list still shows, the list offers a
 * star that is not there, and if the renderer keeps one the list has dropped, that star is
 * unreachable without a mouse. Either way the accessibility claim is false.
 *
 * Capacity is the sharper limit of the two: a sky takes on the order of a hundred edits a
 * second, so the age limit almost never bites first.
 */
export const RETENTION = {
  /** Newest-first. The sky holds this many lights, so the list offers exactly these. */
  capacity: 64,
  /** An event older than this is gone even if the sky is quiet enough to have kept it. */
  ttlMs: 5 * 60_000,
} as const;

/** What the pointer found under a pixel. `null` is the common case: sky is mostly empty. */
export type Hit = { at: "event"; id: string } | { at: "person"; id: string } | null;

export type SkyOptions = {
  /** The yozora palette id. The renderer draws your own star in that palette's accent. */
  palette: string;
  /**
   * Passed in rather than read inside the renderer, so the whole page answers one question
   * the same way. Two components each calling matchMedia is how half a page keeps animating.
   */
  reducedMotion: boolean;
};

export type SkyHandle = {
  /** One tick of the world. Batched upstream; the renderer is free to batch again. */
  push(events: readonly SkyEvent[]): void;
  /** Ring one light so a keyboard user can see which star their cursor is on. `null` clears. */
  highlight(id: string | null): void;
  /** Canvas-relative pixels, because that is what a pointer event gives without arithmetic. */
  hitTest(x: number, y: number): Hit;
  /** Your own star ignites and holds. Everyone else's drifts. */
  setFocus(on: boolean): void;
  setPalette(palette: string): void;
  /** Where this viewer is looking, for the `look` message. Degrees. */
  look(): { az: number; alt: number };
  destroy(): void;
};

export type CreateSky = (canvas: HTMLCanvasElement, options: SkyOptions) => SkyHandle;

/**
 * A renderer that draws nothing, for the page before `src/sky/` exists.
 *
 * It reports no hits and ignites no star, which is the only honest thing a stand-in can do
 * here: the one rule of this project is that every light traces to a measured event, so a
 * placeholder that drew anything at all would be the first thing to break it.
 */
export const nullSky: CreateSky = () => ({
  push: () => {},
  highlight: () => {},
  hitTest: () => null,
  setFocus: () => {},
  setPalette: () => {},
  look: () => ({ az: 0, alt: 0 }),
  destroy: () => {},
});

export type Connection = "connecting" | "live" | "offline";

/**
 * The socket, as this interface needs it.
 *
 * Only `send`, because everything coming the other way is handed to the reducer in
 * `sky-state.ts`. A port that also exposed the raw socket would let a panel reach past the
 * reducer, and then two places would hold what the sky contains.
 */
export type SkyLink = {
  send(message: ClientMessage): void;
  close(): void;
};

export type LinkHandlers = {
  onMessage(message: ServerMessage): void;
  onStatus(status: Connection): void;
};

/**
 * A palette change after connect reaches only your own page.
 *
 * `ClientMessage` has no palette message: `hello` carries it once and there is no update. That
 * is the protocol's call, not ours, and inventing a message type here would put a shape on the
 * wire the other half has never heard of. So the change applies locally now and reaches the
 * rest of the sky on the next connect, and the picker says so rather than pretending.
 */
export const PALETTE_IS_LOCAL_UNTIL_RECONNECT = true;

/** Kinds, in the order the filter offers them. Ordered by how often they arrive. */
export const KINDS: readonly EventKind[] = ["edit", "quake", "orbit", "aurora"];
