/**
 * Everything that arrives from outside, checked before it is allowed to become state.
 *
 * Two different outsides land here and they are not equally trusted, but they are checked
 * the same way. A browser is an adversary by default. A feed normalizer is a colleague,
 * but it runs against the open internet and its bearer token is one leaked log line from
 * being someone else's, so "we trust the feeds slice" is a statement about people, not
 * about the bytes on the socket.
 *
 * The rule every function here follows: a value that fails is *rejected*, never repaired
 * into something plausible. A clamped NaN is still NaN, and a NaN that reaches the wire
 * serialises as `null` and lands in someone's renderer as a star at no position at all.
 * That bug is invisible on the server and looks like a graphics bug on the client, which
 * is why the finiteness check comes before the clamp and not after.
 */
import type { SkyEvent, EventKind, Placement } from "../shared/event.ts";
import type { ClientMessage } from "../shared/protocol.ts";
import {
  MAX_INGEST_BATCH,
  MAX_LABEL_CHARS,
  MAX_SOURCE_CHARS,
  MAX_ID_CHARS,
} from "./limits.ts";

const KINDS: ReadonlySet<string> = new Set<EventKind>(["edit", "quake", "orbit", "aurora"]);
const PLACEMENTS: ReadonlySet<string> = new Set<Placement>(["measured", "regional"]);

/** Parse a client frame. Returns null for anything that is not a well-formed message we
 *  know, which the caller ignores. Ignoring is the right answer for a malformed frame: a
 *  close would let one bad byte from a buggy client version take the visitor's sky down. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;

  switch (m["t"]) {
    case "hello":
      // The palette is deliberately not validated here. `hello` with a wrong palette is a
      // well-formed message making an unacceptable request, and the room answers it by
      // closing the socket. A message we cannot even parse is a different thing and gets
      // a different answer, so the two are kept apart.
      return typeof m["palette"] === "string" ? { t: "hello", palette: m["palette"] } : null;
    case "look":
      return typeof m["az"] === "number" && typeof m["alt"] === "number"
        ? { t: "look", az: m["az"], alt: m["alt"] }
        : null;
    case "focus":
      return typeof m["on"] === "boolean" ? { t: "focus", on: m["on"] } : null;
    default:
      return null;
  }
}

/**
 * Altitude is clamped and azimuth is wrapped, and the difference is not a detail.
 *
 * Altitude is bounded: there is no such thing as 120 degrees above the horizon, so 120 is
 * an error and the nearest legal value is the honest repair. Azimuth is cyclic: 370 degrees
 * is a real direction and it is 10, so clamping it to 360 would silently swing a visitor's
 * gaze most of the way round the sky. Clamping a cyclic quantity is a bug that only shows
 * up as someone looking the wrong way.
 */
export function clampAlt(alt: number): number {
  return Math.max(-90, Math.min(90, alt));
}

export function wrapAz(az: number): number {
  const wrapped = az % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export type IngestResult = {
  events: SkyEvent[];
  /** Rejected for being malformed or out of range. Counted, never silent. */
  rejected: number;
  /** Trimmed because the batch was longer than we accept. */
  truncated: number;
};

/**
 * Validate an ingest payload into `SkyEvent[]`.
 *
 * The batch is truncated before the per-event loop, not after, so an attacker who gets the
 * token cannot make us walk a million-element array to discover we only wanted 256 of them.
 * The bound has to come first or it is not a bound.
 */
export function validateIngest(input: unknown): IngestResult {
  if (!Array.isArray(input)) return { events: [], rejected: 0, truncated: 0 };

  const truncated = Math.max(0, input.length - MAX_INGEST_BATCH);
  const slice = truncated > 0 ? input.slice(0, MAX_INGEST_BATCH) : input;

  const events: SkyEvent[] = [];
  let rejected = 0;
  for (const candidate of slice) {
    const event = validateEvent(candidate);
    if (event) events.push(event);
    else rejected++;
  }
  return { events, rejected, truncated };
}

function validateEvent(candidate: unknown): SkyEvent | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const e = candidate as Record<string, unknown>;

  const id = e["id"];
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) return null;

  const kind = e["kind"];
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;

  const placement = e["placement"];
  if (typeof placement !== "string" || !PLACEMENTS.has(placement)) return null;

  const at = e["at"];
  const lat = e["lat"];
  const lon = e["lon"];
  const magnitude = e["magnitude"];
  if (
    typeof at !== "number" ||
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    typeof magnitude !== "number"
  ) {
    return null;
  }
  // One finiteness gate for all four. Infinity survives every range comparison you would
  // reach for otherwise, and NaN fails all of them, so neither is caught by the bounds.
  if (![at, lat, lon, magnitude].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const label = e["label"];
  const source = e["source"];
  if (typeof label !== "string" || label.length > MAX_LABEL_CHARS) return null;
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_SOURCE_CHARS) {
    return null;
  }

  return {
    id,
    kind: kind as EventKind,
    at,
    lat,
    lon,
    placement: placement as Placement,
    // Magnitude is clamped rather than rejected: `event.ts` fixes its meaning per kind
    // through a fixed curve, so an out-of-range value is a normalizer rounding past its
    // own endpoint, not a lie about what happened.
    magnitude: Math.max(0, Math.min(1, magnitude)),
    label,
    source,
  };
}
