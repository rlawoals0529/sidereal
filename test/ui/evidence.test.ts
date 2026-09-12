/**
 * The honesty surface, under test.
 *
 * The first test is the one that matters and it is written as a property over every row rather
 * than as an assertion about a particular string, so that a row added later is covered the day
 * it is added rather than the day somebody remembers to extend this file.
 */
import { describe, expect, it } from "vitest";
import type { SkyEvent } from "../../src/shared/event.ts";
import {
  announce,
  describeEvent,
  evidenceLines,
  evidenceRows,
  formatCoords,
  headline,
} from "../../src/ui/evidence.ts";

const NOW = 1_700_000_000_000;

const edit: SkyEvent = {
  id: "e1",
  kind: "edit",
  at: NOW - 30_000,
  lat: 50.45,
  lon: 30.5234,
  placement: "regional",
  magnitude: 0.62,
  label: "Kyiv Metro",
  source: "Wikimedia EventStreams",
};

const quake: SkyEvent = {
  id: "q1",
  kind: "quake",
  at: NOW - 400_000,
  lat: 53.1234,
  lon: -158.61,
  placement: "measured",
  magnitude: 0.41,
  label: "M4.1, 61 km NNE of Petropavlovsk",
  source: "USGS",
};

describe("an inferred position can never read as a measured one", () => {
  it("puts the coordinates nowhere except in a row that says they are not a measurement", () => {
    const rows = evidenceRows(describeEvent(edit, NOW));
    const coords = formatCoords(edit.lat, edit.lon, edit.kind);
    const carrying = rows.filter((r) => `${r.key} ${r.value}`.includes(coords));

    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.id).toBe("placement");
    expect(carrying[0]!.key).toBe("Regional placement");
    expect(carrying[0]!.value).toContain("not a measurement of where this happened");
  });

  it("says which region stood in, for the feed that has no position at all", () => {
    const { placement } = describeEvent(edit, NOW);
    expect(placement.measured).toBe(false);
    expect(placement.sentence).toContain("language edition's primary region");
  });

  it("never says regional about something the feed measured", () => {
    const lines = evidenceLines(describeEvent(quake, NOW)).join(" ");
    expect(lines).toContain("Measured position");
    expect(lines).not.toMatch(/regional/i);
    expect(lines).toContain("as reported by USGS");
  });
});

describe("the short forms carry the placement too", () => {
  it("names it in the accessible name of a register entry", () => {
    expect(announce(describeEvent(edit, NOW))).toContain("regional placement");
    expect(announce(describeEvent(quake, NOW))).toContain("measured position");
  });

  it("names it in the masthead line, which has no short form without it", () => {
    expect(headline(describeEvent(edit, NOW))).toContain("regional");
    expect(headline(describeEvent(quake, NOW))).toContain("measured");
  });
});

describe("brightness", () => {
  it("says which fixed curve produced the number, per kind", () => {
    expect(describeEvent(edit, NOW).brightness).toBe("Brightness 0.62 of 1, from bytes changed, clamped");
    expect(describeEvent(quake, NOW).brightness).toContain("Richter through a fixed curve");
  });
});

describe("formatCoords", () => {
  it("uses hemispheres rather than a minus sign", () => {
    expect(formatCoords(53.1234, -158.61, "quake")).toBe("53.1234 N, 158.6100 W");
    expect(formatCoords(-33.9, 18.4, "quake")).toBe("33.9000 S, 18.4000 E");
  });

  it("prints each kind only as precisely as its source knows", () => {
    // The bug this replaced read 80.0000 S, 110.0000 W for a cell whose own source calls it
    // the brightest in a five degree bin. Trailing zeroes are a claim about precision.
    expect(formatCoords(-80, -110, "aurora")).toBe("80 S, 110 W");
    expect(formatCoords(51.5074, -0.1278, "edit")).toBe("52 N, 0 W");
    expect(formatCoords(-33.8688, 151.2093, "quake")).toBe("33.8688 S, 151.2093 E");
  });
});
