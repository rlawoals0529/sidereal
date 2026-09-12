/**
 * The room, fed by the actual normalizers, on the actual captured payloads.
 *
 * Every other test on this path builds its events with a local fixture helper, so it proves the
 * validator agrees with the test author. This one is the only test that asks whether the
 * validator agrees with the four feeds the product is made of.
 *
 * It exists because it found something. `MAX_SOURCE_CHARS` was 64, which looks like a
 * reasonable cap for the name of a feed. It is not the name of a feed: `source` is the evidence
 * line, and it carries the placement caveat and the forecast-versus-observation gap, so the real
 * ones run to 140 characters. At 64 the room rejected every wiki, aurora and ISS event and kept
 * only earthquakes. 380 tests stayed green, the worker smoke test passed, and the sky rendered
 * one of its four feeds in silence.
 *
 * The shape of the lesson is the same as the palette allowlist that closed every socket: two
 * slices each internally consistent, agreeing with their own tests, and disagreeing with each
 * other. The only test that finds that is one that puts the real output of one into the real
 * input of the other.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  normalizeAuroraEvents,
  normalizeIssEvents,
  normalizeQuakeEvents,
  normalizeWikiEvents,
} from "../../src/feeds/index.ts";
import { validateIngest } from "../../src/worker/validate.ts";
import { MAX_INGEST_BATCH } from "../../src/worker/limits.ts";

const F = new URL("../feeds/fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, F), "utf8");

const FEEDS = {
  wiki: () => normalizeWikiEvents(read("wikimedia-recentchange.sse")),
  quake: () => normalizeQuakeEvents(read("usgs-all-day-trimmed.geojson")),
  iss: () => normalizeIssEvents(read("wheretheiss-25544.json")),
  aurora: () => normalizeAuroraEvents(read("noaa-ovation-trimmed.json")),
};

describe("the room accepts what the feeds actually produce", () => {
  for (const [name, build] of Object.entries(FEEDS)) {
    it(`accepts every ${name} event, rejecting none of them`, () => {
      const events = build();
      expect(events.length, `${name} produced nothing, so this test proves nothing`).toBeGreaterThan(0);

      // Batched to the cap, because rejection and truncation are different failures and this
      // test is only about rejection.
      for (let i = 0; i < events.length; i += MAX_INGEST_BATCH) {
        const slice = events.slice(i, i + MAX_INGEST_BATCH);
        const result = validateIngest(slice);
        expect(result.rejected, `${name} events the room refused`).toBe(0);
        expect(result.events.length).toBe(slice.length);
      }
    });
  }

  it("keeps all four kinds, not just the one with the shortest strings", () => {
    // The check that would have caught the real bug fastest. Only earthquakes survived, and
    // the thing they had in common was a short source line.
    const all = Object.values(FEEDS).flatMap((build) => build());
    const accepted = validateIngest(all.slice(0, MAX_INGEST_BATCH)).events;
    const kinds = new Set(all.map((e) => e.kind));
    const survived = new Set(accepted.map((e) => e.kind));
    for (const kind of kinds) expect(survived.has(kind), `${kind} was dropped entirely`).toBe(true);
  });
});
