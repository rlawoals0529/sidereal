/**
 * The fixed stars: 8,920 measured records, and how a measurement becomes a pixel.
 *
 * `stars.generated.ts` is the catalogue as bytes. This file is the part with answers that can
 * be right or wrong, so it lives here where a plain node test can reach it: decoding, the
 * magnitude curve, the colour, and the reason each of them is the shape it is.
 *
 * **A star is not decoration and is not chrome.** It is a Hipparcos position and a photometric
 * measurement, the same class of thing as a USGS magnitude, and it goes through the ledger like
 * one. See `provenance.ts` for what that costs and why it does not soften the rule.
 *
 * Three things below are measurements, cited. Everything else is a display decision and says so.
 */
import { DEG, equatorialUnit, type LocalVec } from "./astro.ts";
import type { RGB } from "./palette.ts";
import { STAR_BYTES, STAR_COUNT, STAR_MAG_LIMIT, STAR_NAMES } from "./stars.generated.ts";

export { STAR_COUNT, STAR_MAG_LIMIT };

/**
 * One catalogue entry, as everything downstream reads it.
 *
 * `raRad`/`decRad` are the J2000 position and `unit` is that position as a direction, cached
 * because the hit test needs it 8,920 times per pointer move. `mag` and `ci` are the
 * photometry, at the precision the six-byte encoding holds and no further: the panel prints
 * magnitude to two decimals because the encoding steps by a thirtieth of a magnitude, and
 * printing more digits than that would be inventing precision the file does not carry.
 */
export type Star = {
  /** Index into the catalogue, brightest first. Also its identity in the ledger. */
  index: number;
  raRad: number;
  decRad: number;
  /** Apparent visual magnitude. Lower is brighter; the scale is logarithmic and inverted. */
  mag: number;
  /** Colour index B minus V. Negative is hot and blue, positive is cool and red. */
  ci: number;
  /** Proper name, for the 120 brightest that have one. Null is the ordinary case. */
  name: string | null;
  /** IAU three-letter constellation abbreviation, or null alongside a null name. */
  constellation: string | null;
  unit: LocalVec;
};

/**
 * The brightest magnitude the display range is anchored to.
 *
 * Sirius is the brightest star in the catalogue at -1.44, so this is that rounded down. It is
 * a reference point for the curve below, not a claim about any star.
 */
export const STAR_MAG_BRIGHTEST = -1.5;

/**
 * The exponent that turns flux into screen brightness, and the only honest way to fit a real
 * sky into a display.
 *
 * The magnitude scale is logarithmic and inverted by definition: five magnitudes is exactly a
 * factor of 100 in flux, so one magnitude is 100^(1/5), about 2.512. Over the eight magnitudes
 * from Sirius to the naked-eye limit that is a range of 1,585 to 1. A display has 255 levels,
 * most of which are unusable against a dark ground, so mapping flux straight to alpha puts the
 * entire faint half of the catalogue below one 8-bit step and the sky comes out as thirty
 * bright dots on black. Mapping magnitude to alpha linearly instead is worse in the other
 * direction: it is the one thing that makes a sky where every star reads the same.
 *
 * So flux is compressed by a power law, which is what the eye itself does. Stevens' power law
 * puts perceived brightness at intensity to roughly the third to the half; 0.4 sits inside
 * that range. The result spans 19 to 1 in alpha.
 *
 * The rest of the range is carried by area, which is the second real channel: a bright star's
 * point spread function is the same shape as a faint one's, but more of its wings clear the
 * threshold, so it occupies more of the frame. Alpha times area spans about 200 to 1 against a
 * true 1,585 to 1, and that compression is stated rather than hidden. What matters is that the
 * ORDER is exact and the ratios are monotone in real flux: Vega reads brighter than Polaris
 * because it is brighter, by an amount derived from the measurement.
 */
export const STAR_BRIGHTNESS_GAMMA = 0.4;

/**
 * The exposure the sky is printed at, and the reason the brightest stars clip.
 *
 * The curve above is a ratio, and a ratio still has to be placed somewhere in a display's
 * range. Placed so that Sirius is exactly full white, the naked-eye limit lands at a twentieth
 * of full, which on a dark ground is a difference of twelve 8-bit steps and is invisible. It
 * was invisible: the first pass of this drew all 8,920 and the page still looked empty, which
 * is the same failure as having no stars in it.
 *
 * So the whole curve is lifted until the FAINTEST star can be seen, and everything brighter
 * than about first magnitude runs off the top and clips. That is not a compromise, it is what
 * an exposure is. A photograph long enough to record sixth-magnitude stars has Vega and Sirius
 * blown out to flat white discs, and the only thing separating them on the plate is how wide
 * the blown-out disc is. Which is what happens here: above the clip the magnitude is carried
 * entirely by `sizeOf`, and Sirius is three times the width of Polaris because it is brighter.
 */
export const STAR_EXPOSURE = 3.4;

/** Pixels across a star at the faint limit and at the reference magnitude, before dpr. */
export const STAR_SIZE_MIN_PX = 2.2;
export const STAR_SIZE_MAX_PX = 7;

/**
 * Where naked-eye colour vision gives out, in magnitudes.
 *
 * Colour is a cone response and cones need light. Below roughly a hundredth of a candela per
 * square metre the eye is running on rods, which have no colour at all, and that is why a real
 * night sky is a field of white points with a handful of coloured ones in it: Betelgeuse is
 * visibly orange, Rigel visibly blue, and the fourth-magnitude star between them is not
 * visibly anything. So saturation fades out with magnitude rather than being applied flat.
 *
 * This is also the answer to "keep it subtle". The subtlety is not a taste dial that could
 * have been set anywhere; it is the shape of human vision, and setting it flat would be the
 * error.
 */
export const STAR_CHROMA_MAG = 3;
export const STAR_CHROMA_SPAN = 4;

/** Second radiation constant hc/k, metre kelvin. CODATA 2018. */
export const PLANCK_C2 = 0.014387769;
/** Where the three channels are sampled, metres. Loosely R, G and B. */
export const PLANCK_LAMBDA: readonly [number, number, number] = [6.0e-7, 5.5e-7, 4.5e-7];
/** Display transfer exponent. The palette tokens are sRGB, so the linear ratio is encoded to match. */
export const SRGB_GAMMA = 2.2;

/**
 * Relative flux from apparent magnitude, against magnitude zero. Pogson's ratio.
 *
 * The definition, not a fit: `m = -2.5 log10(F)`, read backwards.
 */
export function fluxOf(mag: number): number {
  return Math.pow(10, -0.4 * mag);
}

/**
 * Screen brightness 0..1 for a magnitude, with the reference magnitude at 1.
 *
 * Written as one power of ten rather than `fluxOf(...) ** gamma` so there is a single rounding
 * step, but it is the same curve: flux relative to `STAR_MAG_BRIGHTEST`, compressed by
 * `STAR_BRIGHTNESS_GAMMA`.
 */
export function brightnessOf(mag: number): number {
  return Math.min(1, STAR_EXPOSURE * relativeBrightness(mag));
}

/** The unclipped ratio, before the exposure is applied. Both of the above are built on it. */
function relativeBrightness(mag: number): number {
  return Math.pow(10, -0.4 * STAR_BRIGHTNESS_GAMMA * (mag - STAR_MAG_BRIGHTEST));
}

/**
 * Drawn diameter in pixels before the device pixel ratio.
 *
 * Squared, so the growth is confined to the genuinely bright end: everything from about fourth
 * magnitude down is a point of the same size and only the named stars bloom. That is the
 * behaviour of a point spread function against a threshold, and it is also what stops nine
 * thousand large soft dots from turning the frame into fog.
 */
export function sizeOf(mag: number): number {
  // The UNCLIPPED ratio, deliberately. Above the exposure's clip every star has the same alpha
  // and width is the only channel left carrying the magnitude, so reading the clipped value
  // here would flatten exactly the range this is here to hold.
  const b = Math.min(1, relativeBrightness(mag));
  return STAR_SIZE_MIN_PX + (STAR_SIZE_MAX_PX - STAR_SIZE_MIN_PX) * b * b;
}

/**
 * Colour index B minus V to an effective temperature, kelvin.
 *
 * Ballesteros (2012), *EPL* 97, 34008. A closed form fitted to the same blackbody assumption
 * the colour below uses, so the two halves agree by construction rather than by coincidence.
 *
 * Clamped at the blue end. The denominator `0.92 B-V + 0.62` reaches zero at B-V = -0.674,
 * which is bluer than any star in the catalogue, but a catalogue is a file and a file can
 * change; the clamp is there so a future one cannot divide by zero and paint a star infinity.
 */
export function kelvinOf(ci: number): number {
  const bv = ci < -0.4 ? -0.4 : ci > 2.5 ? 2.5 : ci;
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/**
 * A blackbody at `kelvin` as an sRGB triple, normalised so the strongest channel is 1.
 *
 * Planck's law sampled at three wavelengths and gamma encoded. It is deliberately not a
 * colorimetric integration against the CIE observer: three samples get the hue right and come
 * out slightly less saturated than the full integral, which for this use is the direction to
 * be wrong in. Checked against Mitchell Charity's blackbody table at both ends, a 10,000 K
 * star lands within a couple of 8-bit steps and a 3,500 K one is the right hue and quieter.
 *
 * The `lambda^-5` factor is the part that is easy to drop and impossible to notice afterwards.
 * Without it the ratio inverts and every hot star comes out red, which looks plausible enough
 * on a dark screen to survive a review.
 */
export function blackbodyRgb(kelvin: number): RGB {
  const v = PLANCK_LAMBDA.map((lambda) => {
    const x = PLANCK_C2 / (lambda * kelvin);
    return 1 / (Math.pow(lambda, 5) * (Math.exp(x) - 1));
  });
  const max = Math.max(v[0]!, v[1]!, v[2]!);
  const enc = (x: number): number => Math.pow(x / max, 1 / SRGB_GAMMA);
  return [enc(v[0]!), enc(v[1]!), enc(v[2]!)];
}

/**
 * What a star is actually drawn in: its own colour, faded toward the palette's neutral by how
 * much of it an eye could see.
 *
 * The hue is physical and comes from the photometry, not from a token, because the colour of a
 * star is a measurement and a palette is a mood. The NEUTRAL end is the palette's, which is the
 * honest place for it: a star too faint to have a visible colour is simply white, and the
 * page's own white is the right white to draw it in. So the palette sets the sky's cast and the
 * catalogue sets which stars escape it.
 */
export function starColour(mag: number, ci: number, neutral: RGB): RGB {
  const sat = Math.max(0, Math.min(1, (STAR_CHROMA_MAG - mag) / STAR_CHROMA_SPAN));
  if (sat <= 0) return neutral;
  const bb = blackbodyRgb(kelvinOf(ci));
  return [
    neutral[0] + (bb[0] - neutral[0]) * sat,
    neutral[1] + (bb[1] - neutral[1]) * sat,
    neutral[2] + (bb[2] - neutral[2]) * sat,
  ];
}

/** How the six bytes per star are laid out. Mirrors `scripts/stars.mjs`; change both. */
const BYTES_PER_STAR = 6;
const RA_HOURS_TO_RAD = (Math.PI * 2) / 24;

let cached: readonly Star[] | null = null;

/**
 * The catalogue, decoded once for the life of the page.
 *
 * Once, and not per frame or per sky: the base64 is 71 kB and the decode allocates nine
 * thousand objects, which is nothing at startup and would be a stutter every time somebody
 * switched palette. Nothing mutates a `Star`, so one array can back every sky in the document.
 *
 * `atob` rather than `Buffer`, because this runs in a browser and in node, and only one of
 * them has `Buffer`.
 */
export function catalogue(): readonly Star[] {
  if (cached) return cached;

  const names = new Map<number, readonly [string, string]>();
  for (const [index, name, con] of STAR_NAMES) names.set(index, [name, con]);

  const binary = atob(STAR_BYTES);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);

  const stars: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const o = i * BYTES_PER_STAR;
    const raRad = (view.getUint16(o) / 65535) * 24 * RA_HOURS_TO_RAD;
    const decRad = ((view.getInt16(o + 2) / 32767) * 90) * DEG;
    const mag = view.getUint8(o + 4) / 30 - 2;
    const ci = view.getUint8(o + 5) / 100 - 0.4;
    const named = names.get(i);
    stars.push({
      index: i,
      raRad,
      decRad,
      mag,
      ci,
      name: named?.[0] ?? null,
      constellation: named?.[1] ?? null,
      unit: equatorialUnit(decRad, raRad),
    });
  }

  cached = stars;
  return stars;
}

/**
 * The star in words, for the panel, and every clause of it is something a catalogue measured.
 *
 * Two decimals on the magnitude because the encoding steps by 1/30; the constellation only
 * when the catalogue gave one. An unnamed star says so rather than being given a designation
 * the file does not contain.
 */
export function describeStar(s: Star): string {
  const mag = `magnitude ${s.mag.toFixed(2)}`;
  if (s.name === null) return `Unnamed star, ${mag}`;
  return s.constellation === null ? `${s.name}, ${mag}` : `${s.name}, ${mag}, ${s.constellation}`;
}
