/**
 * The coordinate maths, against answers that exist independently of this code.
 *
 * Every case here is one you can work out on paper or look up, which is the point: a test
 * that checks the projection against the projection's own output is a snapshot, and a
 * snapshot of a mirrored sky is a green suite and a wrong sky. The azimuth convention in
 * particular is the thing that silently mirrors, so it is checked in all four directions.
 */
import { describe, expect, it } from "vitest";
import {
  DEG,
  RAD,
  SIDEREAL_DAY_MS,
  celestialPoint,
  diurnalDirection,
  extinction,
  gmstRad,
  horizontal,
  localVec,
  normalizeAngle,
  planeRadius,
  stereographic,
  viewFrame,
} from "../../src/sky/astro.ts";

/** 2000 Jan 1, 12:00:00 UT. Meeus's worked epoch, and the zero of the GMST series. */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Events and observers, all at the same instant so the hour angle is purely longitude. */
const T = Date.UTC(2024, 5, 15, 3, 17, 42);

/**
 * The event happens at `eventAt` and the observer looks at `observeAt`.
 *
 * Two clocks on purpose. Passing one time to both pins the event afresh every time you ask,
 * which makes it follow the observer round and hides the entire premise: the sky only turns
 * because the event's right ascension was frozen when it happened and the observer's local
 * sidereal time has moved on since.
 */
function altAz(
  obsLat: number,
  obsLon: number,
  evLat: number,
  evLon: number,
  eventAt = T,
  observeAt = eventAt,
) {
  const frame = viewFrame({ latDeg: obsLat, lonDeg: obsLon, gazeAzDeg: 180, gazeAltDeg: 90 }, observeAt);
  const h = horizontal(celestialPoint(evLat, evLon, eventAt), frame.lst, frame.sinPhi, frame.cosPhi);
  return { alt: h.alt * RAD, az: normalizeAngle(h.az) * RAD };
}

describe("sidereal time", () => {
  it("is 280.46061837 degrees at J2000.0, which is the constant term of the series", () => {
    expect(gmstRad(J2000_MS) * RAD).toBeCloseTo(280.46061837, 6);
  });

  it("turns once every 23h56m04s, not every 24h", () => {
    // The whole premise. If this is 86400000 the sky is a solar clock and the project is a
    // screensaver.
    expect(SIDEREAL_DAY_MS).toBeCloseTo(86_164_090.5, 1);
    const before = gmstRad(T);
    const after = gmstRad(T + SIDEREAL_DAY_MS);
    expect(Math.abs(normalizeAngle(after - before + Math.PI) - Math.PI)).toBeLessThan(1e-5);
  });

  it("has moved on by nearly four minutes of angle after one solar day", () => {
    const drift = normalizeAngle(gmstRad(T + 86_400_000) - gmstRad(T)) * RAD;
    // 360 degrees per sidereal day means a solar day overshoots by about 0.9856 degrees.
    expect(drift).toBeCloseTo(0.9856, 3);
  });
});

describe("an event lands where the geometry says it lands", () => {
  it("is at the zenith for an observer standing on it", () => {
    // Four places, not six: asin has an infinite derivative at 1, so the zenith is the one
    // place in the sky where float64 gives up a few digits. 1e-4 degrees is a third of an
    // arcsecond.
    expect(altAz(35, 139, 35, 139).alt).toBeCloseTo(90, 4);
  });

  it("is at the nadir for an observer on the far side of the planet", () => {
    // This is the sentence in the brief, as arithmetic: you cannot see it until the world
    // turns.
    expect(altAz(0, 0, 0, 180).alt).toBeCloseTo(-90, 6);
    expect(altAz(51.5, 0, -51.5, 180).alt).toBeCloseTo(-90, 6);
  });

  it("puts a point ninety degrees east of the observer on the eastern horizon", () => {
    const e = altAz(0, 0, 0, 90);
    expect(e.alt).toBeCloseTo(0, 6);
    expect(e.az).toBeCloseTo(90, 6);
  });

  it("puts a point ninety degrees west of the observer on the western horizon", () => {
    const w = altAz(0, 0, 0, -90);
    expect(w.alt).toBeCloseTo(0, 6);
    expect(w.az).toBeCloseTo(270, 6);
  });

  it("puts the north pole due north, at an altitude equal to the observer's latitude", () => {
    // The oldest check in navigation: the elevation of the celestial pole is your latitude.
    for (const lat of [0, 23.4, 51.5, 78]) {
      const p = altAz(lat, 12, 90, 0);
      expect(p.alt).toBeCloseTo(lat, 5);
      expect(p.az).toBeCloseTo(0, 4);
    }
  });

  it("puts the south pole due south for a northern observer", () => {
    const p = altAz(51.5, 0, -90, 0);
    expect(p.az).toBeCloseTo(180, 4);
    expect(p.alt).toBeCloseTo(-51.5, 5);
  });

  it("is not mirrored: east and west are on opposite sides", () => {
    // The failure this exists for is a sky that is internally consistent and reflected, which
    // every other assertion in this file would pass.
    expect(altAz(20, 0, 20, 30).az).toBeGreaterThan(0);
    expect(altAz(20, 0, 20, 30).az).toBeLessThan(180);
    expect(altAz(20, 0, 20, -30).az).toBeGreaterThan(180);
  });
});

describe("the sky turns", () => {
  it("brings a point that was below the horizon up over it", () => {
    // Exactly antipodal at the moment it happens: the far side of the planet.
    const buried = altAz(0, -80, 0, 100);
    expect(buried.alt).toBeCloseTo(-90, 4);
    // A quarter turn puts it exactly on the horizon, and any more puts it above.
    expect(altAz(0, -80, 0, 100, T, T + SIDEREAL_DAY_MS / 4).alt).toBeCloseTo(0, 4);
    expect(altAz(0, -80, 0, 100, T, T + SIDEREAL_DAY_MS * 0.4).alt).toBeCloseTo(54, 3);
  });

  it("returns a point to the same altitude one sidereal day later", () => {
    const now = altAz(51.5, -0.1, 40, 116);
    const tomorrow = altAz(51.5, -0.1, 40, 116, T, T + SIDEREAL_DAY_MS);
    expect(tomorrow.alt).toBeCloseTo(now.alt, 4);
  });
});

describe("stereographic projection", () => {
  const frame = viewFrame({ latDeg: 0, lonDeg: 0, gazeAzDeg: 180, gazeAltDeg: 90 }, T);

  it("puts the centre of gaze at the origin", () => {
    const p = stereographic(localVec({ alt: Math.PI / 2, az: 0 }), frame);
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.x, p!.y)).toBeCloseTo(0, 9);
  });

  it("puts the horizon at radius two when looking straight up", () => {
    for (const azDeg of [0, 37, 180, 300]) {
      const p = stereographic(localVec({ alt: 0, az: azDeg * DEG }), frame);
      expect(Math.hypot(p!.x, p!.y)).toBeCloseTo(planeRadius(Math.PI / 2), 9);
    }
  });

  it("is conformal, so equal angular distances land at equal radii", () => {
    const r = (azDeg: number): number => {
      const p = stereographic(localVec({ alt: 30 * DEG, az: azDeg * DEG }), frame)!;
      return Math.hypot(p.x, p.y);
    };
    // This is the property the quake rings depend on. Without it a ring is an egg.
    expect(r(0)).toBeCloseTo(r(90), 9);
    expect(r(0)).toBeCloseTo(r(213), 9);
  });

  it("refuses the antipode rather than returning an enormous number", () => {
    const down = viewFrame({ latDeg: 0, lonDeg: 0, gazeAzDeg: 180, gazeAltDeg: -90 }, T);
    expect(stereographic(localVec({ alt: Math.PI / 2, az: 0 }), down)).toBeNull();
  });

  it("puts north up and east left, which is what every all-sky photograph does", () => {
    const north = stereographic(localVec({ alt: 45 * DEG, az: 0 }), frame)!;
    const east = stereographic(localVec({ alt: 45 * DEG, az: Math.PI / 2 }), frame)!;
    expect(north.y).toBeGreaterThan(0.1);
    expect(Math.abs(north.x)).toBeLessThan(1e-9);
    // Left, not right. Looking up mirrors the compass against a map of the ground, and this
    // is the assertion that says we did that on purpose rather than by accident.
    expect(east.x).toBeLessThan(-0.1);
    expect(Math.abs(east.y)).toBeLessThan(1e-9);
  });

  it("is a roll and not a flip: facing north puts the same sky the other way up", () => {
    const facingNorth = viewFrame({ latDeg: 0, lonDeg: 0, gazeAzDeg: 0, gazeAltDeg: 90 }, T);
    const n = stereographic(localVec({ alt: 45 * DEG, az: 0 }), facingNorth)!;
    const e = stereographic(localVec({ alt: 45 * DEG, az: Math.PI / 2 }), facingNorth)!;
    expect(n.y).toBeLessThan(-0.1);
    expect(e.x).toBeGreaterThan(0.1);
  });
});

describe("atmospheric extinction", () => {
  it("is exactly one at the zenith", () => {
    expect(extinction(Math.PI / 2)).toBeCloseTo(1, 9);
  });

  it("falls monotonically toward the horizon", () => {
    let previous = Infinity;
    for (let deg = 90; deg >= 1; deg -= 1) {
      const v = extinction(deg * DEG);
      expect(v).toBeLessThan(previous);
      previous = v;
    }
  });

  it("is zero below the horizon, not merely small", () => {
    expect(extinction(0)).toBe(0);
    expect(extinction(-0.3)).toBe(0);
  });

  it("dims a light near the horizon by most of its brightness", () => {
    // About five airmasses at ten degrees, which is roughly a magnitude of loss at k = 0.2.
    expect(extinction(10 * DEG)).toBeLessThan(0.45);
    expect(extinction(10 * DEG)).toBeGreaterThan(0.2);
  });
});

describe("diurnal direction", () => {
  const frame = viewFrame({ latDeg: 45, lonDeg: 0, gazeAzDeg: 180, gazeAltDeg: 90 }, T);

  it("is a unit vector", () => {
    const d = diurnalDirection(celestialPoint(10, 20, T), frame)!;
    expect(Math.hypot(d.dx, d.dy)).toBeCloseTo(1, 6);
  });

  it("is absent at the celestial pole, where a point does not move at all", () => {
    expect(diurnalDirection({ dec: Math.PI / 2, ra: 0 }, frame)).toBeNull();
  });

  it("carries points the same way round the pole everywhere in the sky", () => {
    // The sky turns one way. Two points on opposite sides of the pole must have opposite
    // screen directions, which is what makes the streaks read as one rotation rather than as
    // noise.
    const a = diurnalDirection({ dec: 60 * DEG, ra: frame.lst }, frame)!;
    const b = diurnalDirection({ dec: 60 * DEG, ra: frame.lst + Math.PI }, frame)!;
    expect(a.dx * b.dx + a.dy * b.dy).toBeLessThan(0);
  });
});
