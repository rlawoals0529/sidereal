/**
 * NOAA OVATION to `SkyEvent[]`. The auroral band, at real intensity.
 *
 * Endpoint: https://services.swpc.noaa.gov/json/ovation_aurora_latest.json, about 900 kB,
 * refreshed roughly every five minutes. The payload is a 1 degree global grid: 360
 * longitudes by 181 latitudes, 65160 cells, each `[lon 0..359, lat -90..90, probability
 * 0..100]`. No network in this module.
 *
 * Two decisions in this file need reading before anything else: the downsampling rule, and
 * which of the payload's two timestamps ends up in `at`.
 */
import type { SkyEvent } from "../shared/event.ts";
import { linearOn } from "./curve.ts";

/**
 * The downsampling rule: 5 degree bins, keep the peak cell in each, drop the empty bins.
 *
 * 65160 cells cannot be emitted. Wikimedia runs at roughly a hundred events a second and
 * the whole sky is a few thousand lights, so one OVATION refresh emitted raw would be
 * several minutes of every other feed combined arriving in one frame, every five minutes,
 * forever. It has to come down by a large factor, and how it comes down decides what the
 * band looks like.
 *
 * Bin, rather than sample every Nth cell. Taking every fifth cell throws away four fifths
 * of the measurement and the fifth it keeps is arbitrary: the auroral oval is a narrow
 * bright arc and a stride can step straight over its centre, so the band would flicker and
 * wander between refreshes for reasons that have nothing to do with the aurora.
 *
 * 5 degrees, because the oval's bright part is several degrees wide in latitude. At 10
 * degrees the band collapses to one or two rows and stops looking like an arc. At 1 degree
 * we are back to 65160. 5 keeps the shape and gives a hard ceiling of 72 x 37 = 2664
 * events, which is the number to check against if this ever feels like too many; it is a
 * ceiling and not an estimate, since a bin cannot emit twice.
 *
 * PEAK rather than mean. This is the part that matters. A mean over a 5 x 5 block averages
 * the bright arc together with the 20-odd dark cells around it, so the strongest aurora on
 * the planet arrives as a weak smear and the number in the panel is a number NOAA never
 * published. The peak is a cell OVATION actually forecast, so the magnitude is a real
 * probability and the band keeps its edge.
 *
 * Empty bins are dropped. A bin whose peak is 0 is the forecast saying there is no aurora
 * there, and emitting it would be a light standing for nothing happening.
 *
 * The event is placed at the PEAK CELL'S OWN COORDINATES, not at the bin centre. That is
 * what lets this feed claim `placement: "measured"` honestly: the lat and lon we print are
 * a grid point NOAA published a number for. A bin centre would be a coordinate we made up,
 * and it would also be wrong at the poles, where the last latitude bin holds only lat 90
 * and its notional centre is 92.
 */
export const AURORA_BIN_DEGREES = 5;

/**
 * The probability below which a cell is not a light.
 *
 * NOAA publishes a value for most of the globe and most of it is near zero. Emitting all of it
 * put roughly 873 cells on the wire every refresh, which was about 97 per cent of everything
 * the sky ever received: earthquakes and edits were a rounding error behind a wall of identical
 * "Aurora, 1% chance of visibility" entries.
 *
 * The threshold is a display decision and it is the same kind as dropping bot edits. A one per
 * cent chance drawn as a light is not a faint truth, it is a claim of presence where the
 * measurement says there is effectively none, so leaving it out is the more honest rendering as
 * well as the more legible one.
 *
 * Two per cent, not five. Five looked tidy and cut the fixture from 873 cells to 34, which is
 * not enough to draw a band at all: the aurora is a field and needs cells to have a shape. The
 * register flooding is fixed where it belongs, by a per-kind quota in the list itself.
 *
 * It is a floor, not a cap. During a real geomagnetic storm far more cells clear it and the
 * band grows, which is exactly what should happen.
 */
export const AURORA_MIN_PERCENT = 2;

/** Human, not ISO. `2026-09-12T22:48:00Z` in a sentence is a machine talking to a person. */
function readableUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/** 360 degrees of longitude at 5 degrees per bin. */
export const AURORA_LON_BINS = 360 / AURORA_BIN_DEGREES;

/** -90..90 inclusive is 181 rows, so the last bin holds the pole alone. Hence 37, not 36. */
export const AURORA_LAT_BINS = Math.floor(180 / AURORA_BIN_DEGREES) + 1;

/** Hard ceiling on events per refresh. One bin, at most one event. */
export const AURORA_MAX_EVENTS = AURORA_LON_BINS * AURORA_LAT_BINS;

type OvationPayload = {
  "Observation Time"?: unknown;
  "Forecast Time"?: unknown;
  coordinates?: unknown;
};

/**
 * OVATION's `aurora` value is already a probability in percent, so the curve is the
 * identity divided by 100. There is nothing to shape: 30 means a thirty percent chance of
 * visible aurora at that cell, and a 30 tonight means what a 30 meant last week. Clamped
 * only to keep an out-of-range value from escaping into the renderer.
 */
export function auroraMagnitude(probabilityPercent: number): number {
  return linearOn(probabilityPercent, 0, 100);
}

/** Bin index on the raw 0..359 longitude, so bins line up with the grid the source sent. */
function binIndex(lon: number, lat: number): number {
  const lonBin = Math.floor(lon / AURORA_BIN_DEGREES);
  const latBin = Math.floor((lat + 90) / AURORA_BIN_DEGREES);
  return latBin * AURORA_LON_BINS + lonBin;
}

/**
 * OVATION longitude runs 0..359. `SkyEvent.lon` is -180..180, which is what USGS and
 * wheretheiss.at both give and what the renderer assumes. Skipping this puts the entire
 * western hemisphere's aurora on the wrong side of the globe, and it looks fine until you
 * notice Alaska's band sitting over Siberia.
 */
function toSignedLon(lon: number): number {
  return lon > 180 ? lon - 360 : lon;
}

type Peak = { lon: number; lat: number; probability: number };

export function normalizeAuroraEvents(rawJson: string): SkyEvent[] {
  let payload: OvationPayload;
  try {
    payload = JSON.parse(rawJson) as OvationPayload;
  } catch {
    return [];
  }

  const cells = payload.coordinates;
  if (!Array.isArray(cells)) return [];

  const observationTime = typeof payload["Observation Time"] === "string" ? payload["Observation Time"] : undefined;
  const forecastTime = typeof payload["Forecast Time"] === "string" ? payload["Forecast Time"] : undefined;
  if (forecastTime === undefined) return [];

  /**
   * `at` is the FORECAST time, and this is the only feed in the project whose `at` can be
   * in the future, typically half an hour to an hour ahead.
   *
   * The reflex is to stamp the observation time, since `SkyEvent.at` says "when it happened
   * in the world" and the observation is the measurement. That would be wrong. The number
   * in each cell is not what the aurora was doing when the satellite looked, it is what
   * OVATION predicts the aurora will be doing at the forecast time from what the satellite
   * saw. Stamping it with the observation time would quietly relabel a forecast as a
   * measurement, which is the same class of mistake as calling a wiki's region an editor's
   * address. The observation time is real and useful, so it goes in `source` where the
   * panel can show both and the viewer can see the gap between them.
   */
  const at = Date.parse(forecastTime);
  if (Number.isNaN(at)) return [];

  const peaks = new Map<number, Peak>();

  for (const cell of cells) {
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const [lon, lat, probability] = cell as number[];
    if (typeof lon !== "number" || typeof lat !== "number" || typeof probability !== "number") continue;

    // Nothing forecast here. Not a candidate for the bin's peak and not an event.
    if (probability <= 0) continue;

    const key = binIndex(lon, lat);
    const current = peaks.get(key);
    // Strictly greater, so on a tie the first cell in the payload's own order wins. Ties are
    // common at low probabilities and an arbitrary but stable winner keeps output identical
    // for identical input.
    if (current === undefined || probability > current.probability) {
      peaks.set(key, { lon, lat, probability });
    }
  }

  const observedNote =
    observationTime === undefined ? "" : ` Observed ${readableUtc(observationTime)}.`;
  const events: SkyEvent[] = [];

  for (const peak of peaks.values()) {
    if (peak.probability < AURORA_MIN_PERCENT) continue;
    events.push({
      /**
       * Keyed by the forecast time and the peak cell, so re-fetching the same refresh
       * produces identical ids and cannot double-render. The cell moves between refreshes
       * even within one bin, which is correct: it is a different forecast for a different
       * place.
       */
      id: `ovation:${forecastTime}:${peak.lon}:${peak.lat}`,
      kind: "aurora",
      at,
      lat: peak.lat,
      lon: toSignedLon(peak.lon),
      // A grid point NOAA published a value for, not a bin centre we computed.
      placement: "measured",
      magnitude: auroraMagnitude(peak.probability),
      label: `Aurora, ${peak.probability}% chance of visibility`,
      source: `NOAA OVATION, forecast for ${readableUtc(forecastTime)}, brightest cell in a ${AURORA_BIN_DEGREES} degree bin.${observedNote}`,
    });
  }

  return events;
}
