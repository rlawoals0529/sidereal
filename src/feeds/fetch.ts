/**
 * The only place in `src/feeds/` that touches the network.
 *
 * Everything here returns raw response text and nothing here knows what a `SkyEvent` is.
 * That split is what makes the normalizers testable: a test reads a captured file and calls
 * the same function production calls, with no fetch to stub and no clock to freeze. If you
 * are about to add parsing to this file, it belongs in the normalizer instead.
 */

const USER_AGENT = "sidereal (https://github.com/sidereal) ambient sky client";

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export const QUAKE_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
export const ISS_URL = "https://api.wheretheiss.at/v1/satellites/25544";
export const AURORA_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
export const WIKI_STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange";

export function fetchQuakes(signal?: AbortSignal): Promise<string> {
  return fetchText(QUAKE_URL, signal);
}

export function fetchIss(signal?: AbortSignal): Promise<string> {
  return fetchText(ISS_URL, signal);
}

export function fetchAurora(signal?: AbortSignal): Promise<string> {
  return fetchText(AURORA_URL, signal);
}

/**
 * The Wikimedia stream never ends, so it is the one source that cannot be a single fetch.
 *
 * This yields raw text chunks exactly as they arrive. A chunk is not a record and is not
 * even guaranteed to end at a line boundary, so the caller buffers up to the last newline
 * and hands whole lines to `normalizeWikiEvents`. Splitting on the boundary here would put
 * SSE framing knowledge in the transport, which is the thing this file is meant not to
 * know.
 */
export async function* streamWikiChunks(signal?: AbortSignal): AsyncGenerator<string> {
  const response = await fetch(WIKI_STREAM_URL, {
    headers: { accept: "text/event-stream", "user-agent": USER_AGENT },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`${WIKI_STREAM_URL} responded ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
