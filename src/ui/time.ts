/**
 * Clocks, and the one that is not a clock.
 *
 * Three different times run through this page and conflating any two of them produces a
 * number that looks fine and is wrong:
 *
 * - **world time**, `SkyEvent.at`, when the thing happened. What the evidence panel prints.
 * - **server time**, `serverNow` on the wire, what the sky agrees the time is.
 * - **this browser's clock**, which can be minutes out and is nobody's business but its own.
 *
 * Every relative time here is measured against SERVER time, because a laptop forty seconds
 * behind renders "in 38 seconds" beside an earthquake that has already happened. `clockSkew`
 * is how that offset is carried.
 */

/**
 * One rotation of the Earth against the stars, not against the Sun.
 *
 * 86,164,090.5 ms rather than 86,400,000. The four minutes are the whole reason the sky in
 * this project drifts against the wall clock, and using the wrong constant here would make
 * "degrees of sky" wrong by about 1%, which is small enough that nobody would catch it by
 * looking.
 */
export const SIDEREAL_DAY_MS = 86_164_090.5;

/** Unix epoch ms to Julian Date. 2440587.5 is 1970-01-01T00:00:00Z in JD. */
const julian = (ms: number): number => ms / 86_400_000 + 2_440_587.5;

/**
 * Greenwich Mean Sidereal Time, in hours, 0..24.
 *
 * The sky's own clock, and the reason a focus session does not need a timer drawn on it. The
 * coefficients are the standard IAU linear expression about J2000; the quadratic terms matter
 * at the millisecond level a century out and not at all here.
 */
export function gmstHours(ms: number): number {
  const d = julian(ms) - 2_451_545.0;
  const h = 18.697_374_558 + 24.065_709_824_419_08 * d;
  return ((h % 24) + 24) % 24;
}

const pad = (n: number): string => String(Math.floor(n)).padStart(2, "0");

/** `21:14:07`. Seconds included on purpose: a figure that visibly moves is the cheapest
 *  possible proof that this page is live, and it costs one line. */
export function siderealClock(ms: number): string {
  const h = gmstHours(ms);
  const m = (h % 1) * 60;
  const s = (m % 1) * 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * How far the sky has turned during a session, in degrees.
 *
 * This is the session length restated in the only unit this page has any business using, and
 * it is a real measurement rather than a flourish: 25 minutes is 6.27 degrees, every time,
 * because the Earth does not negotiate.
 */
export function degreesOfSky(elapsedMs: number): number {
  return (elapsedMs / SIDEREAL_DAY_MS) * 360;
}

/** `24m 13s`, `1h 04m`, `8s`. Never `0h 0m 8s`: leading zero units are noise. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/**
 * How long ago something happened, against server time.
 *
 * A negative gap is clock skew, not a prophecy. Printing "in 4 seconds" next to an earthquake
 * that the feed has already reported is the single most effective way to make a page that is
 * telling the truth look like it is making things up, so anything at or ahead of now collapses
 * to "just now".
 */
export function relativeTime(atMs: number, serverNowMs: number): string {
  const gap = serverNowMs - atMs;
  if (gap < 5_000) return "just now";
  if (gap < 60_000) return `${Math.floor(gap / 1000)} seconds ago`;
  if (gap < 3_600_000) {
    const m = Math.floor(gap / 60_000);
    return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  }
  if (gap < 86_400_000) {
    const h = Math.floor(gap / 3_600_000);
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }
  const d = Math.floor(gap / 86_400_000);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

/**
 * The viewer's own wall clock reading of a world time, `21:13:58`.
 *
 * Local, not UTC, and stated as local in the panel beside it. "When it happened" is only
 * useful to a person if it is in the time they are living in, and only honest if it says which.
 */
export function localClock(atMs: number): string {
  const d = new Date(atMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The offset to add to this browser's clock to get the sky's.
 *
 * Kept as a number rather than as a Date so that a page that has never heard from the server
 * uses 0 and is merely imprecise, rather than having no clock at all.
 */
export const clockSkew = (serverNow: number, receivedAt: number): number => serverNow - receivedAt;
