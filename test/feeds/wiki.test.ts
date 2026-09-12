import { describe, expect, it } from "vitest";
import { normalizeWikiEvents, editMagnitude } from "../../src/feeds/wiki.ts";
import { regionForWikiDomain, WIKI_REGIONS } from "../../src/feeds/wiki-regions.ts";
import { wikiSse } from "./fixtures.ts";
import { must, only } from "./helpers.ts";

/**
 * Read the fixture's own records so the expectations below are derived from the capture
 * rather than from a number somebody typed once and never checked again. If the fixture is
 * ever re-captured these tests re-derive and keep meaning the same thing.
 */
function fixtureRecords(): Array<Record<string, any>> {
  return wikiSse()
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()));
}

describe("wiki normalizer", () => {
  const events = normalizeWikiEvents(wikiSse());
  const records = fixtureRecords();

  it("finds the records in the fixture at all", () => {
    // A guard on the guards. Every assertion below is of the form "no event has property X",
    // and all of them pass trivially against an empty array, so the suite is worthless
    // unless this holds first.
    expect(records.length).toBeGreaterThan(20);
    expect(events.length).toBeGreaterThan(5);
  });

  it("excludes bot edits", () => {
    const botRecords = records.filter((r) => r.bot === true);
    expect(botRecords.length).toBeGreaterThan(0);

    const emittedIds = new Set(events.map((e) => e.id));
    for (const bot of botRecords) {
      expect(emittedIds.has(`wiki:${bot.meta.id}`)).toBe(false);
    }
  });

  it("excludes a record whose bot flag is missing entirely", () => {
    // The fail-safe direction: an unknown bot flag is treated as a bot, because a renamed
    // field going quiet is noticed and a bot flood rendering as humans is not.
    const sse = `data: ${JSON.stringify({
      meta: { domain: "en.wikipedia.org", dt: "2026-09-12T19:56:08.939Z", id: "no-bot-field" },
      title: "Test",
      type: "edit",
      length: { old: 100, new: 200 },
    })}\n\n`;
    expect(normalizeWikiEvents(sse)).toHaveLength(0);
  });

  it("keeps non-bot edits from known domains", () => {
    const expected = records.filter(
      (r) => r.bot === false && r.length && regionForWikiDomain(r.meta.domain) !== null,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(events.map((e) => e.id).sort()).toEqual(expected.map((r) => `wiki:${r.meta.id}`).sort());
  });

  it("drops an unknown wiki domain rather than placing it at a fallback", () => {
    // The fixture carries real ones: ia.wikipedia.org (Interlingua, a constructed language
    // with no region) and the multilingual projects commons.wikimedia.org and
    // www.wikidata.org.
    const unknownDomains = records
      .filter((r) => r.bot === false && r.length && regionForWikiDomain(r.meta.domain) === null)
      .map((r) => r.meta.domain);
    expect(unknownDomains.length).toBeGreaterThan(0);

    const emittedDomains = new Set(events.map((e) => e.label.match(/\(([^)]+)\)/)?.[1]));
    for (const domain of unknownDomains) {
      expect(emittedDomains.has(domain)).toBe(false);
    }
  });

  it("never emits a coordinate for a domain that is not in the lookup table", () => {
    const sse = `data: ${JSON.stringify({
      meta: { domain: "xx-nonexistent.wikipedia.org", dt: "2026-09-12T19:56:08.939Z", id: "unknown-1" },
      title: "Test",
      type: "edit",
      bot: false,
      length: { old: 100, new: 200 },
    })}\n\n`;
    expect(normalizeWikiEvents(sse)).toHaveLength(0);
  });

  it("does not fall back to the language prefix of a hyphenated domain", () => {
    // zh-yue is Cantonese and has its own row, so the lookup has to answer from that row.
    expect(regionForWikiDomain("zh-yue.wikipedia.org")).toEqual(WIKI_REGIONS["zh-yue"]);

    // The one that matters: zh IS in the table. A prefix fallback would quietly serve the
    // zh row for any zh-something edition we have never heard of, and nothing in a rendered
    // sky would show which rows were looked up and which were guessed. Pairing this with a
    // prefix that is also unknown would not test anything, because both paths return null.
    expect(WIKI_REGIONS["zh"]).toBeDefined();
    expect(regionForWikiDomain("zh-nonexistent.wikipedia.org")).toBeNull();
    expect(regionForWikiDomain("zz-madeup.wikipedia.org")).toBeNull();
  });

  it("places every edit as regional, never as measured", () => {
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.placement).toBe("regional");
    }
  });

  it("puts the placement caveat in source so a UI can explain it", () => {
    for (const event of events) {
      expect(event.source).toContain("not the editor's location");
      expect(event.source).toContain("Wikimedia EventStreams");
    }
  });

  it("places each edit at its own wiki's region coordinates", () => {
    const byId = new Map(records.map((r) => [`wiki:${r.meta.id}`, r]));
    for (const event of events) {
      const record = must(byId.get(event.id), event.id);
      const region = must(regionForWikiDomain(record.meta.domain), record.meta.domain);
      expect({ lat: event.lat, lon: event.lon }).toEqual({ lat: region.lat, lon: region.lon });
    }
  });

  it("reads the timestamp from meta.dt as epoch milliseconds", () => {
    const byId = new Map(records.map((r) => [`wiki:${r.meta.id}`, r]));
    for (const event of events) {
      expect(event.at).toBe(Date.parse(must(byId.get(event.id), event.id).meta.dt));
      // Sanity on the unit itself: seconds read as milliseconds land in 1970.
      expect(event.at).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
    }
  });

  it("drops records that carry no length block, so log and categorize never appear", () => {
    const noLength = records.filter((r) => r.length === undefined);
    expect(noLength.length).toBeGreaterThan(0);
    const emittedIds = new Set(events.map((e) => e.id));
    for (const record of noLength) {
      expect(emittedIds.has(`wiki:${record.meta.id}`)).toBe(false);
    }
  });

  it("drops a log or categorize record that passes every other filter", () => {
    // The assertion above is weaker than it looks against the fixture alone: the log and
    // categorize records captured there happen to be bots or to sit on domains with no
    // region, so they would be dropped even if the length check did nothing. These two are
    // built to clear every other filter, so only the missing byte measurement can stop them.
    for (const type of ["log", "categorize"]) {
      const sse = `data: ${JSON.stringify({
        meta: { domain: "en.wikipedia.org", dt: "2026-09-12T19:56:08.939Z", id: `${type}-1` },
        title: "Some Page",
        type,
        bot: false,
      })}\n\n`;
      expect(normalizeWikiEvents(sse)).toHaveLength(0);
    }
  });

  it("drops a record whose length block exists but carries no new byte count", () => {
    const sse = `data: ${JSON.stringify({
      meta: { domain: "en.wikipedia.org", dt: "2026-09-12T19:56:08.939Z", id: "half-length" },
      title: "Some Page",
      type: "edit",
      bot: false,
      length: { old: 400 },
    })}\n\n`;
    expect(normalizeWikiEvents(sse)).toHaveLength(0);
  });

  it("treats a new page as a creation from zero bytes", () => {
    const sse = `data: ${JSON.stringify({
      meta: { domain: "en.wikipedia.org", dt: "2026-09-12T19:56:08.939Z", id: "new-page-1" },
      title: "Brand New",
      type: "new",
      bot: false,
      length: { new: 3705 },
    })}\n\n`;
    const event = only(normalizeWikiEvents(sse));
    expect(event.magnitude).toBe(editMagnitude(3705));
    expect(event.label).toContain("+3705 bytes");
  });

  it("uses the absolute byte delta, so a deletion is as bright as the same-sized addition", () => {
    const base = {
      meta: { domain: "en.wikipedia.org", dt: "2026-09-12T19:56:08.939Z", id: "x" },
      title: "T",
      type: "edit",
      bot: false,
    };
    const grew = normalizeWikiEvents(
      `data: ${JSON.stringify({ ...base, length: { old: 100, new: 600 } })}\n\n`,
    );
    const shrank = normalizeWikiEvents(
      `data: ${JSON.stringify({ ...base, length: { old: 600, new: 100 } })}\n\n`,
    );
    expect(only(shrank).magnitude).toBe(only(grew).magnitude);
    expect(only(shrank).magnitude).toBeGreaterThan(0);
    expect(only(shrank).label).toContain("-500 bytes");
  });

  it("skips SSE lines that are not data, including the opening :ok", () => {
    expect(wikiSse().startsWith(":ok")).toBe(true);
    const withNoise = `:ok\n\nevent: message\nid: [{"topic":"x"}]\n:heartbeat\n\n`;
    expect(normalizeWikiEvents(withNoise)).toHaveLength(0);
  });

  it("survives a truncated final frame without losing the frames before it", () => {
    const truncated = `${wikiSse()}data: {"meta":{"domain":"en.wiki`;
    expect(normalizeWikiEvents(truncated)).toHaveLength(events.length);
  });

  it("gives every event a unique id", () => {
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });
});

describe("edit magnitude curve", () => {
  it("is bounded to 0..1 across the whole plausible byte range", () => {
    for (let bytes = -2_000_000; bytes <= 2_000_000; bytes += 9_973) {
      const m = editMagnitude(bytes);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
    expect(editMagnitude(Number.NaN)).toBe(0);
    expect(editMagnitude(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("is monotonic in bytes changed", () => {
    let previous = -1;
    for (let bytes = 0; bytes <= 20_000; bytes += 7) {
      const m = editMagnitude(bytes);
      expect(m).toBeGreaterThanOrEqual(previous);
      previous = m;
    }
  });

  it("hits the documented anchor points", () => {
    expect(editMagnitude(0)).toBe(0);
    expect(editMagnitude(100)).toBeCloseTo(0.5, 2);
    expect(editMagnitude(10_000)).toBe(1);
    // Saturating: past the ceiling everything is equally bright, on purpose.
    expect(editMagnitude(1_000_000)).toBe(1);
  });

  it("does not rescale to the batch", () => {
    // The same edit, alone and alongside a much larger one, must be the same brightness.
    const small = {
      meta: { domain: "en.wikipedia.org", dt: "2026-09-12T19:56:08.939Z", id: "small" },
      title: "S",
      type: "edit",
      bot: false,
      length: { old: 0, new: 120 },
    };
    const huge = { ...small, meta: { ...small.meta, id: "huge" }, length: { old: 0, new: 900_000 } };
    const alone = normalizeWikiEvents(`data: ${JSON.stringify(small)}\n\n`);
    const together = normalizeWikiEvents(
      `data: ${JSON.stringify(small)}\n\ndata: ${JSON.stringify(huge)}\n\n`,
    );
    expect(must(together.find((e) => e.id === "wiki:small"), "small edit").magnitude).toBe(only(alone).magnitude);
  });
});
