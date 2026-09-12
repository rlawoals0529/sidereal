/**
 * Numbers the CPU and the GPU both need, in one place so they cannot disagree.
 *
 * Every one of these also appears as a `const float` of the same name in `gl/glsl.ts` or
 * `gl/shaders.ts`, and `test/sky/projection-parity.test.ts` refuses to pass if a constant
 * exists on one side and not the other, or exists on both with different values. That is the
 * mechanism, so if you add a constant to a shader, add it here too or the suite will tell
 * you.
 *
 * Where a number is a measurement rather than a taste decision it says so and cites where it
 * came from. The ones that are taste decisions say that too, which is the more useful label:
 * it marks what you are allowed to change without checking a source.
 */

/** Radius of the Earth, mean, km. IUGG mean radius. */
export const EARTH_RADIUS_KM = 6371;

/**
 * Rayleigh surface wave speed, km/s.
 *
 * The wave you feel in an earthquake at a distance, and the one that sets the radius of the
 * expanding ring. Continental crust runs roughly 3.0 to 3.9 km/s; 3.5 is the value used
 * across the ring. Measurement, not taste: an earthquake ring reaches 11.3 degrees of arc in
 * six minutes because that is how far the ground actually moved, which is also why the ring
 * is slow. Nothing here needed a "make it feel geological" multiplier.
 */
export const RAYLEIGH_KM_S = 3.5;

/**
 * How long a quake stays on the sky, seconds.
 *
 * Taste, bounded by the physics above: six minutes puts the front at 1260 km, which is about
 * as wide as a ring can get before it stops reading as one event. It is also the longest
 * thing in the sky besides the aurora and the visitors, which is the point. Nothing about an
 * earthquake is quick.
 */
export const QUAKE_LIFE_S = 360;

/** Segments around a quake ring. 96 keeps the largest ring's facets under half a pixel. */
export const RING_SEGMENTS = 96;

/**
 * Normalising radius for the ring's amplitude falloff, as a sine. One degree.
 *
 * A surface wave spreading round a sphere thins as the circumference it occupies grows, so
 * amplitude goes as 1/sqrt(sin r). That is unbounded at r = 0, so it is normalised at one
 * degree: a ring starts at full strength and fades as it spreads, which is the real
 * behaviour with the singularity taken off the front.
 */
export const SPREAD_R0 = Math.sin(1 * (Math.PI / 180));

/** How long a meteor is on the sky, seconds. Taste. */
export const METEOR_LIFE_S = 2.2;
/** How long the streak takes to draw itself in, seconds. Taste. */
export const METEOR_DRAW_S = 0.42;
/** Angular length of the smallest and largest edit's streak, degrees. Taste. */
export const METEOR_MIN_DEG = 0.5;
export const METEOR_MAX_DEG = 6;

/**
 * Seconds an aurora cell takes to cross from its last measured probability to its new one.
 *
 * The only interpolation in the renderer, and it is between two measured values rather than
 * toward an invented one. OVATION lands about every five minutes; without this the whole
 * band steps, which reads as a glitch rather than as weather. Forty seconds is long enough
 * that the band breathes over minutes, which is what the aurora does.
 */
export const AURORA_FADE_S = 40;

/**
 * How much longer things linger when motion is off.
 *
 * The still sky is a long exposure, which is what a photograph of a meteor shower is. Four
 * times the normal life holds about nine seconds of arrivals on screen at once, so the frozen
 * frame is dense with streaks at every stage of drawing themselves in rather than sparse and
 * arbitrary. Every streak in it is still one edit, and the panel still names it.
 */
export const STILL_EXPOSURE = 4;
