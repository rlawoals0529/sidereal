import { describe, expect, it } from "vitest";
import {
  AURORA_BIN_DEGREES,
  AURORA_LAT_BINS,
  AURORA_LON_BINS,
  AURORA_MAX_EVENTS,
  auroraMagnitude,
  normalizeAuroraEvents,
} from "../../src/feeds/aurora.ts";
import { auroraJson } from "./fixtures.ts";
import { must, only } from "./helpers.ts";

type Cell = [number, number, number];

function payload(): { coordinates: Cell[]; "Observation Time": string; "Forecast Time": string } {
  return JSON.parse(auroraJson());
}

/** Independent reference binning, written straight rather than reusing the module's helper. */
function binKey(lon: number, lat: number): string {
  return `${Math.floor(lat / AURORA_BIN_DEGREES)}:${Math.floor(lon / AURORA_BIN_DEGREES)}`;
}

describe("aurora downsampling", () => {
  const raw = payload();
  const events = normalizeAuroraEvents(auroraJson());

  it("starts from the full grid the fixture actually contains", () => {
    expect(raw.coordinates.length).toBe(5430);
    expect(raw.coordinates.filter((c) => c[2] > 0).length).toBe(1258);
  });

  it("produces the documented count: one event per non-empty 5 degree bin", () => {
    // 5430 cells, 1258 of them non-zero, reduced to 69. The rule is one event per 5x5 bin
    // that has any aurora in it, so this number is fixed by the fixture and by the bin size
    // and by nothing else. Change either and this has to be recomputed deliberately.
    expect(events).toHaveLength(59);
  });

  it("never exceeds the hard ceiling of one event per bin on the whole globe", () => {
    expect(AURORA_LON_BINS).toBe(72);
    expect(AURORA_LAT_BINS).toBe(37);
    expect(AURORA_MAX_EVENTS).toBe(2664);
    expect(events.length).toBeLessThanOrEqual(AURORA_MAX_EVENTS);
  });

  it("emits at most one event per bin", () => {
    const keys = events.map((e) => binKey(e.lon < 0 ? e.lon + 360 : e.lon, e.lat + 90));
    expect(new Set(keys).size).toBe(events.length);
  });

  it("takes the peak of each bin, not the mean", () => {
    // The reference: recompute both statistics per bin and check which one the normalizer
    // agrees with. A mean would average the bright arc with its dark surroundings and
    // publish a probability NOAA never forecast.
    const peaks = new Map<string, number>();
    const sums = new Map<string, { total: number; count: number }>();
    for (const [lon, lat, probability] of raw.coordinates) {
      const key = binKey(lon, lat + 90);
      peaks.set(key, Math.max(peaks.get(key) ?? 0, probability));
      const bucket = sums.get(key) ?? { total: 0, count: 0 };
      sums.set(key, { total: bucket.total + probability, count: bucket.count + 1 });
    }

    let differed = 0;
    for (const event of events) {
      const key = binKey(event.lon < 0 ? event.lon + 360 : event.lon, event.lat + 90);
      const peak = must(peaks.get(key), key);
      expect(event.magnitude).toBe(auroraMagnitude(peak));
      const bucket = must(sums.get(key), key);
      if (Math.abs(bucket.total / bucket.count - peak) > 1e-9) differed += 1;
    }
    // Guard on the guard: if peak and mean happened to coincide everywhere, the assertion
    // above would pass for a mean implementation too.
    expect(differed).toBeGreaterThan(10);
  });

  it("places each event on a grid point NOAA actually published", () => {
    const published = new Set(
      raw.coordinates.map(([lon, lat, probability]) => `${lon > 180 ? lon - 360 : lon}:${lat}:${probability}`),
    );
    for (const event of events) {
      const percent = Math.round(event.magnitude * 100);
      expect(published.has(`${event.lon}:${event.lat}:${percent}`)).toBe(true);
      expect(event.placement).toBe("measured");
    }
  });

  it("drops bins with no forecast aurora at all", () => {
    for (const event of events) {
      expect(event.magnitude).toBeGreaterThan(0);
    }
    const allZero = JSON.stringify({
      "Observation Time": raw["Observation Time"],
      "Forecast Time": raw["Forecast Time"],
      coordinates: raw.coordinates.map(([lon, lat]) => [lon, lat, 0]),
    });
    expect(normalizeAuroraEvents(allZero)).toHaveLength(0);
  });

  it("converts longitude from 0..359 to -180..180", () => {
    for (const event of events) {
      expect(event.lon).toBeGreaterThanOrEqual(-180);
      expect(event.lon).toBeLessThanOrEqual(180);
      expect(event.lat).toBeGreaterThanOrEqual(-90);
      expect(event.lat).toBeLessThanOrEqual(90);
    }

    // Explicit: lon 200 is 160W. Left unconverted it reads as 160E and the whole western
    // hemisphere's band lands on the wrong side of the planet.
    const western = JSON.stringify({
      "Observation Time": "2026-09-12T19:46:00Z",
      "Forecast Time": "2026-09-12T20:51:00Z",
      coordinates: [[200, 65, 40]],
    });
    const event = only(normalizeAuroraEvents(western));
    expect(event.lon).toBe(-160);
    expect(event.lat).toBe(65);
  });

  it("leaves an eastern-hemisphere longitude alone", () => {
    const eastern = JSON.stringify({
      "Observation Time": "2026-09-12T19:46:00Z",
      "Forecast Time": "2026-09-12T20:51:00Z",
      coordinates: [[20, 65, 40]],
    });
    expect(only(normalizeAuroraEvents(eastern)).lon).toBe(20);
  });

  it("stamps at with the forecast time, not the observation time", () => {
    // These are over an hour apart in the fixture. The cell value is a prediction for the
    // forecast time; stamping the observation time would relabel a forecast as a
    // measurement.
    const forecast = Date.parse(raw["Forecast Time"]);
    const observed = Date.parse(raw["Observation Time"]);
    expect(forecast).not.toBe(observed);
    for (const event of events) {
      expect(event.at).toBe(forecast);
    }
  });

  it("keeps the observation time visible in source so the panel can show both", () => {
    for (const event of events) {
      // The readable form, not the ISO string. The panel prints this sentence to a person, and
      // 2026-09-12T19:46:00Z in the middle of one is a machine talking.
      expect(event.source).toContain("19:46 UTC");
      expect(event.source).toContain("20:51 UTC");
    }
  });

  it("gives every event a stable unique id", () => {
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(normalizeAuroraEvents(auroraJson()).map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("returns nothing rather than guessing when the payload is unusable", () => {
    expect(normalizeAuroraEvents("not json")).toHaveLength(0);
    expect(normalizeAuroraEvents(JSON.stringify({ coordinates: [[0, 0, 10]] }))).toHaveLength(0);
  });
});

describe("aurora magnitude curve", () => {
  it("is bounded to 0..1 outside the published range", () => {
    for (let percent = -50; percent <= 200; percent += 0.5) {
      const m = auroraMagnitude(percent);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
    expect(auroraMagnitude(Number.NaN)).toBe(0);
  });

  it("is monotonic in probability", () => {
    let previous = -1;
    for (let percent = 0; percent <= 100; percent += 0.25) {
      const m = auroraMagnitude(percent);
      expect(m).toBeGreaterThanOrEqual(previous);
      previous = m;
    }
  });

  it("is the published percentage and nothing else", () => {
    expect(auroraMagnitude(0)).toBe(0);
    expect(auroraMagnitude(30)).toBeCloseTo(0.3, 9);
    expect(auroraMagnitude(100)).toBe(1);
  });

  it("does not rescale to the batch", () => {
    // The fixture peaks at 10%. The same cell in a payload that also contains a 90% cell
    // has to stay at 0.10, not stretch to fill the range.
    const quiet = JSON.stringify({
      "Observation Time": "2026-09-12T19:46:00Z",
      "Forecast Time": "2026-09-12T20:51:00Z",
      coordinates: [[20, 65, 10]],
    });
    const stormy = JSON.stringify({
      "Observation Time": "2026-09-12T19:46:00Z",
      "Forecast Time": "2026-09-12T20:51:00Z",
      coordinates: [[20, 65, 10], [100, 70, 90]],
    });
    const quietMagnitude = only(normalizeAuroraEvents(quiet)).magnitude;
    const sameCellInStorm = must(normalizeAuroraEvents(stormy).find((e) => e.lon === 20), "the 10% cell").magnitude;
    expect(quietMagnitude).toBeCloseTo(0.1, 9);
    expect(sameCellInStorm).toBe(quietMagnitude);
  });
});

describe("bin geometry", () => {
  it("uses 5 degree bins", () => {
    expect(AURORA_BIN_DEGREES).toBe(5);
  });

  it("gives the pole its own latitude bin instead of dropping it", () => {
    // -90..90 inclusive is 181 rows, which does not divide by 5. The last bin holds lat 90
    // alone, and this is why the event is placed at the peak cell rather than a bin centre:
    // that bin's notional centre would be latitude 92.
    const polar = JSON.stringify({
      "Observation Time": "2026-09-12T19:46:00Z",
      "Forecast Time": "2026-09-12T20:51:00Z",
      coordinates: [[10, 90, 25]],
    });
    const event = only(normalizeAuroraEvents(polar));
    expect(event.lat).toBe(90);
    expect(Math.abs(event.lat)).toBeLessThanOrEqual(90);
  });
});
