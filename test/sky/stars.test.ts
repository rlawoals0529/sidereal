/**
 * The catalogue: that it decodes to the sky somebody measured, that brightness is the real
 * scale rather than a ramp, and that nine thousand more lights did not cost the audit its
 * teeth.
 *
 * The magnitude tests are the ones worth reading. "Brighter stars are brighter" is satisfied by
 * any increasing function and says nothing; what is checked here is the RATIO, against the
 * definition of the magnitude scale, in the two places a wrong curve hides. A linear map passes
 * every ordering assertion and fails the ratio ones by a factor of five.
 */
import { describe, expect, it } from "vitest";
import {
  DEG,
  equatorialUnit,
  horizontal,
  localFromEquatorialUnit,
  localVec,
  lmstRad,
  gmstRad,
} from "../../src/sky/astro.ts";
import { STAR_CORE, STAR_TWINKLE } from "../../src/sky/constants.ts";
import { STAR_STRIDE, Scene, sceneOptions } from "../../src/sky/scene.ts";
import { CHROME, assertEveryLightIsEarned, backingId } from "../../src/sky/provenance.ts";
import { Renderer } from "../../src/sky/renderer.ts";
import { drawStill } from "../../src/sky/still2d.ts";
import { STAR_VERT } from "../../src/sky/gl/shaders.ts";
import {
  STAR_COUNT,
  STAR_EXPOSURE,
  STAR_MAG_LIMIT,
  blackbodyRgb,
  brightnessOf,
  catalogue,
  describeStar,
  fluxOf,
  kelvinOf,
  sizeOf,
  starColour,
  type Star,
} from "../../src/sky/stars.ts";
import { STAR_NAMES } from "../../src/sky/stars.generated.ts";
import { stubGl } from "./gl-stub.ts";
import { TWILIGHT, edit, paletteFromCss } from "./fixtures.ts";

const T = Date.UTC(2024, 5, 15, 3, 17, 42);
const HERE = { latDeg: 51.4769, lonDeg: -0.0005, gazeAzDeg: 180, gazeAltDeg: 90 };

function sky(over: { reducedMotion?: boolean } = {}): Scene {
  const scene = new Scene(sceneOptions({ palette: TWILIGHT, observer: HERE, epochMs: T, ...over }));
  scene.resize(900, 900, 1);
  scene.update(T);
  return scene;
}

const byName = (name: string): Star => {
  const star = catalogue().find((s) => s.name === name);
  if (!star) throw new Error(`no star called ${name} in the catalogue`);
  return star;
};

describe("the catalogue decodes to a real sky", () => {
  it("is the whole naked-eye sky and nothing fainter", () => {
    const stars = catalogue();
    expect(stars).toHaveLength(STAR_COUNT);
    expect(stars.length).toBeGreaterThan(8000);
    for (const s of stars) expect(s.mag).toBeLessThanOrEqual(STAR_MAG_LIMIT);
  });

  it("is ordered brightest first, which is what the name table indexes into", () => {
    const stars = catalogue();
    for (let i = 1; i < stars.length; i++) expect(stars[i]!.mag).toBeGreaterThanOrEqual(stars[i - 1]!.mag);
  });

  it("puts the named stars at the positions and magnitudes they are known by", () => {
    // Independent numbers, not read back out of the file: these are the catalogue values a
    // reference would give, and the tolerance is the quantisation the six-byte format costs.
    // A decode that dropped a factor, swapped two fields or lost the sign of a declination
    // fails here and nowhere else, because every other test would still see plausible dots.
    const cases = [
      { name: "Sirius", raHours: 6.752, decDeg: -16.716, mag: -1.44, con: "CMa" },
      { name: "Vega", raHours: 18.616, decDeg: 38.784, mag: 0.03, con: "Lyr" },
      { name: "Polaris", raHours: 2.53, decDeg: 89.264, mag: 1.97, con: "UMi" },
      { name: "Betelgeuse", raHours: 5.919, decDeg: 7.407, mag: 0.45, con: "Ori" },
      { name: "Acrux", raHours: 12.443, decDeg: -63.099, mag: 0.76, con: "Cru" },
    ];
    for (const c of cases) {
      const s = byName(c.name);
      expect(s.constellation).toBe(c.con);
      expect((s.raRad * 12) / Math.PI).toBeCloseTo(c.raHours, 2);
      expect(s.decRad / DEG).toBeCloseTo(c.decDeg, 2);
      expect(s.mag).toBeCloseTo(c.mag, 1);
    }
  });

  it("names exactly the stars the generated table names, and no others", () => {
    const named = catalogue().filter((s) => s.name !== null);
    expect(named).toHaveLength(STAR_NAMES.length);
    for (const [index, name, con] of STAR_NAMES) {
      expect(catalogue()[index]!.name).toBe(name);
      expect(catalogue()[index]!.constellation).toBe(con);
    }
  });

  it("carries its own unit vector, and that vector is the position", () => {
    for (const s of [byName("Sirius"), byName("Polaris"), catalogue()[4000]!]) {
      const u = equatorialUnit(s.decRad, s.raRad);
      expect(s.unit.x).toBeCloseTo(u.x, 12);
      expect(s.unit.y).toBeCloseTo(u.y, 12);
      expect(s.unit.z).toBeCloseTo(u.z, 12);
      expect(Math.hypot(s.unit.x, s.unit.y, s.unit.z)).toBeCloseTo(1, 12);
    }
  });

  it("decodes once and hands back the same array", () => {
    // Nine thousand objects per call would be a stutter on every palette change.
    expect(catalogue()).toBe(catalogue());
  });

  it("says what a star is in words, and says so honestly when it has no name", () => {
    expect(describeStar(byName("Vega"))).toBe("Vega, magnitude 0.03, Lyr");
    const anonymous = catalogue().find((s) => s.name === null)!;
    expect(describeStar(anonymous)).toMatch(/^Unnamed star, magnitude -?\d+\.\d\d$/);
  });
});

describe("the fast path through the sky is the same path", () => {
  it("agrees with horizontal then localVec everywhere it is used", () => {
    // The hit test and the 2D still both go through `localFromEquatorialUnit`, which is a
    // second derivation of Meeus 13.5 and 13.6 with the trigonometry collected out. Two
    // derivations of one formula is the hazard this whole file exists to guard, so it is
    // checked against the published form over a grid rather than at one convenient point.
    let worst = 0;
    for (const latDeg of [-89, -51.5, 0, 23.4, 51.5, 89]) {
      const sinPhi = Math.sin(latDeg * DEG);
      const cosPhi = Math.cos(latDeg * DEG);
      for (const lstHours of [0, 3.7, 9, 15.25, 21, 23.9]) {
        const lst = (lstHours * Math.PI) / 12;
        const sinLst = Math.sin(lst);
        const cosLst = Math.cos(lst);
        for (const decDeg of [-90, -66, -20, 0, 20, 66, 90]) {
          for (const raHours of [0, 2.5, 7, 12, 17.5, 23]) {
            const dec = decDeg * DEG;
            const ra = (raHours * Math.PI) / 12;
            const slow = localVec(horizontal({ dec, ra }, lst, sinPhi, cosPhi));
            const fast = localFromEquatorialUnit(equatorialUnit(dec, ra), sinLst, cosLst, sinPhi, cosPhi);
            worst = Math.max(worst, Math.abs(slow.x - fast.x), Math.abs(slow.y - fast.y), Math.abs(slow.z - fast.z));
          }
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("is consistent with the observer frame the scene builds", () => {
    // The frame's own sidereal time, not one the test computed, so a change to either end of
    // that chain shows up here.
    const scene = sky();
    const lst = lmstRad(T, HERE.lonDeg);
    expect(scene.view.lst).toBeCloseTo(lst, 12);
  });
});

describe("brightness is apparent magnitude on the real scale", () => {
  it("uses Pogson's ratio, so five magnitudes is a hundred times the light", () => {
    expect(fluxOf(0) / fluxOf(5)).toBeCloseTo(100, 6);
    expect(fluxOf(0) / fluxOf(1)).toBeCloseTo(2.511886, 5);
    // The brief's own figure: the naked-eye limit against magnitude zero.
    expect(fluxOf(0) / fluxOf(6.5)).toBeGreaterThan(390);
  });

  it("is inverted, because the scale is", () => {
    // Below the exposure's clip, which is where the alpha channel is doing the work. Above it
    // the ordering is carried by width instead, and that is checked further down.
    expect(brightnessOf(1.5)).toBeGreaterThan(brightnessOf(3));
    expect(brightnessOf(3)).toBeGreaterThan(brightnessOf(5));
    expect(brightnessOf(5)).toBeGreaterThan(brightnessOf(6.5));
  });

  it("is NOT linear in magnitude, which is the failure that looks fine", () => {
    // A linear ramp gives every equal step of magnitude an equal step of alpha. The real curve
    // does not: the drop from 3 to 4 is a far smaller absolute change than the drop from 4.5
    // to 5.5, because it is a fixed RATIO per magnitude and the absolute steps shrink. Two
    // adjacent unit intervals in the unclipped part of the range are compared, so the only way
    // to pass this is to be a curve.
    const dropHigh = brightnessOf(3) - brightnessOf(4);
    const dropLow = brightnessOf(4.5) - brightnessOf(5.5);
    expect(dropHigh).toBeGreaterThan(dropLow * 1.5);
  });

  it("keeps the ratio a magnitude of difference really is, below the exposure's clip", () => {
    // One magnitude is 2.512 in flux, and the display compresses that by the gamma, so the
    // ratio on screen is 2.512^0.4 = 1.4318. Checked at three places in the faint half, where
    // nothing is clipped and the curve is doing all the work.
    for (const m of [3.5, 4.5, 5.5]) {
      expect(brightnessOf(m) / brightnessOf(m + 1)).toBeCloseTo(Math.pow(2.511886, 0.4), 4);
    }
  });

  it("spans a visible range at both ends rather than bottoming out", () => {
    // The bug this closes: the first pass put the faint limit at 0.05, which is twelve 8-bit
    // steps over the ground and invisible, and the page still looked empty with all 8,920 of
    // them drawn.
    expect(brightnessOf(STAR_MAG_LIMIT)).toBeGreaterThan(0.14);
    expect(brightnessOf(STAR_MAG_LIMIT)).toBeLessThan(0.3);
    expect(brightnessOf(-1.44)).toBe(1);
  });

  it("carries the clipped range in width instead, so the bright stars are still ordered", () => {
    // Above the exposure's clip alpha is flat, so if width were also flat Sirius and Vega would
    // be indistinguishable. Reading the CLIPPED brightness inside `sizeOf` is exactly that bug.
    expect(brightnessOf(-1.44)).toBe(brightnessOf(0.03));
    expect(sizeOf(-1.44)).toBeGreaterThan(sizeOf(0.03) * 1.2);
    expect(sizeOf(0.03)).toBeGreaterThan(sizeOf(2));
    expect(sizeOf(2)).toBeGreaterThan(sizeOf(5));
  });

  it("puts the exposure in one place, so the curve and the lift cannot drift apart", () => {
    expect(brightnessOf(6)).toBeCloseTo(STAR_EXPOSURE * Math.pow(10, -0.16 * (6 + 1.5)), 10);
  });
});

describe("colour comes from the colour index", () => {
  it("turns a colour index into the temperature it stands for", () => {
    // Ballesteros, checked against the values the relation is quoted with.
    expect(kelvinOf(0)).toBeGreaterThan(9000);
    expect(kelvinOf(0)).toBeLessThan(11000);
    expect(kelvinOf(1.5)).toBeLessThan(4200);
    expect(kelvinOf(-0.3)).toBeGreaterThan(15000);
  });

  it("makes a hot star blue and a cool star orange, not the other way round", () => {
    // The `lambda^-5` factor in Planck's law is the one that inverts this if it is dropped,
    // and a sky of red hot stars on a dark screen looks entirely plausible.
    const hot = blackbodyRgb(kelvinOf(-0.3));
    const cool = blackbodyRgb(kelvinOf(1.6));
    expect(hot[2]).toBeGreaterThan(hot[0]);
    expect(cool[0]).toBeGreaterThan(cool[2]);
    expect(hot[2]).toBe(1);
    expect(cool[0]).toBe(1);
  });

  it("lands where a blackbody table says it should", () => {
    // Mitchell Charity's sRGB renderings, to a few per cent. Three samples of Planck's law
    // come out a little less saturated than the full integral, which is stated in `stars.ts`.
    const vega = blackbodyRgb(9940);
    expect(vega[0]).toBeGreaterThan(0.7);
    expect(vega[0]).toBeLessThan(0.85);
    expect(vega[1]).toBeGreaterThan(0.79);
    expect(vega[2]).toBe(1);
  });

  it("gives a faint star no colour at all, because an eye gives it none", () => {
    const neutral = TWILIGHT.star;
    expect(starColour(4, -0.3, neutral)).toEqual(neutral);
    expect(starColour(6.4, 1.6, neutral)).toEqual(neutral);
  });

  it("and gives a bright one its own, pulled away from the palette", () => {
    const neutral = TWILIGHT.star;
    const rigel = starColour(0.18, -0.03, neutral);
    const betelgeuse = starColour(0.45, 1.85, neutral);
    expect(rigel).not.toEqual(neutral);
    // Blue-white against orange-red, with the palette's own white in between.
    expect(rigel[2] - rigel[0]).toBeGreaterThan(neutral[2] - neutral[0]);
    expect(betelgeuse[0] - betelgeuse[2]).toBeGreaterThan(neutral[0] - neutral[2]);
  });

  it("stays subtle: no star is a saturated dot", () => {
    // Every star in the catalogue, at its own magnitude and colour index. The spread between
    // the strongest and weakest channel is what "saturated" means, and this is the assertion
    // that fails if somebody removes the magnitude fade or turns it up.
    let worst = 0;
    for (const s of catalogue()) {
      const c = starColour(s.mag, s.ci, TWILIGHT.star);
      worst = Math.max(worst, Math.max(...c) - Math.min(...c));
    }
    expect(worst).toBeLessThan(0.62);
  });
});

describe("the stars go through the provenance ledger like everything else", () => {
  it("admits one record per star, and every drawn slot names one", () => {
    const scene = sky();
    expect(scene.ledger.size).toBeGreaterThanOrEqual(STAR_COUNT);
    const slots = [...scene.stars.liveSlots()];
    expect(slots).toHaveLength(STAR_COUNT);
    for (const slot of slots) {
      const key = scene.stars.slotBacking(slot);
      expect(key).toBe(`s:${slot}`);
      const backing = scene.ledger.get(key!);
      expect(backing?.of).toBe("star");
    }
  });

  it("keys a star by its catalogue index, in its own namespace", () => {
    const star = byName("Vega");
    expect(backingId({ of: "star", star })).toBe(`s:${star.index}`);
    // And it cannot collide with a revision id that happens to be a number.
    expect(backingId({ of: "star", star })).not.toBe(`e:${star.index}`);
  });

  it("does not put stars on the chrome list, which is the shortcut this refuses", () => {
    expect([...CHROME]).toEqual(["horizon"]);
    const scene = sky();
    const { gl } = stubGl();
    const renderer = new Renderer(gl, scene);
    renderer.render();
    expect(scene.runAudit(renderer.draws()).chrome).toEqual(["horizon"]);
  });

  it("a star slot with no record fails the audit, exactly as a meteor's would", () => {
    const scene = sky();
    const { gl } = stubGl();
    const renderer = new Renderer(gl, scene);
    renderer.render();
    // Planted the way the bug would arrive: a layer filled a slot and recorded nothing.
    (scene.stars as unknown as { keys: (string | null)[] }).keys[77] = null;
    const a = scene.runAudit(renderer.draws());
    expect(a.violations).toEqual([
      { where: "stars", slot: 77, why: "drawn slot has no backing record" },
    ]);
    expect(() => assertEveryLightIsEarned(a)).toThrowError(/no backing record/);
  });

  it("a star whose record was forgotten fails too", () => {
    const scene = sky();
    const { gl } = stubGl();
    const renderer = new Renderer(gl, scene);
    renderer.render();
    scene.ledger.forget("s:3");
    const a = scene.runAudit(renderer.draws());
    expect(a.violations).toHaveLength(1);
    expect(a.violations[0]!.why).toContain("s:3 is not in the ledger");
  });

  it("drawing more stars than the catalogue holds fails, so there is nowhere to hide one", () => {
    const scene = sky();
    const { gl } = stubGl();
    const renderer = new Renderer(gl, scene);
    renderer.render();
    const a = scene.runAudit(
      renderer.draws().map((d) => (d.source === "layer:stars" ? { ...d, instances: STAR_COUNT + 1 } : d)),
    );
    expect(a.violations[0]!.why).toBe(`drew ${STAR_COUNT + 1} instances but only ${STAR_COUNT} slots are live`);
  });

  it("a populated sky with the catalogue in it is still entirely earned", () => {
    const scene = sky();
    scene.push(Array.from({ length: 60 }, (_, i) => edit(T - i * 40)));
    scene.update(T);
    const { gl } = stubGl();
    const renderer = new Renderer(gl, scene);
    renderer.render();
    const a = scene.runAudit(renderer.draws());
    expect(a.violations).toEqual([]);
    expect(a.backed).toBeGreaterThan(STAR_COUNT);
  });
});

describe("drawing the catalogue", () => {
  it("is one instanced draw for the whole sky", () => {
    const scene = sky();
    const { gl, log } = stubGl();
    const renderer = new Renderer(gl, scene);
    renderer.render();
    const starDraws = renderer.draws().filter((d) => d.source === "layer:stars");
    expect(starDraws).toHaveLength(1);
    expect(starDraws[0]!.instances).toBe(STAR_COUNT);
    // Four vertices a star, instanced. Anything per-star on the draw side would show here.
    expect(log.draws.some((d) => d.count === 4 && d.instances === STAR_COUNT)).toBe(true);
  });

  it("uploads the catalogue once and never again on a steady frame", () => {
    // The whole performance argument: the positions never change, so after the first frame the
    // star buffer contributes nothing to the per-frame cost.
    const scene = sky();
    const { gl, log } = stubGl();
    const renderer = new Renderer(gl, scene);
    renderer.render();
    const first = log.uploads.filter((u) => u.lengthFloats === STAR_COUNT * STAR_STRIDE).length;
    expect(first).toBe(1);
    log.uploads.length = 0;
    for (let i = 1; i <= 30; i++) {
      scene.update(T + i * 16);
      renderer.render();
    }
    expect(log.uploads.filter((u) => u.lengthFloats > 1000)).toEqual([]);
  });

  it("writes each star's own brightness, size and colour into the instance", () => {
    const scene = sky();
    const sirius = byName("Sirius");
    const faint = catalogue()[STAR_COUNT - 1]!;
    const at = (s: Star, field: number): number => scene.stars.data[s.index * STAR_STRIDE + field]!;
    expect(at(sirius, 0)).toBeCloseTo(sirius.decRad, 6);
    expect(at(sirius, 1)).toBeCloseTo(sirius.raRad, 6);
    expect(at(sirius, 2)).toBeCloseTo(sizeOf(sirius.mag), 5);
    expect(at(sirius, 3)).toBeCloseTo(brightnessOf(sirius.mag), 6);
    expect(at(sirius, 2)).toBeGreaterThan(at(faint, 2));
    expect(at(sirius, 3)).toBeGreaterThan(at(faint, 3));
    // The seed, so two neighbours never shimmer in step.
    expect(at(sirius, 7)).not.toBe(at(catalogue()[1]!, 7));
  });

  it("scales the drawn size with the device pixel ratio, since it is measured in pixels", () => {
    const one = sky();
    const two = sky();
    two.resize(900, 900, 2);
    const i = byName("Vega").index * STAR_STRIDE + 2;
    expect(two.stars.data[i]!).toBeCloseTo(one.stars.data[i]! * 2, 5);
  });

  it("repaints the catalogue when the palette changes", () => {
    // The neutral end of a star's colour is the palette's, so a palette change has to reach
    // nine thousand instances or the sky keeps the old page's white.
    const scene = sky();
    const faint = catalogue()[STAR_COUNT - 1]!;
    const at = faint.index * STAR_STRIDE + 4;
    const before = scene.stars.data[at]!;
    scene.setPalette(paletteFromCss("sakura-lake"));
    expect(scene.stars.data[at]).not.toBeCloseTo(before, 4);
    expect(scene.stars.data[at]).toBeCloseTo(paletteFromCss("sakura-lake").star[0]!, 5);
  });

  it("dims the low sky with the same extinction every other layer uses", () => {
    // Not a fade invented to stop things popping in: the star shader calls `skyExtinction`,
    // which is the Kasten and Young airmass the meteors and the rings go through.
    expect(STAR_VERT).toContain("skyExtinction(h.x)");
    expect(STAR_VERT).toContain("vAlpha = aPoint.y * ext");
  });

  it("stops shimmering when motion is reduced", () => {
    // `uFrozen` is the scene's reduced-motion flag, and the amplitude is multiplied by its
    // complement. Without this the still composition is not still.
    expect(STAR_VERT).toContain("float live = 1.0 - uFrozen;");
    expect(STAR_VERT).toContain("STAR_TWINKLE * live");
    expect(STAR_TWINKLE).toBeGreaterThan(0);
    expect(STAR_CORE).toBeGreaterThan(0);
  });

  it("puts the catalogue in the still composition too", () => {
    // The 2D path is what a machine without WebGL2 gets, and a still sky with no stars in it
    // is the same empty rectangle this whole change is about.
    const scene = sky({ reducedMotion: true });
    const rects: string[] = [];
    const ctx = {
      fillStyle: "", strokeStyle: "", lineWidth: 1, globalCompositeOperation: "source-over",
      setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
      fillRect() { rects.push(String(ctx.fillStyle)); },
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
    };
    drawStill(ctx as unknown as CanvasRenderingContext2D, scene);
    // The ground, then a square per faint star above the horizon.
    expect(rects.length).toBeGreaterThan(1000);
    expect(rects.length).toBeLessThan(STAR_COUNT);
  });
});

describe("pointing at a star", () => {
  /** Where a star is on screen right now, worked out from `astro.ts` and not from the scene. */
  const screenOf = (scene: Scene, star: Star): { x: number; y: number; alt: number } => {
    const f = scene.view;
    const h = horizontal({ dec: star.decRad, ra: star.raRad }, f.lst, f.sinPhi, f.cosPhi);
    const v = localVec(h);
    const z = v.x * f.forward.x + v.y * f.forward.y + v.z * f.forward.z;
    const k = 2 / (1 + z);
    const s = scene.viewport.scale / scene.viewport.dpr;
    return {
      x: scene.viewport.widthCss / 2 + k * (v.x * f.right.x + v.y * f.right.y + v.z * f.right.z) * s,
      y: scene.viewport.heightCss / 2 - k * (v.x * f.up.x + v.y * f.up.y + v.z * f.up.z) * s,
      alt: h.alt,
    };
  };

  /** The brightest star that is properly up at this instant, so the test is not about luck. */
  const target = (scene: Scene): { star: Star; at: { x: number; y: number; alt: number } } => {
    for (const star of catalogue()) {
      const at = screenOf(scene, star);
      if (at.alt > 40 * DEG) return { star, at };
    }
    throw new Error("no star is well above the horizon at this instant");
  };

  it("names the star under the cursor, where the projection says it is", () => {
    const scene = sky();
    const { star, at } = target(scene);
    const hit = scene.hitTest(at.x, at.y);
    expect(hit?.kind).toBe("star");
    expect(hit?.star?.index).toBe(star.index);
    expect(hit?.x).toBeCloseTo(at.x, 3);
    expect(hit?.y).toBeCloseTo(at.y, 3);
  });

  it("says it in words the panel can print", () => {
    const scene = sky();
    const { star } = target(scene);
    const at = screenOf(scene, star);
    const hit = scene.hitTest(at.x, at.y)!;
    expect(hit.label).toBe(describeStar(star));
    expect(hit.label).toMatch(/magnitude -?\d/);
    expect(hit.encoding).toContain("magnitude");
    expect(hit.encoding).toContain("2.512");
    expect(hit.encoding).toContain("airmasses");
    // A catalogue position is a measurement, so nothing here may read as inferred.
    expect(hit.inferredPlacement).toBe(false);
    expect(hit.event).toBeNull();
    expect(hit.visitor).toBeNull();
  });

  it("gives the altitude and azimuth the star really has", () => {
    const scene = sky();
    const { star, at } = target(scene);
    const h = horizontal({ dec: star.decRad, ra: star.raRad }, scene.view.lst, scene.view.sinPhi, scene.view.cosPhi);
    const hit = scene.hitTest(at.x, at.y)!;
    expect(hit.altDeg).toBeCloseTo(h.alt / DEG, 6);
    expect(((hit.azDeg % 360) + 360) % 360).toBeCloseTo(h.az / DEG, 6);
  });

  it("lets an event win, because an event is momentary and a star is always there", () => {
    // Without this rule the evidence panel could never be pointed at a meteor: at a 180 degree
    // field there is usually a star within a few pixels of any point on the sky.
    const scene = sky();
    const { star, at } = target(scene);
    expect(scene.hitTest(at.x, at.y)?.star?.index).toBe(star.index);

    // An edit pinned to the star's own point of the celestial sphere, so the two are genuinely
    // on the same pixel rather than merely near each other. An event's declination is the
    // latitude it happened at and its right ascension is the local sidereal time there, so this
    // is that relation read backwards.
    scene.push([
      edit(T, {
        id: "over-the-star",
        lat: star.decRad / DEG,
        lon: (star.raRad - gmstRad(T)) / DEG,
      }),
    ]);
    scene.update(T);
    const overlapped = scene.hitTest(at.x, at.y);
    expect(overlapped?.kind).toBe("edit");
    expect(overlapped?.event?.id).toBe("over-the-star");
  });

  it("will not name a star that is below the horizon", () => {
    const scene = sky();
    const below = catalogue().find((s) => screenOf(scene, s).alt < -20 * DEG)!;
    for (let x = 0; x <= 900; x += 45) {
      for (let y = 0; y <= 900; y += 45) {
        expect(scene.hitTest(x, y)?.star?.index).not.toBe(below.index);
      }
    }
  });

  it("prefers the brighter of two stars the cursor is between", () => {
    // Scored by distance to the drawn EDGE rather than to its centre, so the star you can see
    // wins over the anonymous speck that happens to be a pixel closer to the pointer.
    //
    // The search below is looking for a cursor position where the two rules DISAGREE: a faint
    // star strictly nearer the pointer than a bright one, and the bright one still answered.
    // Under centre scoring no such position exists anywhere in the sky, so the search comes
    // back empty and this fails on the first assertion. Placing the cursor merely near a bright
    // star, which is what the first version of this test did, is answered the same way by both
    // rules and proves nothing.
    const scene = sky();
    const radiusOf = (star: Star): number => scene.stars.data[star.index * STAR_STRIDE + 2]! / 2;

    type Trap = { bright: Star; faint: Star; cursor: { x: number; y: number }; toFaint: number; toBright: number };
    const trap = ((): Trap | null => {
      for (const bright of catalogue()) {
        if (bright.mag > 1.5) break;
        const b = screenOf(scene, bright);
        if (b.alt < 25 * DEG) continue;
        const rb = radiusOf(bright);
        for (const faint of catalogue()) {
          if (faint.index === bright.index || faint.mag < 4) continue;
          const f = screenOf(scene, faint);
          if (f.alt <= 0) continue;
          const gap = Math.hypot(f.x - b.x, f.y - b.y);
          if (gap < 0.5) continue;
          // Just past the midpoint, so the faint star is nearer, and inside the bright star's
          // own width, so it is still a candidate at all.
          const t = gap / 2 + (rb - radiusOf(faint)) / 4;
          if (t - rb > 2.5) continue;
          const cursor = { x: b.x + ((f.x - b.x) * t) / gap, y: b.y + ((f.y - b.y) * t) / gap };
          const toFaint = Math.hypot(cursor.x - f.x, cursor.y - f.y);
          const toBright = Math.hypot(cursor.x - b.x, cursor.y - b.y);
          if (toFaint >= toBright) continue;
          if (scene.hitTest(cursor.x, cursor.y)?.star?.index !== bright.index) continue;
          return { bright, faint, cursor, toFaint, toBright };
        }
      }
      return null;
    })();

    expect(trap, "no cursor anywhere in this sky is answered with the brighter of two stars").not.toBeNull();
    const { bright, faint, cursor, toFaint, toBright } = trap!;
    // Restated as assertions rather than left in the search, so what was found is on the page.
    expect(faint.mag).toBeGreaterThan(bright.mag + 2);
    expect(toFaint).toBeLessThan(toBright);
    expect(scene.hitTest(cursor.x, cursor.y)?.star?.index).toBe(bright.index);
  });
});

describe("the one line a panel prints", () => {
  it("hands an event's own label straight back, unchanged", () => {
    // The field exists for stars. It must not become a second, embellished description of an
    // event, which is the thing `SkyEvent.label` is documented never to be.
    const scene = sky();
    const event = edit(T, { lat: HERE.latDeg, lon: HERE.lonDeg, label: "en.wikipedia: Sidereal time" });
    scene.push([event]);
    scene.update(T);
    const hit = scene.hitTest(scene.viewport.widthCss / 2, scene.viewport.heightCss / 2);
    expect(hit?.kind).toBe("edit");
    expect(hit?.label).toBe(event.label);
  });

  it("says what a visitor is without printing a server-assigned id as a name", () => {
    const scene = sky();
    scene.upsertVisitor(
      { id: "sv_8812", palette: "twilight-comet", az: 180, alt: 90, focused: true, since: T },
      false,
    );
    scene.update(T);
    const hit = scene.hitTest(scene.viewport.widthCss / 2, scene.viewport.heightCss / 2);
    expect(hit?.kind).toBe("visitor");
    expect(hit?.label).toBe("A visitor, in a focus session");
    expect(hit?.label).not.toContain("sv_8812");
    // The record is still there for anything that genuinely needs the id.
    expect(hit?.visitor?.id).toBe("sv_8812");
  });
});
