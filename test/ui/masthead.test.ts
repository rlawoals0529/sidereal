/**
 * The ten seconds, as a contract.
 *
 * A stranger gets three facts and each one has to be verifiable by watching it. The tests here
 * are mostly about what the masthead must REFUSE to say, because the failure that matters is
 * not a missing number, it is a number held over from when it was true.
 */
import { describe, expect, it } from "vitest";
import type { SkyEvent } from "../../src/shared/event.ts";
import { describeEvent } from "../../src/ui/evidence.ts";
import { buildMasthead } from "../../src/ui/masthead.ts";

const NOW = Date.UTC(2026, 4, 2, 21, 13, 58);

const quake: SkyEvent = {
  id: "q",
  kind: "quake",
  at: NOW - 4000,
  lat: 53.12,
  lon: 158.61,
  placement: "measured",
  magnitude: 0.4,
  label: "M4.1, 61 km NNE of Petropavlovsk",
  source: "USGS",
};

const live = (over: Partial<Parameters<typeof buildMasthead>[0]> = {}) =>
  buildMasthead({
    connection: "live",
    people: 6,
    rate: 412,
    latest: describeEvent(quake, NOW),
    serverNow: NOW,
    ...over,
  });

describe("what a stranger reads", () => {
  it("gives a count of people that includes them, in words", () => {
    expect(live().peopleText).toBe("6 people here");
  });

  it("says so plainly when they are the only one, rather than printing a 1", () => {
    expect(live({ people: 1 }).peopleText).toBe("just you here");
  });

  it("states the throughput with its window, so the movement reads as a rate", () => {
    expect(live().rateText).toBe("412 events in the last 10 seconds");
    expect(live({ rate: 1 }).rateText).toBe("1 event in the last 10 seconds");
  });

  it("ticks a clock with seconds on it, which is the cheapest proof of live there is", () => {
    expect(live().siderealText).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const later = live({ serverNow: NOW + 1000 });
    expect(later.siderealText).not.toBe(live().siderealText);
  });

  it("names the newest light with its feed, its age and how it was placed", () => {
    const text = live().latestText;
    expect(text).toContain("M4.1, 61 km NNE of Petropavlovsk");
    expect(text).toContain("USGS");
    expect(text).toContain("just now");
    expect(text).toContain("measured");
  });
});

describe("what it refuses to say", () => {
  it("shows no count at all while offline, rather than the last one it knew", () => {
    // A stale count is worse than no count: it is the page telling a stranger it is live while
    // it is not, which is the one claim this project cannot afford to get wrong.
    const model = buildMasthead({
      connection: "offline",
      people: 6,
      rate: 412,
      latest: describeEvent(quake, NOW),
      serverNow: NOW,
    });
    expect(model.people).toBeNull();
    expect(model.peopleText).toBe("");
    expect(model.latest).toBeNull();
    expect(model.rateText).toBe("not connected, nothing here is live");
  });

  it("tells a quiet sky apart from a socket it cannot hear", () => {
    expect(live({ rate: 0 }).rateText).toBe("no events in the last 10 seconds");
    expect(
      buildMasthead({ connection: "connecting", people: null, rate: 0, latest: null, serverNow: NOW })
        .rateText,
    ).toBe("connecting");
  });

  it("waits for a real event rather than showing a placeholder one", () => {
    expect(live({ latest: null }).latestText).toBe("waiting for the first event");
  });
});
