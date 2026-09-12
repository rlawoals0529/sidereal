/**
 * The shader and `astro.ts` compute the same sky. This is what stops them drifting.
 *
 * There are two copies of the projection because there have to be: the GPU needs it to place
 * four thousand lights without the CPU touching them, and the CPU needs it to answer what is
 * under the cursor. Two copies of one formula is a real hazard and this is the guard, along
 * with an honest statement of what it does not cover.
 *
 * **What it catches.** Every `const float` in every shader source is lifted out and compared
 * numerically against the TypeScript export of the same name. A constant that exists in the
 * shader with no counterpart fails, so adding one without adding its twin is caught the first
 * time the suite runs rather than the first time somebody notices the horizon is in the wrong
 * place. The two expressions that silently produce a plausible wrong sky, the azimuth
 * convention and the stereographic factor, are pinned by shape as well.
 *
 * **What it does not catch.** It cannot execute GLSL, so it cannot prove the expressions
 * agree. Restructure an expression on one side and you must restructure it on the other; the
 * numbers are guarded, the algebra is on you.
 */
import { describe, expect, it } from "vitest";
import * as astro from "../../src/sky/astro.ts";
import * as constants from "../../src/sky/constants.ts";
import { SKY_MATH, VIEW_BLOCK } from "../../src/sky/gl/glsl.ts";
import {
  ARC_FRAG,
  ARC_VERT,
  DISC_FRAG,
  DISC_VERT,
  RING_FRAG,
  RING_VERT,
  STAR_FRAG,
  STAR_VERT,
  STREAK_FRAG,
  STREAK_VERT,
} from "../../src/sky/gl/shaders.ts";

const SOURCES = {
  STREAK_VERT, STREAK_FRAG,
  RING_VERT, RING_FRAG,
  DISC_VERT, DISC_FRAG,
  ARC_VERT, ARC_FRAG,
  STAR_VERT, STAR_FRAG,
};

/**
 * Which TypeScript value each shader constant has to equal.
 *
 * Every `const float` in the GLSL must appear here. That is the whole mechanism: a new
 * shader constant with no entry fails the "nothing is unaccounted for" case below, which
 * makes adding one a prompt to decide where its real definition lives.
 */
const EXPECTED: Record<string, number> = {
  PI: Math.PI,
  RAD_PER_DEG: astro.DEG,
  DEG_PER_RAD: astro.RAD,
  EXTINCTION_K: astro.EXTINCTION_K,
  KASTEN_YOUNG_A: astro.KASTEN_YOUNG_A,
  KASTEN_YOUNG_B: astro.KASTEN_YOUNG_B,
  KASTEN_YOUNG_C: astro.KASTEN_YOUNG_C,
  ANTIPODE_CUT: astro.ANTIPODE_CUT,
  DIURNAL_STEP_RAD: astro.DIURNAL_STEP_RAD,
  EARTH_RADIUS_KM: constants.EARTH_RADIUS_KM,
  RAYLEIGH_KM_S: constants.RAYLEIGH_KM_S,
  QUAKE_LIFE_S: constants.QUAKE_LIFE_S,
  RING_SEGMENTS: constants.RING_SEGMENTS,
  SPREAD_R0: constants.SPREAD_R0,
  METEOR_LIFE_S: constants.METEOR_LIFE_S,
  METEOR_DRAW_S: constants.METEOR_DRAW_S,
  METEOR_MIN_DEG: constants.METEOR_MIN_DEG,
  METEOR_MAX_DEG: constants.METEOR_MAX_DEG,
  STAR_TWINKLE: constants.STAR_TWINKLE,
  STAR_TWINKLE_RATE: constants.STAR_TWINKLE_RATE,
  STAR_CORE: constants.STAR_CORE,
};

function shaderConstants(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/const\s+float\s+([A-Z0-9_]+)\s*=\s*(-?[0-9.eE+-]+)\s*;/g)) {
    out.set(m[1]!, Number(m[2]));
  }
  return out;
}

/** Whitespace-insensitive, so reformatting does not fail this but rewriting does. */
function squash(s: string): string {
  return s.replace(/\s+/g, " ");
}

describe("shader and TypeScript agree", () => {
  const found = new Map<string, number>();
  for (const src of [SKY_MATH, ...Object.values(SOURCES)]) {
    for (const [k, v] of shaderConstants(src)) found.set(k, v);
  }

  it("finds constants at all, so a broken regex cannot pass this file", () => {
    expect(found.size).toBeGreaterThanOrEqual(Object.keys(EXPECTED).length);
  });

  it.each([...Object.keys(EXPECTED)])("%s has the same value on both sides", (name) => {
    const glsl = found.get(name);
    expect(glsl, `${name} is not declared in any shader`).toBeTypeOf("number");
    const ts = EXPECTED[name]!;
    // Relative, because the shader writes literals at the precision a float32 can hold and
    // SPREAD_R0 in particular is a rounded sine.
    expect(Math.abs(glsl! - ts) / Math.max(1e-9, Math.abs(ts))).toBeLessThan(1e-6);
  });

  it("leaves nothing in the shaders unaccounted for", () => {
    const orphans = [...found.keys()].filter((k) => !(k in EXPECTED));
    expect(orphans, `shader constants with no TypeScript twin: ${orphans.join(", ")}`).toEqual([]);
  });
});

describe("the two expressions that fail silently", () => {
  it("still converts Meeus's south-based azimuth to a north-based one", () => {
    // Drop this `+ PI` and every assertion about altitude still passes while the sky is
    // mirrored. It is the single most dangerous line in the shader.
    expect(squash(SKY_MATH)).toContain("return vec2(asin(sinAlt), azFromSouth + PI);");
  });

  it("still uses the stereographic factor and not a gnomonic or equidistant one", () => {
    // 2/(1+z) is what makes a circle on the sphere a circle on the screen, which is what an
    // earthquake ring depends on. Any other factor here draws eggs.
    expect(squash(SKY_MATH)).toContain("float k = 2.0 / (1.0 + z);");
  });

  it("still refuses the antipode rather than producing an enormous coordinate", () => {
    expect(squash(SKY_MATH)).toContain("if (z <= ANTIPODE_CUT)");
  });
});

describe("the shared uniform block", () => {
  it("is byte for byte the same text in every program", () => {
    // std140 requires an identical declaration in both stages and in every program sharing
    // the binding point. Two programs that disagree read each other's memory as garbage, and
    // the symptom is a sky in the wrong place rather than an error.
    for (const [name, src] of Object.entries(SOURCES)) {
      expect(src.includes(VIEW_BLOCK), `${name} does not carry the shared View block`).toBe(true);
    }
  });

  it("covers the star program too, which is the newest way to forget it", () => {
    // The catalogue's shader was added to the renderer before it was added to this list, and
    // for one commit its three constants were unguarded. Naming it here is the reminder that
    // SOURCES is a hand-kept list and a new program has to join it.
    expect(Object.keys(SOURCES)).toContain("STAR_VERT");
    expect(Object.keys(SOURCES)).toContain("STAR_FRAG");
  });

  it("is six vec4s, which is what the scene fills", () => {
    const members = [...VIEW_BLOCK.matchAll(/^\s*vec4\s+\w+;/gm)];
    expect(members).toHaveLength(6);
  });
});
