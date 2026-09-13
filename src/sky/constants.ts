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

/**
 * How long a meteor is on the sky, and why it is not a claim about the edit.
 *
 * An edit happens at an instant. How long its mark stays on screen is a rendering decision in
 * exactly the way the size of a dot on a scatter plot is, and it was set to 2.2 seconds by
 * taste before anybody had watched a real sky.
 *
 * Measured, the Wikipedia sip yields about four drawable edits per second of reading and reads
 * for two seconds in every ten, so roughly six meteors arrive per ten seconds. At 2.2 seconds
 * of life that is on average slightly more than one meteor on screen, and the sky read as
 * broken rather than as quiet. At seven it holds about four at a time, each visibly drawing
 * itself in, fading, and gone before you have stopped noticing it.
 *
 * The rule is untouched. Every streak is still one edit and the panel still names it. There
 * are not more lights than there were events, they simply last long enough to be seen.
 */
export const METEOR_LIFE_S = 7;

/**
 * How long the streak takes to draw itself in, seconds.
 *
 * Longer than it was, because the drawing-in is the part worth watching and at 0.42 seconds it
 * was over before the eye arrived. It stays a small fraction of the life, so a meteor spends
 * most of its time complete and fading rather than still being drawn.
 */
export const METEOR_DRAW_S = 0.9;

/**
 * Angular length of the smallest and largest streak, degrees.
 *
 * Raised with the lifetime, for the same reason: when a light is one of four on an otherwise
 * empty sky it has to carry the frame. The scale is still the magnitude curve, so a one byte
 * edit is still a scratch and a ten kilobyte rewrite still crosses a visible arc.
 */
export const METEOR_MIN_DEG = 0.9;
export const METEOR_MAX_DEG = 11;

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

/**
 * How much a star's brightness wanders, and the published law that says where.
 *
 * Scintillation is why stars twinkle and planets do not: a star is a point source, so the whole
 * of it is displaced by one pocket of moving air at a time, where a planet's disc averages many
 * pockets and holds steady. It is also why this is a naked-eye effect: the amplitude falls off
 * sharply with aperture, so the same star through a telescope barely moves.
 *
 * **The dependence on airmass is a measurement, not a ramp.** The scintillation index goes as
 * the airmass to the power 1.75 (Young, 1967, *AJ* 72, 747, and the same exponent is in Dravins
 * et al.'s review). `STAR_TWINKLE` is the amplitude at the ZENITH, where the airmass is one, so
 * the law gives about three and a half times that at thirty degrees altitude and twenty times it
 * at ten, which is why the low sky flickers and the top of it barely does. The airmass comes
 * from `skyAirmass`, the same Kasten and Young fit the extinction uses, so the two cannot
 * disagree about how much air a star is being seen through.
 *
 * The first version of this used `airmass - 1`, which is zero at the zenith. That is the wrong
 * physics in the one place it is easiest to check: a star overhead does twinkle, a little.
 *
 * `STAR_TWINKLE_MAX` is where the law is truncated. Below about ten degrees the published
 * exponent is fitted outside its range anyway, and a star that vanishes and returns is reading
 * as a rendering fault rather than as air.
 *
 * The RATE is not a measurement and must not be read as one. Real scintillation runs at tens of
 * hertz, which on a 60 Hz display is aliasing rather than shimmer, so this is slowed to
 * something an eye can follow. Radians per second, so 2.6 is about four tenths of a hertz. All
 * of it is off when motion is reduced.
 */
export const STAR_TWINKLE = 0.055;
export const STAR_TWINKLE_AIRMASS_EXP = 1.75;
export const STAR_TWINKLE_MAX = 0.55;
export const STAR_TWINKLE_RATE = 2.6;

/**
 * Where a star's glare skirt is anchored, in pixels before the device pixel ratio.
 *
 * A bright point source does not stop at its core. Light scatters on the way in, in the
 * atmosphere and again inside the eye, and lays a veil around it that falls off as the inverse
 * square of the angle from the source. That is the Stiles and Holladay form of the CIE
 * disability glare equation, and it is the reason a real bright star reads as a blaze rather
 * than as a dot; a one-pixel point cannot carry it, which is most of why a rendered sky looks
 * flat.
 *
 * This constant is the radius the inverse square law is quoted AT, so the profile is
 * `amplitude * (r0 / r)^2`. Both halves need it: the shader to draw the falloff, and `stars.ts`
 * to work out how far out the skirt is still above one display step, which is where the quad
 * has to end.
 */
export const GLARE_R0_PX = 3;

/**
 * The arms of a diffraction spike, and how tight each one is.
 *
 * Six, because this is a sky seen by eye rather than through a telescope. The crystalline lens
 * has radial suture lines, a Y at the front and an inverted Y at the back, and they act as a
 * phase grating: the six-rayed star that every culture draws is a picture of somebody's own
 * lens. A camera's four-vane spider gives four, which is the other number you see, but nothing
 * in this sky is being photographed.
 *
 * `SPIKE_SHARP` is the exponent that narrows each arm. It is taste bounded by sampling: much
 * above this and an arm is thinner than a pixel at the radius it starts from, and a feature
 * thinner than a pixel does not get finer, it aliases.
 */
export const SPIKE_ARMS = 6;
export const SPIKE_SHARP = 34;

/**
 * How tightly a star's light is gathered into the middle of its quad.
 *
 * The same falloff the disc layer uses, `exp(-sharp * r^2)`, at a value between the sharp end
 * of an ISS marker and the soft end of an aurora cell. It is what makes a bright star a core
 * with a halo around it rather than a flat circle, which is the shape a point source makes in
 * an optical system and in an eye.
 */
export const STAR_CORE = 3.6;

/**
 * The widest and narrowest the view can be dragged to, in degrees across the frame.
 *
 * 180 is the default and puts the whole hemisphere on screen with the horizon as a complete
 * ring. Wider than about 210 and the ring shrinks into the middle of a mostly empty frame with
 * the antipode stretching around it, which is a projection artefact rather than a view of
 * anything. Narrower than 20 and the stereographic projection is doing nothing a plain
 * magnifier would not: at that scale the sky is flat and the conformal property that earns this
 * projection its place has nothing left to preserve.
 */
export const FOV_MIN_DEG = 20;
export const FOV_MAX_DEG = 210;
