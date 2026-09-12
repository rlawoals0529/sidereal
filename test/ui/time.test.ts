/**
 * The clocks. Every case here is one somebody would have to wait a day to see by hand, which is
 * the reason `now` is a parameter everywhere in `time.ts` rather than a call to `Date.now()`.
 */
import { describe, expect, it } from "vitest";
import {
  degreesOfSky,
  duration,
  gmstHours,
  localClock,
  relativeTime,
  SIDEREAL_DAY_MS,
  siderealClock,
} from "../../src/ui/time.ts";

const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);

describe("sidereal clock", () => {
  it("reads 18h 41m at J2000, which is the published value", () => {
    // The anchor the IAU expression is written around. If this drifts, the expression has been
    // edited, and every "degrees of sky" figure on the page is wrong with it.
    expect(gmstHours(J2000)).toBeCloseTo(18.697374558, 6);
    expect(siderealClock(J2000)).toBe("18:41:50");
  });

  it("repeats after one SIDEREAL day, not after one solar day", () => {
    // The whole point of the project's clock. A solar day here would be four minutes out, which
    // is small enough that nobody catches it by looking at the page.
    const start = Date.UTC(2026, 2, 14, 3, 0, 0);
    expect(gmstHours(start + SIDEREAL_DAY_MS)).toBeCloseTo(gmstHours(start), 4);
    expect(Math.abs(gmstHours(start + 86_400_000) - gmstHours(start))).toBeGreaterThan(0.06);
  });

  it("wraps into 0..24 rather than running past it", () => {
    for (const hours of [0, 5, 11, 23, 200, 5000]) {
      const value = gmstHours(J2000 + hours * 3_600_000);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(24);
    }
  });
});

describe("degrees of sky", () => {
  it("turns 25 minutes into 6.27 degrees", () => {
    expect(degreesOfSky(25 * 60_000)).toBeCloseTo(6.2671, 3);
  });

  it("turns one sidereal day into exactly one turn", () => {
    expect(degreesOfSky(SIDEREAL_DAY_MS)).toBeCloseTo(360, 9);
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;

  it("never predicts the future when this browser's clock is behind", () => {
    // Clock skew, not prophecy. "in 8 seconds" beside an earthquake that has already been
    // reported is the fastest way to make a page that is telling the truth look invented.
    expect(relativeTime(now + 8_000, now)).toBe("just now");
    expect(relativeTime(now + 400_000, now)).toBe("just now");
  });

  it("reads in the unit the gap is in", () => {
    expect(relativeTime(now - 1_000, now)).toBe("just now");
    expect(relativeTime(now - 21_000, now)).toBe("21 seconds ago");
    expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTime(now - 3_600_000, now)).toBe("1 hour ago");
    expect(relativeTime(now - 90_000_000, now)).toBe("1 day ago");
  });
});

describe("duration", () => {
  it("drops units that are zero rather than padding them", () => {
    expect(duration(8_000)).toBe("8s");
    expect(duration(24 * 60_000 + 13_000)).toBe("24m 13s");
    expect(duration(3_600_000 + 4 * 60_000)).toBe("1h 04m");
  });
});

describe("localClock", () => {
  it("reads a world time in the viewer's own zone", () => {
    const at = new Date(2026, 4, 2, 21, 13, 58).getTime();
    expect(localClock(at)).toBe("21:13:58");
  });
});
