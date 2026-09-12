import { describe, expect, it } from "vitest";
import { normalizeQuakeEvents, quakeMagnitude } from "../../src/feeds/quake.ts";
import { quakeDay, quakeHour } from "./fixtures.ts";
import { must, only } from "./helpers.ts";

function features(raw: string): Array<Record<string, any>> {
  return JSON.parse(raw).features;
}

describe("quake normalizer", () => {
  const events = normalizeQuakeEvents(quakeHour());

  it("finds the features in the fixture at all", () => {
    expect(features(quakeHour()).length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("reads GeoJSON coordinates as [lon, lat] and does not swap them", () => {
    const byId = new Map(features(quakeHour()).map((f) => [`usgs:${f.id}`, f]));
    for (const event of events) {
      const [lon, lat] = must(byId.get(event.id), event.id).geometry.coordinates;
      expect(event.lon).toBe(lon);
      expect(event.lat).toBe(lat);
    }
  });

  it("keeps a known epicentre on the right side of the planet", () => {
    // A synthetic feature at a coordinate whose two halves are not interchangeable: 38N
    // 122W is northern California, and swapped it is 122N, which is not a latitude at all.
    const raw = JSON.stringify({
      features: [
        {
          id: "swap-check",
          properties: { mag: 3, place: "California", time: 1789242649350, type: "earthquake", title: "M 3" },
          geometry: { coordinates: [-122.82, 38.8, 2.96] },
        },
      ],
    });
    const event = only(normalizeQuakeEvents(raw));
    expect(event.lat).toBe(38.8);
    expect(event.lon).toBe(-122.82);
    expect(Math.abs(event.lat)).toBeLessThanOrEqual(90);
  });

  it("never emits a latitude outside -90..90", () => {
    for (const event of [...events, ...normalizeQuakeEvents(quakeDay())]) {
      expect(event.lat).toBeGreaterThanOrEqual(-90);
      expect(event.lat).toBeLessThanOrEqual(90);
    }
  });

  it("treats properties.time as epoch milliseconds and does not multiply it", () => {
    const byId = new Map(features(quakeHour()).map((f) => [`usgs:${f.id}`, f]));
    for (const event of events) {
      expect(event.at).toBe(must(byId.get(event.id), event.id).properties.time);
      expect(event.at).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
      expect(event.at).toBeLessThan(Date.parse("2100-01-01T00:00:00Z"));
    }
  });

  it("marks every quake as measured", () => {
    for (const event of events) {
      expect(event.placement).toBe("measured");
      expect(event.kind).toBe("quake");
    }
  });

  it("drops a quarry blast, which is a real measurement but not an earthquake", () => {
    const dayFeatures = features(quakeDay());
    const blasts = dayFeatures.filter((f) => f.properties.type !== "earthquake");
    expect(blasts.length).toBeGreaterThan(0);

    const emitted = new Set(normalizeQuakeEvents(quakeDay()).map((e) => e.id));
    for (const blast of blasts) {
      expect(emitted.has(`usgs:${blast.id}`)).toBe(false);
    }
    expect(emitted.size).toBe(dayFeatures.length - blasts.length);
  });

  it("drops a feature whose magnitude is null", () => {
    const raw = JSON.stringify({
      features: [
        {
          id: "nomag",
          properties: { mag: null, place: "Nowhere", time: 1789242649350, type: "earthquake" },
          geometry: { coordinates: [10, 20, 1] },
        },
      ],
    });
    expect(normalizeQuakeEvents(raw)).toHaveLength(0);
  });

  it("uses the USGS title verbatim rather than composing one", () => {
    const byId = new Map(features(quakeHour()).map((f) => [`usgs:${f.id}`, f]));
    for (const event of events) {
      expect(event.label).toBe(must(byId.get(event.id), event.id).properties.title);
    }
  });
});

describe("quake magnitude curve", () => {
  it("is bounded to 0..1 well outside the instrumented range", () => {
    for (let richter = -20; richter <= 20; richter += 0.05) {
      const m = quakeMagnitude(richter);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
    expect(quakeMagnitude(Number.NaN)).toBe(0);
  });

  it("is monotonic in Richter magnitude", () => {
    let previous = -1;
    for (let richter = -3; richter <= 12; richter += 0.01) {
      const m = quakeMagnitude(richter);
      expect(m).toBeGreaterThanOrEqual(previous);
      previous = m;
    }
  });

  it("hits the documented anchor points on a fixed -1..10 domain", () => {
    expect(quakeMagnitude(-1)).toBe(0);
    expect(quakeMagnitude(10)).toBe(1);
    expect(quakeMagnitude(4.5)).toBeCloseTo(0.5, 6);
    expect(quakeMagnitude(7)).toBeCloseTo(0.727, 3);
    // The largest earthquake ever recorded still leaves headroom, on purpose.
    expect(quakeMagnitude(9.5)).toBeLessThan(1);
  });

  it("keeps whole Richter steps evenly spaced rather than double-logging them", () => {
    // Richter is already log10 of amplitude. Taking another log would compress M2..M8 into
    // a band where a tremor and a disaster look alike.
    const step = quakeMagnitude(3) - quakeMagnitude(2);
    expect(quakeMagnitude(6) - quakeMagnitude(5)).toBeCloseTo(step, 9);
    expect(quakeMagnitude(8) - quakeMagnitude(7)).toBeCloseTo(step, 9);
    expect(step).toBeGreaterThan(0.05);
  });

  it("does not rescale to the batch", () => {
    // A M2.0 alone and a M2.0 in a batch containing a M6.5 must be identical.
    const solo = normalizeQuakeEvents(
      JSON.stringify({
        features: features(quakeDay()).filter((f) => f.properties.mag === 2),
      }),
    );
    const inCrowd = normalizeQuakeEvents(quakeDay()).filter((e) => e.label.startsWith("M 2.0"));
    expect(solo.length).toBeGreaterThan(0);
    expect(must(inCrowd[0], "M 2.0 in the full batch").magnitude).toBe(must(solo[0], "M 2.0 alone").magnitude);
  });
});
