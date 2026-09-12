/**
 * The four feeds, as the rest of the app sees them.
 *
 * Everything exported from here either fetches raw text or turns raw text into `SkyEvent[]`.
 * Nothing else in the app should import a feed module directly, so that adding a fifth feed
 * is one new file plus one line here.
 */
export { normalizeWikiEvents, editMagnitude } from "./wiki.ts";
export { normalizeQuakeEvents, quakeMagnitude } from "./quake.ts";
export { normalizeIssEvents } from "./iss.ts";
export {
  normalizeAuroraEvents,
  auroraMagnitude,
  AURORA_BIN_DEGREES,
  AURORA_LON_BINS,
  AURORA_LAT_BINS,
  AURORA_MAX_EVENTS,
} from "./aurora.ts";
export { WIKI_REGIONS, regionForWikiDomain } from "./wiki-regions.ts";
export type { WikiRegion } from "./wiki-regions.ts";
export { clamp01, linearOn } from "./curve.ts";
export {
  fetchQuakes,
  fetchIss,
  fetchAurora,
  streamWikiChunks,
  QUAKE_URL,
  ISS_URL,
  AURORA_URL,
  WIKI_STREAM_URL,
} from "./fetch.ts";
