/**
 * What a light was, in words. The honesty surface of the whole project.
 *
 * One rule governs this file and it is worth stating before any of the code: **a coordinate
 * this project inferred must never be printable without the sentence that says it was
 * inferred.** That is why there is no `coords` field on the model for a view to pick up and
 * render on its own. The latitude and longitude exist only inside `placement.sentence`, welded
 * to the caveat, so the only way to show the numbers is to show the caveat with them.
 *
 * The temptation this closes off is real and small: a tidy "Location" row in the panel, filled
 * from `event.lat` and `event.lon`, reading identically for an earthquake the USGS measured and
 * for a Wikipedia edit we placed by its language edition's region. One of those is a
 * measurement. The other is a guess about a continent. A row that renders them the same way is
 * a lie with a nice font.
 *
 * `evidenceLines` is the single place that decides what is said, and both the panel and the
 * accessible name of the keyboard list are built from it, so a sighted reader and a screen
 * reader get the same claims.
 */
import type { EventKind, SkyEvent } from "../shared/event.ts";
import { localClock, relativeTime } from "./time.ts";

/** What the feed actually is, in the words a stranger would use. Never abbreviated to a code. */
const KIND_LABEL: Record<EventKind, string> = {
  edit: "Wikipedia edit",
  quake: "Earthquake",
  orbit: "ISS",
  aurora: "Aurora",
};

/**
 * What `magnitude` means for this kind, quoted from the normalizer contract in
 * `shared/event.ts` rather than reworded here.
 *
 * The wire carries the normalised 0..1 and not the raw figure, so this page cannot print
 * "1,240 bytes changed" however much better that would read. Saying which fixed curve produced
 * the number is the most it can honestly say, and inventing the raw value back out of it would
 * be the same class of mistake as the placement one.
 */
const BRIGHTNESS_FROM: Record<EventKind, string> = {
  edit: "bytes changed, clamped",
  quake: "Richter through a fixed curve",
  orbit: "always 1, the ISS is the ISS",
  aurora: "OVATION probability at this cell",
};

/** Why this kind has no measured position. Only reached when `placement` is `regional`. */
const WHY_REGIONAL: Record<EventKind, string> = {
  edit: "A Wikipedia edit carries no position, so the language edition's primary region stands in.",
  quake: "The feed gave a region for this one rather than an epicentre.",
  orbit: "The feed gave a region rather than a track position.",
  aurora: "The feed gave a region rather than a cell centre.",
};

export type Placement = {
  measured: boolean;
  /** Two words, so the distinction survives being skimmed. */
  heading: string;
  /** Carries the coordinates AND the caveat. They are not separable on purpose. */
  sentence: string;
};

export type Evidence = {
  label: string;
  kind: EventKind;
  kindLabel: string;
  source: string;
  /** Local wall clock of when it happened in the world, with the word "local" alongside. */
  clock: string;
  relative: string;
  placement: Placement;
  brightness: string;
};

/** `50.4500 N, 30.5200 E`. Hemispheres rather than signs: a minus sign is one character away
 *  from being read as a hyphen in a list of two numbers. */
export function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)} ${ns}, ${Math.abs(lon).toFixed(4)} ${ew}`;
}

export function describeEvent(event: SkyEvent, serverNow: number): Evidence {
  const coords = formatCoords(event.lat, event.lon);
  const placement: Placement = event.placement === "measured"
    ? {
        measured: true,
        heading: "Measured position",
        sentence: `${coords}, as reported by ${event.source}.`,
      }
    : {
        measured: false,
        heading: "Regional placement",
        sentence: `${coords} is a region, not a measurement of where this happened. ${WHY_REGIONAL[event.kind]}`,
      };

  return {
    label: event.label,
    kind: event.kind,
    kindLabel: KIND_LABEL[event.kind],
    source: event.source,
    clock: `${localClock(event.at)} local`,
    relative: relativeTime(event.at, serverNow),
    placement,
    brightness: `Brightness ${event.magnitude.toFixed(2)} of 1, from ${BRIGHTNESS_FROM[event.kind]}`,
  };
}

/**
 * Every claim the panel makes, in order.
 *
 * A list rather than a template, so the visible panel and the flattened text the tests read
 * cannot drift apart, and so a test can assert a property over ALL rows at once: no row
 * carrying coordinates without the words that qualify them.
 *
 * `id` exists so the view can find the placement row without matching on its heading text.
 */
export type EvidenceRow = {
  id: "label" | "feed" | "when" | "placement" | "brightness";
  key: string;
  value: string;
};

export function evidenceRows(e: Evidence): EvidenceRow[] {
  return [
    { id: "label", key: "Event", value: e.label },
    { id: "feed", key: "Feed", value: `${e.kindLabel} via ${e.source}` },
    { id: "when", key: "Happened", value: `${e.clock}, ${e.relative}` },
    { id: "placement", key: e.placement.heading, value: e.placement.sentence },
    { id: "brightness", key: "Brightness", value: e.brightness },
  ];
}

/** The same claims as plain text, for assertions and for anything that cannot render rows. */
export const evidenceLines = (e: Evidence): string[] =>
  evidenceRows(e).map((r) => `${r.key}. ${r.value}`);

/**
 * The accessible name of one entry in the keyboard list.
 *
 * Short, because it is read on every arrow-key press, and the panel carries the rest.
 *
 * The placement word is in here anyway, and that duplication is deliberate. The evidence panel
 * is not a live region: it is also driven by the pointer, and a live region fed by hover over a
 * sky taking a hundred events a second would talk over itself forever. So a listener reaches
 * the panel's detail through the panel, and the one fact they must never have to go and ask
 * for is carried on the control itself.
 */
export function announce(e: Evidence): string {
  const how = e.placement.measured ? "measured position" : "regional placement";
  return `${e.label}. ${e.kindLabel}, ${how}, ${e.relative}.`;
}

/**
 * The masthead's one line about the newest light.
 *
 * The same facts in a shape that survives being read in under a second: what, from whom, when,
 * and whether it is a measurement. Dropping the last of those to save room is the whole failure
 * mode this project exists to avoid, so it is the one part that has no short form.
 */
export function headline(e: Evidence): string {
  const how = e.placement.measured ? "measured" : "regional";
  return `${e.label}. ${e.source}, ${e.relative}, ${how}.`;
}
