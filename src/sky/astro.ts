/**
 * Where a thing that happened on Earth ends up in the sky above somebody else.
 *
 * This file is the reason the project is not a particle demo. Everything else here draws;
 * this decides where, and the decision is a real one with a right answer.
 *
 * The model, stated once so nothing below has to re-derive it:
 *
 * **An event is pinned to the celestial sphere at the instant it happened.** Not to the
 * ground. The point of sky directly overhead a given latitude and longitude has declination
 * equal to that latitude and right ascension equal to the local sidereal time there, so
 * `celestialPoint` is that one substitution and nothing more. Once pinned, the event stays
 * put on the sphere and the sphere turns underneath the observer at the sidereal rate.
 *
 * Two consequences fall straight out of that, and both are the effect we wanted rather than
 * a side effect we tolerated:
 *
 * - An event on the far side of the planet lands with a negative altitude. It is below the
 *   horizon, it is not drawn, and the only way to see it is to wait. Nothing enforces this;
 *   it is what the arithmetic says.
 * - The sky returns to the same orientation every 23h 56m 04s rather than every 24h, because
 *   the rate constant in `gmstRad` is the rotation of the Earth against the stars, not
 *   against the Sun. Leave the page open for a day and it comes back four minutes early.
 *
 * Formulas are from Jean Meeus, *Astronomical Algorithms*, 2nd ed. Chapter numbers are cited
 * at each one. Where a formula is given in degrees there, it is given in degrees here and
 * converted once, because silently re-deriving a published constant in radians is how a
 * transcription error becomes permanent.
 *
 * **The trap.** The same arithmetic runs on the GPU, in `gl/glsl.ts`. Two copies of one
 * formula is a thing that drifts, so the numeric constants live here and are checked against
 * the shader text by `test/sky/projection-parity.test.ts`. If you change a number in one
 * place that test fails. It cannot check the shape of the expressions, only the numbers, so
 * if you change an expression change both.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TAU = Math.PI * 2;

/**
 * One sidereal day in milliseconds: 23h 56m 04.0905s.
 *
 * Derived rather than typed, so it cannot disagree with the rate constant it comes from.
 * This is the number in the brief, and seeing it fall out of Meeus 12.4 is the check that
 * the rate constant was transcribed correctly.
 */
export const SIDEREAL_DAY_MS = (360 / 360.98564736629) * 86_400_000;

/** Days from the Unix epoch to J2000.0 (JD 2451545.0, 2000 Jan 1.5 TT). */
const UNIX_TO_J2000_DAYS = 10957.5;

/**
 * Greenwich mean sidereal time, radians. Meeus 12.4.
 *
 * Two things worth knowing before you touch it.
 *
 * `d` is computed straight from epoch milliseconds rather than by forming the Julian Day and
 * subtracting 2451545. Forming the full JD first puts a number near 2.46e6 in a float64 and
 * then cancels almost all of it, which throws away about six digits of the part that
 * matters. Going direct keeps the whole mantissa on the quantity we actually use.
 *
 * Meeus wants UT1 and we have UTC. They differ by at most 0.9 seconds by definition, which
 * is 0.0037 degrees of sky rotation, which is a fortieth of a pixel at any sensible zoom.
 * Nothing here needs the leap second tables and nothing here should pretend to have them.
 */
export function gmstRad(epochMs: number): number {
  const d = epochMs / 86_400_000 - UNIX_TO_J2000_DAYS;
  const t = d / 36525;
  const deg =
    280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38_710_000;
  return normalizeAngle(deg * DEG);
}

/** Local mean sidereal time for a longitude, radians. East longitude positive. */
export function lmstRad(epochMs: number, lonDeg: number): number {
  return normalizeAngle(gmstRad(epochMs) + lonDeg * DEG);
}

/** Wrap to [0, 2pi). `%` in JS keeps the sign of the dividend, which is the bug this avoids. */
export function normalizeAngle(rad: number): number {
  const r = rad % TAU;
  return r < 0 ? r + TAU : r;
}

/** A fixed point on the celestial sphere, in radians. Never recomputed after an event lands. */
export type Equatorial = { dec: number; ra: number };

/**
 * The point of sky that was directly overhead the event, at the moment of the event.
 *
 * This is the whole mapping from "a thing happened at a place and a time" to "a star". It is
 * one substitution: declination is the latitude, right ascension is the local sidereal time
 * of the longitude. Meeus chapter 13 states the relation in the other direction, from a sky
 * position to the ground point beneath it; this is that read backwards.
 *
 * `at` is the time the thing happened, not the time we heard about it. An earthquake we
 * learn about four minutes late is pinned where the sky was four minutes ago, which is where
 * it belongs, and the ring has already been expanding for four minutes when we first draw
 * it.
 */
export function celestialPoint(latDeg: number, lonDeg: number, atMs: number): Equatorial {
  return { dec: latDeg * DEG, ra: lmstRad(atMs, lonDeg) };
}

/** Where something is in the observer's own sky, radians. Azimuth is from North, eastward. */
export type Horizontal = { alt: number; az: number };

/**
 * Equatorial to horizontal for one observer at one instant. Meeus 13.5 and 13.6.
 *
 * Meeus gives azimuth westward from South; the compass convention everyone else uses is
 * eastward from North, so the result is rotated by pi at the end. That single line is worth
 * having a test on, because getting it wrong produces a sky that is beautiful, self-
 * consistent, and mirrored.
 *
 * The published azimuth formula has `tan(dec)` in it, which is infinite at the pole. Both
 * terms of the denominator are multiplied through by `cos(dec)` here, which is algebraically
 * identical and finite everywhere. `atan2` handles the resulting 0/0 at the exact pole by
 * returning something arbitrary, which is correct: azimuth genuinely has no value there.
 *
 * `sinPhi`/`cosPhi` are passed in rather than the latitude because the caller has thousands
 * of events and one observer, and a `Math.sin` per event of a value that did not change is
 * the easiest few percent of a frame to give away.
 */
export function horizontal(
  eq: Equatorial,
  lstObserver: number,
  sinPhi: number,
  cosPhi: number,
): Horizontal {
  const h = lstObserver - eq.ra;
  const sinDec = Math.sin(eq.dec);
  const cosDec = Math.cos(eq.dec);
  const sinH = Math.sin(h);
  const cosH = Math.cos(h);

  const sinAlt = sinPhi * sinDec + cosPhi * cosDec * cosH;
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const azFromSouth = Math.atan2(cosDec * sinH, cosDec * cosH * sinPhi - sinDec * cosPhi);
  return { alt, az: normalizeAngle(azFromSouth + Math.PI) };
}

/**
 * A direction in the observer's local frame: x east, y north, z up.
 *
 * This is the frame everything downstream works in. Picking it here and saying so is what
 * stops the projection code from having to keep asking which way y points.
 */
export type LocalVec = { x: number; y: number; z: number };

export function localVec(h: Horizontal): LocalVec {
  const c = Math.cos(h.alt);
  return { x: c * Math.sin(h.az), y: c * Math.cos(h.az), z: Math.sin(h.alt) };
}

/**
 * Atmospheric extinction as a plain brightness multiplier, 1 at the zenith.
 *
 * This is why lights fade as they approach the horizon, and it matters that it is this and
 * not a fade we invented to stop things popping in. Air absorbs light, more of it the longer
 * the path, and the path length relative to straight up is the airmass. Something rising is
 * genuinely dimmer than the same thing overhead. A real sky does this and a designed one
 * does not, and the difference is most of what makes the edge of the frame feel like a
 * horizon rather than a crop.
 *
 * Airmass from Kasten and Young (1989), *Applied Optics* 28(22), which unlike the
 * plane-parallel `1/sin(h)` stays finite at the horizon instead of going to infinity.
 * Extinction coefficient 0.20 magnitudes per airmass: a clear dark site in the visual band.
 * Magnitudes to a linear factor is the standard `10^(-0.4 dm)`.
 *
 * Below the horizon this returns 0 rather than something small, because "below the horizon"
 * is a hard fact about whether you can see a thing and not a matter of degree.
 */
export const EXTINCTION_K = 0.2;
/** Kasten and Young fitted coefficients, named so the parity test has something to compare. */
export const KASTEN_YOUNG_A = 0.50572;
export const KASTEN_YOUNG_B = 6.07995;
export const KASTEN_YOUNG_C = -1.6364;

export function extinction(altRad: number): number {
  if (altRad <= 0) return 0;
  const deg = altRad * RAD;
  const airmass =
    1 /
    (Math.sin(altRad) + KASTEN_YOUNG_A * Math.pow(deg + KASTEN_YOUNG_B, KASTEN_YOUNG_C));
  // Normalised so the zenith is exactly 1. Without this the whole sky is 17% dark and the
  // palette, which was chosen against a known ground, quietly stops matching it.
  return Math.pow(10, -0.4 * EXTINCTION_K * (airmass - 1));
}

/**
 * Where the observer is standing and which way they are looking.
 *
 * `gazeAz`/`gazeAlt` default to straight up elsewhere. Looking up is the whole posture of the
 * thing, and a zenith-centred view puts the horizon on screen as a complete circle, which is
 * the one composition where "below the horizon" is visible as a boundary rather than
 * inferred from things vanishing off an edge.
 */
export type Observer = {
  latDeg: number;
  lonDeg: number;
  gazeAzDeg: number;
  gazeAltDeg: number;
};

/**
 * Everything about the observer that is constant for a frame, precomputed once.
 *
 * Built per frame and handed to every projection, which is what keeps the per-event work
 * down to arithmetic. If you find yourself adding a `Math.sin` inside the loop, it probably
 * belongs in here.
 */
export type ViewFrame = {
  lst: number;
  sinPhi: number;
  cosPhi: number;
  /** Screen basis in the local east/north/up frame. */
  right: LocalVec;
  up: LocalVec;
  forward: LocalVec;
};

export function viewFrame(o: Observer, nowMs: number): ViewFrame {
  const phi = o.latDeg * DEG;
  const gazeAz = o.gazeAzDeg * DEG;
  const gazeAlt = o.gazeAltDeg * DEG;
  const forward = localVec({ alt: gazeAlt, az: gazeAz });
  // Ninety degrees clockwise from the gaze azimuth, in the horizontal plane. Defined from the
  // azimuth alone rather than as a cross product with world up, because a cross product with
  // world up is undefined when you look straight up, which is exactly where we start.
  const right: LocalVec = { x: Math.cos(gazeAz), y: -Math.sin(gazeAz), z: 0 };
  const up: LocalVec = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  return {
    lst: lmstRad(nowMs, o.lonDeg),
    sinPhi: Math.sin(phi),
    cosPhi: Math.cos(phi),
    right,
    up,
    forward,
  };
}

/**
 * Stereographic projection of a local direction onto the plane of the screen.
 *
 * Stereographic rather than gnomonic or equidistant, for one reason that outranks taste:
 * it is conformal, so a circle on the sphere is a circle on the screen. An earthquake draws
 * a real expanding wavefront, which is a circle on the sphere; a quake near the horizon in a
 * non-conformal projection turns into an egg, and the egg is not a fact about the
 * earthquake. Planetaria use this projection for the same reason.
 *
 * Returns plane coordinates in units where the radius for an angular distance `theta` from
 * the centre of gaze is `2 tan(theta/2)`. Scaling to pixels happens once, in the viewport.
 * `null` when the point is on or behind the antipode of the gaze, where the projection is
 * genuinely undefined.
 */
export const ANTIPODE_CUT = -0.999;

export function stereographic(v: LocalVec, f: ViewFrame): { x: number; y: number } | null {
  const z = v.x * f.forward.x + v.y * f.forward.y + v.z * f.forward.z;
  // Cut well before the pole. At z = -0.999 the point is already 16 times the horizon radius
  // out; letting it get closer only manufactures enormous coordinates for something nobody
  // can see.
  if (z <= ANTIPODE_CUT) return null;
  const k = 2 / (1 + z);
  return {
    x: k * (v.x * f.right.x + v.y * f.right.y + v.z * f.right.z),
    y: k * (v.x * f.up.x + v.y * f.up.y + v.z * f.up.z),
  };
}

/** Plane radius that a given angular distance from the centre of gaze lands at. */
export function planeRadius(thetaRad: number): number {
  return 2 * Math.tan(thetaRad / 2);
}

/**
 * Great-circle angular distance between two points on the sphere, radians.
 *
 * The haversine form rather than the law of cosines, which loses all its precision for
 * points close together, and points close together is the normal case here: two consecutive
 * ISS fixes are a fifteenth of a degree apart.
 */
export function angularSeparation(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * How fast a fixed point on the sphere is sliding across the screen, and which way.
 *
 * This is what a meteor's streak points along, and the reason the streaks are not decoration.
 * A Wikipedia edit gives us no direction of travel, so we do not draw one; what we draw is
 * the direction the sky itself is carrying that point, which is a real motion we can compute
 * from the rotation we already know. Near the celestial pole the streaks are stubby and
 * curved, near the equator they are long and straight, and that gradient is the rotation
 * made visible rather than annotated.
 *
 * Computed as a finite difference in hour angle rather than analytically. The analytic
 * derivative through the projection is four terms of chain rule that would then have to be
 * kept in step with the projection itself; a difference over a small step is the same number
 * and cannot go stale. `1e-4` radians of hour angle is about 1.4 seconds of rotation.
 */
export const DIURNAL_STEP_RAD = 1e-4;

export function diurnalDirection(
  eq: Equatorial,
  f: ViewFrame,
): { dx: number; dy: number } | null {
  const a = stereographic(localVec(horizontal(eq, f.lst, f.sinPhi, f.cosPhi)), f);
  const b = stereographic(
    localVec(horizontal(eq, f.lst + DIURNAL_STEP_RAD, f.sinPhi, f.cosPhi)),
    f,
  );
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  // Exactly at the celestial pole the point does not move at all and the direction is not a
  // small number, it is absent. Callers draw a dot there rather than a streak of length zero
  // pointing somewhere arbitrary.
  if (len < 1e-12) return null;
  return { dx: dx / len, dy: dy / len };
}
