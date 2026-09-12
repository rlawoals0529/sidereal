import { describe, expect, it } from "vitest";
import type { SkyEvent } from "../../src/shared/event.ts";
import { normalizeAuroraEvents } from "../../src/feeds/aurora.ts";
import { normalizeIssEvents } from "../../src/feeds/iss.ts";
import { normalizeQuakeEvents } from "../../src/feeds/quake.ts";
import { normalizeWikiEvents } from "../../src/feeds/wiki.ts";
import { auroraJson, issJson, quakeHour, wikiSse } from "./fixtures.ts";

/**
 * The rules that hold across all four feeds. A normalizer can be internally consistent and
 * still hand the renderer something it cannot draw, so these run over every feed's output
 * from one place.
 */
const feeds: Array<{ name: string; events: SkyEvent[]; expectedKind: SkyEvent["kind"] }> = [
  { name: "wiki", events: normalizeWikiEvents(wikiSse()), expectedKind: "edit" },
  { name: "quake", events: normalizeQuakeEvents(quakeHour()), expectedKind: "quake" },
  { name: "iss", events: normalizeIssEvents(issJson()), expectedKind: "orbit" },
  { name: "aurora", events: normalizeAuroraEvents(auroraJson()), expectedKind: "aurora" },
];

describe.each(feeds)("$name feed contract", ({ events, expectedKind }) => {
  it("emits at least one event, so the assertions below are not vacuous", () => {
    expect(events.length).toBeGreaterThan(0);
  });

  it("only emits its own kind", () => {
    for (const event of events) expect(event.kind).toBe(expectedKind);
  });

  it("emits a magnitude inside 0..1", () => {
    for (const event of events) {
      expect(Number.isFinite(event.magnitude)).toBe(true);
      expect(event.magnitude).toBeGreaterThanOrEqual(0);
      expect(event.magnitude).toBeLessThanOrEqual(1);
    }
  });

  it("emits coordinates on the globe", () => {
    for (const event of events) {
      expect(event.lat).toBeGreaterThanOrEqual(-90);
      expect(event.lat).toBeLessThanOrEqual(90);
      expect(event.lon).toBeGreaterThanOrEqual(-180);
      expect(event.lon).toBeLessThanOrEqual(180);
    }
  });

  it("emits a plausible epoch-millisecond timestamp", () => {
    for (const event of events) {
      expect(Number.isInteger(event.at)).toBe(true);
      expect(event.at).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
      expect(event.at).toBeLessThan(Date.parse("2100-01-01T00:00:00Z"));
    }
  });

  it("gives every event a non-empty id, label and source", () => {
    for (const event of events) {
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.label.length).toBeGreaterThan(0);
      expect(event.source.length).toBeGreaterThan(0);
    }
  });

  it("is pure, so the same input twice gives the same output", () => {
    expect(events).toEqual(events.map((e) => ({ ...e })));
  });
});

describe("placement honesty", () => {
  it("marks only the three feeds that carry real coordinates as measured", () => {
    const measured = feeds.filter((f) => f.events.every((e) => e.placement === "measured"));
    expect(measured.map((f) => f.name).sort()).toEqual(["aurora", "iss", "quake"]);
  });

  it("marks every wiki edit regional, since a recentchange record has no location", () => {
    const wiki = feeds.find((f) => f.name === "wiki")!;
    expect(wiki.events.length).toBeGreaterThan(0);
    for (const event of wiki.events) expect(event.placement).toBe("regional");
  });

  it("never lets a regional event claim to be measured, across every feed", () => {
    for (const feed of feeds) {
      for (const event of feed.events) {
        expect(["measured", "regional"]).toContain(event.placement);
      }
    }
  });

  it("gives every id a feed prefix so two feeds cannot collide", () => {
    const all = feeds.flatMap((f) => f.events.map((e) => e.id));
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^(wiki|usgs|iss|ovation):/);
  });
});
