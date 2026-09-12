/**
 * The sky, as the GPU sees it.
 *
 * The decision this file exists to serve: **an event's instance data is written once, when
 * the event lands, and never touched again.** Rotation, ageing, decay, the growth of a
 * meteor streak and the expansion of a seismic wavefront are all functions of one uniform
 * clock and per-instance constants, so a frame with four thousand live lights and no new
 * arrivals uploads ninety-six bytes and issues five draws. Per-frame cost tracks the arrival
 * rate, not the population, and that is the whole reason 60fps is reachable here rather than
 * hoped for.
 *
 * The arithmetic in `SKY_MATH` is a hand-written mirror of `../astro.ts`. That is a real
 * risk and it is worth being plain about: two copies of one formula drift. What guards it is
 * `test/sky/projection-parity.test.ts`, which lifts every named constant out of this source
 * text and compares it numerically against the export of the same name in `astro.ts`. That
 * catches a changed number, which is where drift actually happens. It cannot execute GLSL,
 * so it cannot catch a changed expression. If you restructure an expression here, restructure
 * it there in the same edit.
 *
 * GLSL ES 3.00 throughout, so `gl_VertexID` exists and instancing is core rather than an
 * extension. Constants are `const float` with the names the parity test looks for; do not
 * inline them.
 */

/** The uniform block every program shares, so one 96-byte upload serves the whole frame. */
export const VIEW_BLOCK = `
layout(std140) uniform View {
  vec4 uRightScale;   // xyz observer's screen-right in east/north/up, w pixels per plane unit
  vec4 uUpHalfW;      // xyz observer's screen-up,                     w half line width, px
  vec4 uFwdNow;       // xyz direction of gaze,                        w seconds since epoch
  vec4 uSky;          // x local sidereal time, y sin(lat), z cos(lat), w 1 when negative mode
  vec4 uPxFrozen;     // xy pixels to clip space, z exposure multiplier, w 1 when frozen
  vec4 uBgDim;        // rgb background colour,                        a global brightness
};
#define uRight    uRightScale.xyz
#define uScale    uRightScale.w
#define uUp       uUpHalfW.xyz
#define uHalfW    uUpHalfW.w
#define uForward  uFwdNow.xyz
#define uNow      uFwdNow.w
#define uLst      uSky.x
#define uSinPhi   uSky.y
#define uCosPhi   uSky.z
#define uNegative uSky.w
#define uPxToClip uPxFrozen.xy
#define uExposure uPxFrozen.z
#define uFrozen   uPxFrozen.w
#define uBg       uBgDim.rgb
#define uDim      uBgDim.a
`;

/**
 * Equatorial to horizontal to screen. The mirror of `astro.ts`; read that file for the why.
 *
 * `skyProject` returns `vec4(x px, y px, ok, k)`. `k` is the conformal factor of the
 * stereographic map at that point, which callers need in order to draw something of a given
 * *angular* size: the projection is conformal, so a small feature of angular size `a` lands
 * at plane size `a * k` in every direction, which is the property a non-conformal projection
 * would not give us and the reason an earthquake ring stays a circle.
 */
export const SKY_MATH = `
const float PI = 3.141592653589793;
const float RAD_PER_DEG = 0.017453292519943295;
const float DEG_PER_RAD = 57.29577951308232;

const float EXTINCTION_K = 0.2;
const float KASTEN_YOUNG_A = 0.50572;
const float KASTEN_YOUNG_B = 6.07995;
const float KASTEN_YOUNG_C = -1.6364;
const float ANTIPODE_CUT = -0.999;
const float DIURNAL_STEP_RAD = 1e-4;

const float EARTH_RADIUS_KM = 6371.0;
const float RAYLEIGH_KM_S = 3.5;

vec2 skyHorizontal(float dec, float ra, float lst) {
  float H = lst - ra;
  float sd = sin(dec), cd = cos(dec);
  float sinAlt = clamp(uSinPhi * sd + uCosPhi * cd * cos(H), -1.0, 1.0);
  float azFromSouth = atan(cd * sin(H), cd * cos(H) * uSinPhi - sd * uCosPhi);
  return vec2(asin(sinAlt), azFromSouth + PI);
}

vec3 skyLocal(vec2 altAz) {
  float c = cos(altAz.x);
  return vec3(c * sin(altAz.y), c * cos(altAz.y), sin(altAz.x));
}

vec4 skyProject(vec3 v) {
  float z = dot(v, uForward);
  if (z <= ANTIPODE_CUT) return vec4(0.0, 0.0, 0.0, 0.0);
  float k = 2.0 / (1.0 + z);
  return vec4(k * dot(v, uRight) * uScale, k * dot(v, uUp) * uScale, 1.0, k);
}

float skyExtinction(float alt) {
  if (alt <= 0.0) return 0.0;
  float airmass = 1.0 / (sin(alt) + KASTEN_YOUNG_A * pow(alt * DEG_PER_RAD + KASTEN_YOUNG_B, KASTEN_YOUNG_C));
  return pow(10.0, -0.4 * EXTINCTION_K * (airmass - 1.0));
}

/** Pixels to clip space. The one place the y flip lives. */
vec4 skyClip(vec2 px) {
  return vec4(px * uPxToClip, 0.0, 1.0);
}

/** Off-screen and zero-area, for an instance that should not be drawn this frame. */
vec4 skyDiscard() { return vec4(2.0, 2.0, 2.0, 1.0); }
`;

/**
 * The fragment tail every program ends with.
 *
 * Two blend modes, because eight of yozora's fifteen palettes are light. On a dark ground
 * light adds, which is what light does; on a light ground the same additive pass washes out
 * to white and the sky disappears. The light palettes render as a photographic negative
 * instead, the way a plate of a star field has always been printed: the renderer switches to
 * `FUNC_REVERSE_SUBTRACT` and this outputs `bg - ink` so a mark at full strength lands
 * exactly on its own token colour and overlapping marks get darker, which is the honest
 * analogue of overlapping light getting brighter.
 */
export const INK_OUT = `
out vec4 fragColor;
void emit(vec3 colour, float alpha) {
  float a = clamp(alpha, 0.0, 1.0) * uDim;
  if (a <= 0.0) discard;
  vec3 src = uNegative > 0.5 ? max(uBg - colour, vec3(0.0)) : colour;
  fragColor = vec4(src * a, a);
}
`;

const HEAD = `#version 300 es
precision highp float;
`;

export function vertexSource(body: string): string {
  return HEAD + VIEW_BLOCK + SKY_MATH + body;
}

export function fragmentSource(body: string): string {
  return HEAD + VIEW_BLOCK + INK_OUT + body;
}
