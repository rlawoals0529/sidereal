/**
 * The four programs. Five draws a frame: streaks, rings, discs, then arcs twice.
 *
 * Four rather than one per kind because two kinds that want the same geometry should share
 * it. Aurora cells, visitors and the ISS head are all a disc with a per-instance colour,
 * size and softness, so they are one instanced draw with one buffer. The ISS track and the
 * horizon are both a ribbon along a path, so they are one program drawn twice with different
 * buffers. Streaks and rings genuinely need their own geometry and get it.
 *
 * A note on why the ribbon is not `gl.LINE_STRIP`. `lineWidth` above 1.0 is silently ignored
 * on every current desktop driver, so a line program produces a hairline whatever you ask
 * for and you find out when someone looks at it on a high density display. Ribbons of two
 * triangles per segment always work.
 */
import { fragmentSource, vertexSource } from "./glsl.ts";

export const STREAK_VERT = vertexSource(`
in vec2 aEq;     // declination and right ascension, radians, fixed when the edit happened
in vec2 aInfo;   // seconds since epoch at which it happened, magnitude 0..1

out float vAlong;
out float vAcross;
out float vHot;
out float vAlpha;

const float METEOR_LIFE_S = 7.0;
const float METEOR_DRAW_S = 0.9;
const float METEOR_MIN_DEG = 0.9;
const float METEOR_MAX_DEG = 11.0;

void main() {
  float life = METEOR_LIFE_S * uExposure;
  float age = uNow - aInfo.x;
  if (age < 0.0 || age > life) { gl_Position = skyDiscard(); vAlpha = 0.0; return; }

  vec2 h0 = skyHorizontal(aEq.x, aEq.y, uLst);
  vec4 p0 = skyProject(skyLocal(h0));
  float ext = skyExtinction(h0.x);
  if (p0.z < 0.5 || ext <= 0.0) { gl_Position = skyDiscard(); vAlpha = 0.0; return; }

  // Which way the sky is carrying this point, finite differenced through the projection
  // itself so it cannot fall out of step with it. A Wikipedia edit has no direction of
  // travel and we do not invent one: this is the diurnal motion of the sphere, which is a
  // real velocity we already know, and it is what makes the streaks fan out around the
  // celestial pole instead of pointing wherever a random number sent them.
  vec4 p1 = skyProject(skyLocal(skyHorizontal(aEq.x, aEq.y, uLst + DIURNAL_STEP_RAD)));
  vec2 d = p1.xy - p0.xy;
  float dl = length(d);
  vec2 dir = dl > 1e-6 ? d / dl : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  float along = float(gl_VertexID >> 1);
  float across = float(gl_VertexID & 1) * 2.0 - 1.0;

  float drawn = clamp(age / (METEOR_DRAW_S * uExposure), 0.0, 1.0);
  drawn = drawn * drawn * (3.0 - 2.0 * drawn);

  // Angular length through the conformal factor, so a six degree streak is six degrees of
  // sky wherever it lands rather than six degrees at the zenith and four near the edge.
  float lenPx = mix(METEOR_MIN_DEG, METEOR_MAX_DEG, aInfo.y) * RAD_PER_DEG * p0.w * uScale;

  vec2 px = p0.xy + dir * (lenPx * drawn * along) + perp * (across * uHalfW * mix(0.45, 1.15, along));
  gl_Position = skyClip(px);

  vAlong = along;
  vAcross = across;
  vHot = aInfo.y;
  vAlpha = mix(0.20, 1.0, aInfo.y) * ext * pow(1.0 - age / life, 1.8);
}
`);

export const STREAK_FRAG = fragmentSource(`
in float vAlong;
in float vAcross;
in float vHot;
in float vAlpha;
uniform vec3 uInk;
uniform vec3 uInkHot;

void main() {
  // Cross section, and the taper from tail to head. The head carries the colour shift: a
  // big edit is a brighter and hotter streak because the magnitude is bytes changed, and
  // that is the only thing driving either.
  float core = exp(-3.2 * vAcross * vAcross);
  emit(mix(uInk, uInkHot, vHot * vHot), vAlpha * core * mix(0.08, 1.0, vAlong));
}
`);

export const RING_VERT = vertexSource(`
in vec2 aEq;
in vec2 aInfo;   // seconds since epoch at which it happened, magnitude 0..1

out float vAcross;
out float vAlpha;

const float QUAKE_LIFE_S = 360.0;
const float SPREAD_R0 = 0.017452406;
const float RING_SEGMENTS = 96.0;

void main() {
  float life = QUAKE_LIFE_S * uExposure;
  float age = uNow - aInfo.x;
  if (age < 0.0 || age > life) { gl_Position = skyDiscard(); vAlpha = 0.0; return; }

  vec3 c = skyLocal(skyHorizontal(aEq.x, aEq.y, uLst));
  vec4 pc = skyProject(c);
  if (pc.z < 0.5) { gl_Position = skyDiscard(); vAlpha = 0.0; return; }

  // The real Rayleigh wavefront. Not a radius chosen to look geological: 3.5 km/s on a
  // 6371 km sphere reaches 11.3 degrees of arc in six minutes, and the reason the ring is
  // slow is that the ground is slow.
  float r = RAYLEIGH_KM_S * age / EARTH_RADIUS_KM;

  float seg = float(gl_VertexID >> 1);
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  float th = seg / RING_SEGMENTS * 2.0 * PI;

  // Half width in radians, taken at the centre of the ring rather than per vertex. Exact
  // overhead, a few percent narrow for a ring straddling the horizon, where extinction has
  // already taken most of it.
  float dr = uHalfW / max(uScale * pc.w, 1e-3);
  float rr = max(r + side * dr, 0.0);

  // Any two vectors perpendicular to the centre will do; the switch only avoids taking a
  // cross product with something parallel to it, which is zero and then a divide by zero.
  vec3 ref = abs(c.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(c, ref));
  vec3 w = cross(c, u);
  vec3 p = c * cos(rr) + (u * cos(th) + w * sin(th)) * sin(rr);

  vec4 pp = skyProject(p);
  if (pp.z < 0.5) { gl_Position = skyDiscard(); vAlpha = 0.0; return; }
  gl_Position = skyClip(pp.xy);

  vAcross = side;
  float spread = sqrt(SPREAD_R0 / max(sin(rr), SPREAD_R0));
  // Three seconds of rise so an event that arrives in a batch does not appear as a hard edge,
  // and extinction per vertex so the part of a ring that is under the horizon is not drawn.
  vAlpha = mix(0.25, 1.0, aInfo.y)
    * skyExtinction(asin(clamp(p.z, -1.0, 1.0)))
    * spread
    * smoothstep(0.0, 3.0, age)
    * (1.0 - age / life);
}
`);

export const RING_FRAG = fragmentSource(`
in float vAcross;
in float vAlpha;
uniform vec3 uInk;

void main() {
  emit(uInk, vAlpha * exp(-2.0 * vAcross * vAcross));
}
`);

export const DISC_VERT = vertexSource(`
in vec2 aEq;     // declination and right ascension, OR altitude and azimuth: see aForm.w
in vec4 aFade;   // value before, value after, second the cross started, how long it takes
in vec4 aForm;   // angular diameter deg, softness 0..1, drift amplitude px, 1 if already horizontal
in vec3 aColor;
in float aSeed;  // 0..1, hashed from the light's own id so two lights never drift in step

out vec2 vUv;
out vec3 vColor;
out float vSharp;
out float vAlpha;

void main() {
  // A visitor is the one light that is not on the celestial sphere. All we are told about
  // where somebody is is where they are looking, so that is where their light goes, live, in
  // the viewer's own frame. It does not turn with the sky because it is not on the sky, and
  // that difference is legible: the world rotates past, the people stay where they are
  // looking.
  vec2 h = aForm.w > 0.5 ? aEq : skyHorizontal(aEq.x, aEq.y, uLst);
  vec4 p = skyProject(skyLocal(h));
  float ext = skyExtinction(h.x);
  if (p.z < 0.5 || ext <= 0.0) { gl_Position = skyDiscard(); vAlpha = 0.0; return; }

  // Between two measured probabilities, never toward an invented one. This is the aurora
  // breathing, and it breathes over forty seconds because OVATION lands every five minutes
  // and a step would read as a glitch.
  float a = mix(aFade.x, aFade.y, clamp((uNow - aFade.z) / max(aFade.w, 0.001), 0.0, 1.0));

  // The social signal, and the only place in the renderer where motion encodes a state
  // rather than a measurement. A visitor in a focus session has drift zero: it holds dead
  // still while the idle ones wander, and holding still beside things that do not is the
  // entire cue. Both channels, position and brightness, so it survives being small.
  float live = 1.0 - uFrozen;
  float drifting = step(0.001, aForm.z) * live;
  vec2 wobble = aForm.z * live * vec2(
    sin(uNow * 0.11 + aSeed * 6.2832),
    sin(uNow * 0.083 + aSeed * 9.9110)
  );
  float twinkle = 1.0 + 0.22 * drifting * sin(uNow * 0.7 + aSeed * 12.566);

  // Size in degrees of sky, carried to pixels through the conformal factor, so a light keeps
  // its angular size wherever it lands and changing the field of view zooms it correctly. The
  // floor stops the faintest aurora cell from falling below a pixel and disappearing.
  float diamPx = max(aForm.x * RAD_PER_DEG * p.w * uScale, 1.5);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  gl_Position = skyClip(p.xy + wobble + corner * (diamPx * 0.5));

  vUv = corner;
  vColor = aColor;
  vSharp = mix(9.0, 2.0, aForm.y);
  vAlpha = a * ext * twinkle;
}
`);

export const DISC_FRAG = fragmentSource(`
in vec2 vUv;
in vec3 vColor;
in float vSharp;
in float vAlpha;

void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  emit(vColor, vAlpha * exp(-vSharp * d2));
}
`);

export const ARC_VERT = vertexSource(`
in vec2 aA;      // this point on the path
in vec2 aB;      // the next one, so the ribbon knows which way it is going
in vec2 aMeta;   // side -1 or +1, brightness 0..1

uniform int uArcSpace;    // 0 the pair is equatorial, 1 it is already altitude and azimuth
uniform float uArcWidth;

out float vAcross;
out float vAlpha;

vec2 toAltAz(vec2 v) {
  return uArcSpace == 1 ? v : skyHorizontal(v.x, v.y, uLst);
}

void main() {
  vec2 ha = toAltAz(aA);
  vec4 pa = skyProject(skyLocal(ha));
  if (pa.z < 0.5) { gl_Position = skyDiscard(); vAlpha = 0.0; return; }
  vec4 pb = skyProject(skyLocal(toAltAz(aB)));

  vec2 d = pb.z > 0.5 ? pb.xy - pa.xy : vec2(1.0, 0.0);
  float dl = length(d);
  vec2 dir = dl > 1e-6 ? d / dl : vec2(1.0, 0.0);
  gl_Position = skyClip(pa.xy + vec2(-dir.y, dir.x) * (aMeta.x * uArcWidth));

  vAcross = aMeta.x;
  // The horizon is a coordinate reference rather than something in the air, so it is not
  // dimmed by the air. The ISS is in the air and is.
  vAlpha = aMeta.y * (uArcSpace == 1 ? 1.0 : skyExtinction(ha.x));
}
`);

export const ARC_FRAG = fragmentSource(`
in float vAcross;
in float vAlpha;
uniform vec3 uInk;

void main() {
  emit(uInk, vAlpha * exp(-1.6 * vAcross * vAcross));
}
`);

/**
 * The fixed stars. One instanced draw, 8,920 quads, and nothing per frame but the rotation.
 *
 * Every per-star number that could be worked out in advance was: brightness from magnitude,
 * diameter from brightness, colour from the colour index and the palette. All of it is written
 * into the instance buffer once, at load, by `stars.ts`, which is also the only copy of those
 * curves in the project. Doing it here instead would have meant a second implementation of the
 * magnitude scale for the parity test to guard, for arithmetic whose inputs never change.
 *
 * What is left is what genuinely varies: where the star is in the observer's sky this instant,
 * how much air its light came through, and the shimmer. That is the same rotation uniform every
 * other layer reads, so adding the catalogue costs one more draw call and no new per-frame work.
 *
 * The diameter is in DEVICE PIXELS, not degrees, and that is the one place a star deliberately
 * behaves unlike an aurora cell. A star is unresolvable: what is on screen is a point spread
 * function, so it is sized in pixels and zooming magnifies the image the way magnifying a
 * photograph magnifies the grain. Carrying it through the conformal factor instead, as the disc
 * layer does, would grow Sirius to a twenty-pixel ball at a 25 degree field of view.
 */
export const STAR_VERT = vertexSource(`
in vec2 aEq;      // declination and right ascension, radians, J2000
in vec2 aPoint;   // core diameter in device px, core alpha 0..1
in vec3 aGlare;   // quad diameter in device px, glare peak, spike peak
in vec3 aColor;
in float aSeed;   // 0..1, from the catalogue index, so no two stars shimmer in step

out vec2 vUv;
out vec3 vColor;
out float vCorePx;   // core radius, device px
out float vHalfPx;   // quad radius, device px, which is what vUv is measured against
out float vCore;     // the core's own alpha
out vec2 vSkirt;     // glare peak, spike peak
out float vSky;      // everything the atmosphere does: extinction times scintillation

const float STAR_TWINKLE = 0.055;
const float STAR_TWINKLE_AIRMASS_EXP = 1.75;
const float STAR_TWINKLE_MAX = 0.55;
const float STAR_TWINKLE_RATE = 2.6;

void main() {
  vec2 h = skyHorizontal(aEq.x, aEq.y, uLst);
  vec4 p = skyProject(skyLocal(h));
  float ext = skyExtinction(h.x);
  if (p.z < 0.5 || ext <= 0.0) { gl_Position = skyDiscard(); vSky = 0.0; return; }

  // Scintillation, and the airmass it follows is a measurement rather than a ramp. A star is a
  // point source, so the whole of it is displaced by one pocket of moving air at a time; the
  // scintillation index goes as the airmass to the power 1.75 (Young 1967), which is why the
  // low sky flickers hard and the zenith only trembles. The airmass here is skyAirmass, the
  // same Kasten and Young fit the extinction two lines up is using, so the two cannot disagree
  // about how much air this star is behind. The rate is slowed to something an eye can read and
  // says so in constants.ts. Zero when motion is reduced, like everything else that moves.
  float live = 1.0 - uFrozen;
  float amplitude = min(STAR_TWINKLE * pow(skyAirmass(h.x), STAR_TWINKLE_AIRMASS_EXP), STAR_TWINKLE_MAX);
  float shimmer = 1.0 + amplitude * live * sin(uNow * STAR_TWINKLE_RATE + aSeed * 6.2832);

  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  gl_Position = skyClip(p.xy + corner * (aGlare.x * 0.5));

  vUv = corner;
  vColor = aColor;
  vCorePx = max(aPoint.x * 0.5, 0.0001);
  vHalfPx = max(aGlare.x * 0.5, 0.0001);
  vCore = aPoint.y;
  vSkirt = aGlare.yz;
  vSky = ext * shimmer;
}
`);

export const STAR_FRAG = fragmentSource(`
in vec2 vUv;
in vec3 vColor;
in float vCorePx;
in float vHalfPx;
in float vCore;
in vec2 vSkirt;
in float vSky;

const float STAR_CORE = 3.6;
const float GLARE_R0_PX = 3.0;
const float SPIKE_ARMS = 6.0;
const float SPIKE_SHARP = 34.0;

void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  // Radius in real pixels, because the quad is a different size for every star and a profile
  // measured against the quad would make a faint star's halo the same shape as Sirius's.
  float rPx = max(d * vHalfPx, 0.35);

  float core = vCore * exp(-STAR_CORE * (rPx * rPx) / (vCorePx * vCorePx));

  // The glare skirt: what scattering in the air and inside the eye lays around a bright point,
  // falling off as the inverse square of the angle from it. That is the Stiles and Holladay
  // term of the CIE disability glare equation, and it is the reason a bright star reads as a
  // blaze rather than a dot. The peak is set on the CPU from the star's REAL flux, so this
  // picks out the bright ones by itself and is exactly zero for the 8,484 that cannot carry it.
  float skirt = 0.0;
  if (vSkirt.x > 0.0) {
    float fall = (GLARE_R0_PX * GLARE_R0_PX) / (rPx * rPx);
    // The arms of the spike, which are the same skirt with the aperture's angular signature on
    // it. Six, because the eye's own lens sutures are a Y at the front and an inverted Y at the
    // back, and that grating is why a bright star looks pointed to a person at all. Only the
    // stars whose skirt is wide enough to resolve an arm carry one; see SPIKE_AT_PX.
    //
    // A sine rather than a cosine, which puts an arm straight up instead of straight out to
    // the side. The sutures are fixed with respect to the head rather than to the sky, so the
    // pattern is fixed on the screen either way and this is the orientation a person sees.
    float arms = vSkirt.y > 0.0
      ? pow(abs(sin(SPIKE_ARMS * 0.5 * atan(vUv.y, vUv.x))), SPIKE_SHARP)
      : 0.0;
    // Faded out over the last fifth of the quad. Without it the skirt stops at whatever value
    // it had reached and leaves a faint disc edge, which is a circle nobody measured.
    skirt = (vSkirt.x + vSkirt.y * arms) * fall * smoothstep(1.0, 0.8, d);
  }

  emit(vColor, vSky * (core + skirt));
}
`);
