/**
 * Wikimedia EventStreams to `SkyEvent[]`. One meteor per human edit.
 *
 * Endpoint: https://stream.wikimedia.org/v2/stream/recentchange (SSE, no auth, no key).
 * This module never touches the network. It takes the raw text the stream produced and
 * returns events, which is what lets the tests run against a captured file offline.
 *
 * Three filters run before anything is emitted, and each drops real records on purpose.
 * They are listed here together because the combined drop rate is high, around two thirds
 * of the raw stream, and a reader who meets them one at a time will assume something is
 * broken.
 */
import type { SkyEvent } from "../shared/event.ts";
import { clamp01 } from "./curve.ts";
import { regionForWikiDomain } from "./wiki-regions.ts";

/**
 * The byte delta at which an edit is at full brightness.
 *
 * Edit sizes are heavy tailed. A typo fix is one byte, a new article is tens of thousands,
 * and the median sits near a hundred. Dividing by the largest plausible edit would put
 * essentially every real edit in the bottom two percent of the range and the sky would be
 * uniformly dim with occasional flashes, which is a picture of the arithmetic rather than
 * of Wikipedia.
 *
 * So the curve is log10 over a fixed ceiling of 10 kB:
 *
 *     magnitude = log10(1 + |bytes|) / log10(1 + 10000)
 *
 *     1 byte     0.08      a typo
 *     100 bytes  0.50      a sentence
 *     1 kB       0.75      a paragraph
 *     10 kB      1.00      a new article, and everything above it
 *
 * Log rather than linear because the thing being shown is orders of magnitude of effort,
 * and 10 kB rather than the true maximum because past that point one more kilobyte does not
 * mean anything more to a viewer. Both numbers are fixed. Neither looks at the batch.
 */
const EDIT_BYTES_FULL_SCALE = 10000;

const EDIT_LOG_DENOMINATOR = Math.log10(1 + EDIT_BYTES_FULL_SCALE);

/** Shape of the fields we read. The stream sends far more; everything else is ignored. */
type RecentChange = {
  meta?: { domain?: unknown; dt?: unknown; id?: unknown };
  title?: unknown;
  type?: unknown;
  bot?: unknown;
  length?: { old?: unknown; new?: unknown };
};

export function editMagnitude(bytesChanged: number): number {
  if (!Number.isFinite(bytesChanged)) return 0;
  return clamp01(Math.log10(1 + Math.abs(bytesChanged)) / EDIT_LOG_DENOMINATOR);
}

/**
 * Pull the `data:` payloads out of an SSE body.
 *
 * SSE bodies also carry `event:`, `id:` and `:comment` lines, and the stream opens with a
 * bare `:ok`. Parsing line-by-line and taking only `data:` is what keeps a heartbeat or a
 * reconnect marker from being mistaken for a record.
 */
function dataLines(sse: string): string[] {
  const out: string[] = [];
  for (const line of sse.split("\n")) {
    if (line.startsWith("data:")) out.push(line.slice("data:".length).trim());
  }
  return out;
}

/**
 * Raw SSE text to sky events.
 *
 * Filter 1, bots. `bot: true` is dropped, and so is any record where `bot` is not exactly
 * `false`. The asymmetry is deliberate. Bots are more than a third of the stream and they
 * arrive in bursts, so the failure we cannot tolerate is a bot flood rendering as human
 * activity. If Wikimedia ever renames or drops the field, requiring an explicit `false`
 * makes the whole feed go quiet, which somebody notices in about a minute. Defaulting the
 * other way would let the flood through and look completely normal.
 *
 * Filter 2, records with no byte measurement. `log` and `categorize` records carry no
 * `length` block at all, which is most of the remaining volume. A magnitude has to come
 * from something the source measured, and for these there is nothing to measure, so they
 * are not events here. A `new` page has `length.new` and no `length.old`; that is a
 * creation from nothing and old counts as 0, not as missing.
 *
 * Filter 3, domains with no known region. See the block comment on the drop below.
 */
export function normalizeWikiEvents(rawSse: string): SkyEvent[] {
  const events: SkyEvent[] = [];

  for (const line of dataLines(rawSse)) {
    let record: RecentChange;
    try {
      record = JSON.parse(line) as RecentChange;
    } catch {
      // A truncated final frame is normal when a stream is cut mid-record. Skip it rather
      // than failing the whole batch, since every other record in the batch is fine.
      continue;
    }

    if (record.bot !== false) continue;

    const length = record.length;
    if (length === undefined || typeof length.new !== "number") continue;
    const oldBytes = typeof length.old === "number" ? length.old : 0;
    const bytesChanged = length.new - oldBytes;

    const meta = record.meta;
    const domain = typeof meta?.domain === "string" ? meta.domain : undefined;
    const dt = typeof meta?.dt === "string" ? meta.dt : undefined;
    const id = typeof meta?.id === "string" ? meta.id : undefined;
    const title = typeof record.title === "string" ? record.title : undefined;
    if (domain === undefined || dt === undefined || id === undefined || title === undefined) continue;

    const at = Date.parse(dt);
    if (Number.isNaN(at)) continue;

    /**
     * Unknown domain, and the decision is to DROP rather than place at a fallback.
     *
     * The alternative was a default coordinate for anything unrecognised. Every candidate
     * default is a lie with a different accent. (0, 0) is open water in the Gulf of Guinea
     * and would grow a permanent bright cluster off West Africa that a viewer would read as
     * a region editing hard. A "global projects" point somewhere neutral is the same thing
     * with better manners: it still draws a light at coordinates nobody measured or
     * inferred, and it still gets stamped `regional`, which is the one stamp that is
     * supposed to mean "we can name the region this came from".
     *
     * The cost is real and worth stating: commons.wikimedia.org and www.wikidata.org are
     * multilingual projects with no primary region, and in the capture behind the fixtures
     * they were 64% of non-bot records. Dropping them loses most of the feed's volume. The
     * feed still produces plenty of meteors, the sky is still busy, and every meteor in it
     * can be explained. An invented coordinate would cost the one rule this project has.
     *
     * If a real language edition is missing from the table, the fix is to add a row to
     * WIKI_REGIONS, not to add a fallback here.
     */
    const region = regionForWikiDomain(domain);
    if (region === null) continue;

    events.push({
      id: `wiki:${id}`,
      kind: "edit",
      at,
      lat: region.lat,
      lon: region.lon,
      // Not "measured". The record has no location and never did. See wiki-regions.ts.
      placement: "regional",
      magnitude: editMagnitude(bytesChanged),
      label: `${title} (${domain}), ${bytesChanged >= 0 ? "+" : ""}${bytesChanged} bytes`,
      // The panel prints this verbatim, so it has to carry the whole placement caveat. A UI
      // that shows the coordinate without this string is presenting a guess as a fix.
      source: `Wikimedia EventStreams. Placed at the ${domain} primary region, ${region.name}. This is the wiki's region, not the editor's location.`,
    });
  }

  return events;
}
