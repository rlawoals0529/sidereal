# Dependencies for `src/feeds/`

## Runtime: none

The four normalizers import nothing outside `src/` and the Node/browser standard library.
`fetch.ts` uses the platform `fetch`, `TextDecoder` and `ReadableStream`, all of which Node
20+ and every target browser ship built in. No HTTP client, no SSE library, no GeoJSON
parser. That is deliberate: an SSE reader is fifteen lines here and a dependency forever.

No key, token or account is needed for any of the four endpoints.

## Test only

| Package | Why | Version used while building this |
| --- | --- | --- |
| `vitest` | the test runner `package.json` already names in its `test` script | 2.1.9 |
| `typescript` | `npm run typecheck` runs `tsc --noEmit`, which needs it present | 5.9.x |
| `@types/node` | `node:fs` and `node:url` in the test fixture loader | 22.x |

These were installed with `npm install --no-save` so that `package.json` stayed untouched,
which is why they are listed here rather than added there. Whoever owns `package.json`
should add them under `devDependencies`.

One note if you install these yourself: `tsconfig.json` sets `types: ["vite/client"]`, so
`tsc` needs a `vite` in `node_modules` as well. Pin `vite` to a version whose bundled
`rollup` types match the one `vitest` resolves, or `tsc --noEmit` reports a variance error
inside `node_modules/vite/dist/node/index.d.ts` under `exactOptionalPropertyTypes`. That
error is entirely about which versions got hoisted and says nothing about the code in here;
`src/feeds/` and `test/feeds/` typecheck clean.

## Endpoints these modules read

All four are public, unauthenticated, and CORS-open. Rate limits are not published for any
of them, so treat the cadences below as courtesy floors rather than as headroom.

| Feed | URL | Poll no faster than |
| --- | --- | --- |
| Wikimedia EventStreams | `https://stream.wikimedia.org/v2/stream/recentchange` | one long-lived connection, do not reconnect in a loop |
| USGS | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` | 60 s, the file regenerates every minute |
| ISS | `https://api.wheretheiss.at/v1/satellites/25544` | 1 s, which is the rate the API documents |
| NOAA OVATION | `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` | 300 s, it refreshes roughly every 5 minutes and is ~900 kB |
