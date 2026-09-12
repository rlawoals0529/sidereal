/**
 * The ISS to a single `SkyEvent`. One satellite on its real track.
 *
 * Endpoint: https://api.wheretheiss.at/v1/satellites/25544 (25544 is the ISS NORAD id).
 * Returns one object, not a collection, so this normalizer returns an array of length 1 or
 * 0. Same signature as the other three on purpose: the caller merges four feeds into one
 * batch and should not have to know which ones are plural.
 */
import type { SkyEvent } from "../shared/event.ts";

/**
 * Magnitude is always 1, and that is not laziness.
 *
 * The other three feeds vary in size because the things they report vary in size. There is
 * one space station. It does not get bigger or smaller, and it is either overhead or it is
 * not. Deriving a magnitude from altitude would be inventing a scale: the ISS orbits
 * between roughly 410 and 430 km and mapping that 20 km band onto 0..1 would produce a
 * light that visibly brightens and dims for reasons no viewer could ever read correctly.
 * Velocity is the same story, it barely varies. So the curve is the constant 1, and the
 * altitude and speed we do have go in the label where they can be read as numbers.
 */
const ISS_MAGNITUDE = 1;

type IssPosition = {
  latitude?: unknown;
  longitude?: unknown;
  altitude?: unknown;
  velocity?: unknown;
  timestamp?: unknown;
};

export function normalizeIssEvents(rawJson: string): SkyEvent[] {
  let position: IssPosition;
  try {
    position = JSON.parse(rawJson) as IssPosition;
  } catch {
    return [];
  }

  const { latitude, longitude, altitude, velocity, timestamp } = position;
  if (typeof latitude !== "number" || typeof longitude !== "number") return [];
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return [];

  /**
   * wheretheiss.at gives `timestamp` in SECONDS. Everything else in this project, and
   * `SkyEvent.at` itself, is epoch MILLISECONDS.
   *
   * Forgetting this does not throw and does not look obviously wrong on screen. A seconds
   * value read as milliseconds lands in January 1970, so the ISS gets an age of about
   * fifty-six years and any code that fades or sorts by recency silently treats the one
   * genuinely live object in the sky as the oldest thing in it. USGS publishes `time` in
   * milliseconds already and NOAA publishes ISO strings, so this is the only feed of the
   * four that needs the conversion, which is exactly why it is the one that gets missed.
   */
  const at = Math.round(timestamp * 1000);

  const altitudeKm = typeof altitude === "number" ? altitude : undefined;
  const velocityKmh = typeof velocity === "number" ? velocity : undefined;

  const measurements = [
    altitudeKm === undefined ? undefined : `${Math.round(altitudeKm)} km up`,
    velocityKmh === undefined ? undefined : `${Math.round(velocityKmh)} km/h`,
  ].filter((part): part is string => part !== undefined);

  return [
    {
      /**
       * The feed publishes no event id, because from its side this is a position query
       * rather than an event. The timestamp is the identity: two polls in the same second
       * describe the same moment of the same object and must not render twice.
       */
      id: `iss:${at}`,
      kind: "orbit",
      at,
      lat: latitude,
      lon: longitude,
      placement: "measured",
      magnitude: ISS_MAGNITUDE,
      label: measurements.length > 0
        ? `International Space Station, ${measurements.join(", ")}`
        : "International Space Station",
      source: "wheretheiss.at, NORAD 25544. Sub-satellite point at the given timestamp.",
    },
  ];
}
