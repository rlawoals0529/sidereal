import { describe, expect, it } from "vitest";
import { normalizeIssEvents } from "../../src/feeds/iss.ts";
import { issJson } from "./fixtures.ts";
import { only } from "./helpers.ts";

describe("iss normalizer", () => {
  const raw = JSON.parse(issJson());
  const event = only(normalizeIssEvents(issJson()));

  it("emits exactly one event for one position", () => {
    expect(normalizeIssEvents(issJson())).toHaveLength(1);
    expect(event.kind).toBe("orbit");
  });

  it("converts the timestamp from seconds to milliseconds", () => {
    // The trap: wheretheiss.at publishes seconds, SkyEvent.at is milliseconds, and getting
    // it wrong does not throw. It just puts the one live object in the sky in 1970.
    expect(event.at).toBe(raw.timestamp * 1000);
    expect(event.at).not.toBe(raw.timestamp);
  });

  it("lands the timestamp in the present century, not in 1970", () => {
    expect(event.at).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
    expect(event.at).toBeLessThan(Date.parse("2100-01-01T00:00:00Z"));
    expect(new Date(event.at).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("keeps latitude and longitude the way the feed names them", () => {
    // This feed is named-field, not positional, so the failure here would be reading the
    // pair in GeoJSON order out of habit.
    expect(event.lat).toBe(raw.latitude);
    expect(event.lon).toBe(raw.longitude);
    expect(Math.abs(event.lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(event.lon)).toBeLessThanOrEqual(180);
  });

  it("is measured, because the feed gives a real sub-satellite point", () => {
    expect(event.placement).toBe("measured");
  });

  it("is always magnitude 1 whatever the altitude says", () => {
    expect(event.magnitude).toBe(1);
    const higher = normalizeIssEvents(JSON.stringify({ ...raw, altitude: 428.9 }));
    const lower = normalizeIssEvents(JSON.stringify({ ...raw, altitude: 412.1 }));
    expect(only(higher).magnitude).toBe(1);
    expect(only(lower).magnitude).toBe(1);
  });

  it("puts the measured altitude and speed in the label", () => {
    expect(event.label).toContain("International Space Station");
    expect(event.label).toContain(`${Math.round(raw.altitude)} km up`);
    expect(event.label).toContain(`${Math.round(raw.velocity)} km/h`);
  });

  it("gives two polls of the same second the same id", () => {
    const again = normalizeIssEvents(issJson());
    expect(only(again).id).toBe(event.id);
    const later = normalizeIssEvents(JSON.stringify({ ...raw, timestamp: raw.timestamp + 1 }));
    expect(only(later).id).not.toBe(event.id);
  });

  it("returns nothing rather than a broken event when the payload is unusable", () => {
    expect(normalizeIssEvents("not json")).toHaveLength(0);
    expect(normalizeIssEvents(JSON.stringify({ latitude: 1, longitude: 2 }))).toHaveLength(0);
    expect(normalizeIssEvents(JSON.stringify({ timestamp: 1789242958 }))).toHaveLength(0);
  });
});
