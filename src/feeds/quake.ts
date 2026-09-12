/**
 * USGS earthquakes to `SkyEvent[]`. Slow deep pulses at true coordinates.
 *
 * Endpoint: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson
 * Same GeoJSON shape as every other summary window, so all_day and all_week parse here too.
 * No network in this module.
 */
import type { SkyEvent } from "../shared/event.ts";
import { linearOn } from "./curve.ts";

/**
 * The fixed Richter domain, and the argument for not compressing it further.
 *
 * Richter is already log10 of amplitude. A whole step is roughly 32 times the energy, so
 * the scale has done the compressing before we see it, and the naive reflex of taking
 * another log "because it is a magnitude" would be double-logging: it squashes M2 through
 * M8 into a narrow band and the difference between a tremor nobody felt and a disaster
 * stops being visible. The opposite reflex, mapping energy linearly, is worse in the other
 * direction. Energy goes as 10^1.5M, so on a linear energy scale a single M7 makes every
 * other quake in the window mathematically zero.
 *
 * So the curve is linear in the Richter number itself:
 *
 *     magnitude = (M + 1) / 11        clamped to 0..1
 *
 *     M -1.0   0.00     below the noise floor, and the smallest USGS publishes
 *     M  2.0   0.27     not felt
 *     M  4.5   0.50     felt, rarely damaging
 *     M  7.0   0.73     major
 *     M 10.0   1.00     larger than any instrumented earthquake
 *
 * One whole step of Richter is a fixed step of brightness, which is what the scale means
 * and roughly how brightness is perceived. The domain is -1..10 because that brackets the
 * instrumented range with nothing to spare; a M9.5, the largest ever recorded, comes out at
 * 0.95 rather than pinned at the top, so there is somewhere for a bigger one to go.
 */
const RICHTER_MIN = -1;
const RICHTER_MAX = 10;

type QuakeFeature = {
  id?: unknown;
  properties?: { mag?: unknown; place?: unknown; time?: unknown; title?: unknown; type?: unknown };
  geometry?: { coordinates?: unknown };
};

export function quakeMagnitude(richter: number): number {
  return linearOn(richter, RICHTER_MIN, RICHTER_MAX);
}

export function normalizeQuakeEvents(rawJson: string): SkyEvent[] {
  let payload: { features?: unknown };
  try {
    payload = JSON.parse(rawJson) as { features?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(payload.features)) return [];

  const events: SkyEvent[] = [];

  for (const feature of payload.features as QuakeFeature[]) {
    const props = feature.properties;
    if (props === undefined) continue;

    /**
     * This feed is not only earthquakes. USGS mixes in quarry blasts, explosions, ice
     * quakes and sonic booms under the same schema, distinguished only by
     * `properties.type`. They are real seismic measurements, so nothing about them is
     * fake, but a quarry firing on schedule is not an earthquake and drawing it as one
     * would put a nightly pulse over a mine and invite the viewer to read it as tectonic.
     */
    if (props.type !== "earthquake") continue;

    // `mag` is genuinely null on some records, usually very small or very new ones. No
    // measured magnitude means no earned brightness, so there is nothing to draw.
    if (typeof props.mag !== "number" || !Number.isFinite(props.mag)) continue;
    if (typeof props.time !== "number") continue;

    /**
     * GeoJSON is [longitude, latitude, depth]. Longitude FIRST.
     *
     * Every other API in this project, and most maps, say lat then lon, so the swap is the
     * single most likely bug in this file and it fails quietly: swapped coordinates still
     * land on the globe, still look plausible, and only read as wrong if you happen to know
     * the place name in `properties.place`. Destructured by position, on one line, so the
     * order is visible where the mistake would be made.
     */
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const [lon, lat] = coordinates as number[];
    if (typeof lon !== "number" || typeof lat !== "number") continue;

    const id = typeof feature.id === "string" ? feature.id : undefined;
    if (id === undefined) continue;

    // `title` is the string USGS itself publishes, "M 4.5 - 12 km NE of Somewhere". Using
    // it rather than composing our own keeps the panel showing the source's own wording.
    const title = typeof props.title === "string" ? props.title : undefined;
    const place = typeof props.place === "string" ? props.place : "location not given";

    events.push({
      id: `usgs:${id}`,
      kind: "quake",
      at: props.time, // already epoch ms, unlike the ISS feed. Do not multiply.
      lat,
      lon,
      placement: "measured",
      magnitude: quakeMagnitude(props.mag),
      label: title ?? `M ${props.mag} - ${place}`,
      source: "USGS earthquake feed. Epicentre coordinates as published.",
    });
  }

  return events;
}
