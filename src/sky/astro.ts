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

export function airmass(altRad: number): number {
  const deg = altRad * RAD;
  return 1 / (Math.sin(altRad) + KASTEN_YOUNG_A * Math.pow(deg + KASTEN_YOUNG_B, KASTEN_YOUNG_C));
}

/**
 * Normalised against the airmass at the zenith rather than against 1.
 *
 * Kasten and Young's fit does not pass through exactly 1.0 at the zenith; it lands at
 * 0.99971, which leaves the brightest possible light 0.005% over full and the whole sky
 * very slightly wrong against a palette chosen for a known ground. Dividing out the fit's
 * own zenith value makes the top of the sky exactly 1 and costs one constant fold.
 */
export function extinction(altRad: number): number {
  if (altRad <= 0) return 0;
  return Math.pow(10, -0.4 * EXTINCTION_K * (airmass(altRad) - airmass(Math.PI / 2)));
}

/**
 * Where the observer is standing and which way they are looking.
 *
 * `gazeAz`/`gazeAlt` default to straight up, facing south. Looking up is the whole posture of
 * the thing, and a zenith-centred view puts the horizon on screen as a complete circle, which
 * is the one composition where "below the horizon" is visible as a boundary rather than
 * inferred from things vanishing off an edge.
 *
 * **Why south and not north.** Screen-up is whatever is behind you when you tilt your head
 * back, which is the physical truth and is also why a naive default of "facing north" puts
 * north at the bottom of the frame. Facing south puts north at the top and east on the left,
 * which is the orientation every all-sky photograph and planisphere uses. It is a roll, not a
 * flip: nothing is mirrored, the observer is simply facing the other way.
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

/**
 * The same equatorial-to-local transform as `horizontal` then `localVec`, with no trigonometry
 * in it, for the one caller that runs it nine thousand times.
 *
 * `horizontal` costs four `Math.sin`/`Math.cos`/`atan2` calls per point, which is right when
 * you are converting a few hundred events. The star catalogue is 8,920 fixed points and the
 * hit test walks all of them on every pointer move, so at that size the trig is the whole
 * cost, and all of it is redundant: a star's declination and right ascension never change, so
 * `cos(dec)cos(ra)`, `cos(dec)sin(ra)` and `sin(dec)` can be computed once, at load, and the
 * only thing that varies per frame is the observer's own sidereal time and latitude.
 *
 * What is left is a rotation. Substituting `H = lst - ra` into Meeus 13.5 and 13.6 and
 * collecting terms gives, with `u` the star's fixed equatorial unit vector:
 *
 *     e = (u.x cos(lst) + u.y sin(lst),  u.x sin(lst) - u.y cos(lst),  u.z)
 *     local = (-e.y,  e.z cos(phi) - e.x sin(phi),  e.x cos(phi) + e.z sin(phi))
 *
 * That is eight multiplies and no transcendentals. It is exact, not an approximation: the
 * `atan2`/`asin` pair in `horizontal` recovers an angle that `localVec` immediately turns back
 * into the same vector, so going straight to the vector skips a round trip rather than
 * cutting a corner.
 *
 * **The trap.** This is a second derivation of the same geometry, which is exactly the kind of
 * thing that drifts. `test/sky/stars.test.ts` checks it against `localVec(horizontal(...))`
 * over a grid of declinations, right ascensions, latitudes and sidereal times, so if either
 * moves the other has to.
 */
export function equatorialUnit(decRad: number, raRad: number): LocalVec {
  const cd = Math.cos(decRad);
  return { x: cd * Math.cos(raRad), y: cd * Math.sin(raRad), z: Math.sin(decRad) };
}

export function localFromEquatorialUnit(
  u: LocalVec,
  sinLst: number,
  cosLst: number,
  sinPhi: number,
  cosPhi: number,
): LocalVec {
  const ex = u.x * cosLst + u.y * sinLst;
  const ey = u.x * sinLst - u.y * cosLst;
  return {
    x: -ey,
    y: u.z * cosPhi - ex * sinPhi,
    z: ex * cosPhi + u.z * sinPhi,
  };
}

/**
 * Turn the gaze by an angle measured in the plane of the screen, and give back where it now
 * points.
 *
 * The obvious implementation adds degrees to `gazeAzDeg` and `gazeAltDeg` directly, and it is
 * wrong in a way that only shows up where this project starts: looking straight up. Azimuth
 * has no meaning at the zenith, so a horizontal drag there is either a no-op or a spin,
 * depending on which way the arithmetic falls, and the default view is exactly that point.
 *
 * So the rotation happens on the direction vector, in the observer's own screen basis, and the
 * angles are read back out afterwards. `right` is horizontal by construction in `viewFrame`,
 * which is what keeps the horizon level however far the gaze has been dragged: there is no
 * roll to accumulate, because roll is never represented.
 *
 * **It is a real rotation, not a nudge and a renormalise.** `f + right*a + up*b` normalised is
 * the same thing to first order and turns by `atan(angle)` rather than by `angle`, which nobody
 * notices on a pointer move of three thousandths of a radian and which is eight degrees short
 * at a quarter turn. The screen basis is orthonormal, so the exact form costs one sine and one
 * cosine and the approximation bought nothing.
 *
 * The path it traces is a great circle, and that is what direct manipulation means: a straight
 * drag across the middle of the frame is a straight line on the sphere, so the piece of sky
 * under the pointer stays under it. The visible consequence is that a long sideways drag from a
 * tilted view sinks slightly toward the horizon, which is the great circle being a great circle
 * rather than a bug. A yaw-and-pitch camera holds the altitude instead and loses the pointer.
 */
export function rotateGaze(
  azDeg: number,
  altDeg: number,
  dRightRad: number,
  dUpRad: number,
): { azDeg: number; altDeg: number } {
  const az = azDeg * DEG;
  const f = localVec({ alt: altDeg * DEG, az });
  const right: LocalVec = { x: Math.cos(az), y: -Math.sin(az), z: 0 };
  const up: LocalVec = {
    x: right.y * f.z - right.z * f.y,
    y: right.z * f.x - right.x * f.z,
    z: right.x * f.y - right.y * f.x,
  };
  const theta = Math.hypot(dRightRad, dUpRad);
  if (theta < 1e-12) return { azDeg, altDeg };
  const c = Math.cos(theta);
  // The unit tangent the gaze rotates toward, times the sine of the angle.
  const k = Math.sin(theta) / theta;
  const x = f.x * c + (right.x * dRightRad + up.x * dUpRad) * k;
  const y = f.y * c + (right.y * dRightRad + up.y * dUpRad) * k;
  const z = f.z * c + (right.z * dRightRad + up.z * dUpRad) * k;
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return { azDeg, altDeg };
  const nz = Math.max(-1, Math.min(1, z / len));
  const alt = Math.asin(nz);
  // Within a thousandth of a radian of the pole the azimuth of the new direction is numerical
  // noise, so the old one is kept. The view is still correct: at the zenith every azimuth
  // points at the same piece of sky, and holding the previous one means a drag that goes up
  // over the pole and back down comes back the way it went rather than snapping to a new roll.
  const horiz = Math.hypot(x, y);
  const newAz = horiz < 1e-3 * len ? azDeg : normalizeAngle(Math.atan2(x / len, y / len)) * RAD;
  return { azDeg: newAz, altDeg: alt * RAD };
}
