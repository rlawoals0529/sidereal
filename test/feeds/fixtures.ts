/**
 * Captured payloads, and where each one came from.
 *
 * All five were pulled from the live endpoints on 2026-09-12 with curl and are real
 * responses, not hand-written samples. Where a response was trimmed the trim is described
 * below and is structural: no value inside a record was edited, because a fixture that has
 * been tidied up stops being evidence of what the endpoint does.
 *
 *   wikimedia-recentchange.sse      stream.wikimedia.org/v2/stream/recentchange
 *                                   ~12 seconds of stream, then 32 whole SSE frames kept
 *                                   out of 583 to cover the cases the tests need: bot and
 *                                   non-bot, `edit` / `new` / `log` / `categorize`, known
 *                                   and unknown domains, a zero-byte delta, a shrinking
 *                                   edit, and one edit large enough to saturate the byte
 *                                   curve. The opening `:ok` comment line is kept because
 *                                   the parser has to skip it.
 *
 *   usgs-all-hour.geojson           earthquake.usgs.gov .../summary/all_hour.geojson
 *                                   Byte for byte as served. 6 features, no trimming.
 *
 *   usgs-all-day-trimmed.geojson    earthquake.usgs.gov .../summary/all_day.geojson
 *                                   Same schema, wider magnitude range. 337 features
 *                                   reduced to 12 whole features spanning M0.1 to M6.5,
 *                                   plus one `quarry blast` so the type filter has
 *                                   something real to reject. `metadata.count` updated to
 *                                   match; nothing else touched.
 *
 *   wheretheiss-25544.json          api.wheretheiss.at/v1/satellites/25544
 *                                   Byte for byte as served.
 *
 *   noaa-ovation-trimmed.json       services.swpc.noaa.gov/json/ovation_aurora_latest.json
 *                                   900 kB reduced to 55 kB by keeping longitudes 0..29 and
 *                                   discarding the rest. The cut is along longitude so all
 *                                   181 latitude rows survive intact for the kept
 *                                   longitudes, which is what the binning tests need. 5430
 *                                   cells, 1258 of them non-zero.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

export const wikiSse = (): string => read("wikimedia-recentchange.sse");
export const quakeHour = (): string => read("usgs-all-hour.geojson");
export const quakeDay = (): string => read("usgs-all-day-trimmed.geojson");
export const issJson = (): string => read("wheretheiss-25544.json");
export const auroraJson = (): string => read("noaa-ovation-trimmed.json");
