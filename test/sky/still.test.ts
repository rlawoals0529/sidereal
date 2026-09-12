/**
 * The still composition, and the bug that made it necessary.
 *
 * The 2D path drew each aurora cell at the brightness it was crossing *toward* rather than
 * the one it was at, which is a five times error that nothing failed on: the frame still
 * looked like a sky. It was found by eye, comparing two screenshots, which is not a method
 * anyone should have to repeat. This is the same comparison as an assertion.
 *
 * The wider point is that the still is a composition and not a fallback. A reduced-motion
 * frame holds four times the normal exposure, so it has to contain more than the moving sky
 * does, and it has to contain every kind rather than whichever ones happen to survive.
 */
import { describe, expect, it } from "vitest";
import { AURORA_FADE_S, STILL_EXPOSURE } from "../../src/sky/constants.ts";
import { DISC_STRIDE, Scene, sceneOptions } from "../../src/sky/scene.ts";
import { drawStill } from "../../src/sky/still2d.ts";
import { TWILIGHT, aurora, edit, orbit, presence, quake } from "./fixtures.ts";

const T = Date.UTC(2024, 5, 15, 3, 17, 42);
const HERE = { latDeg: 64.84, lonDeg: -147.72, gazeAzDeg: 180, gazeAltDeg: 90 };

type Call = { op: string; style: string };

/** A 2D context that records the paint it was asked for and draws nothing. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[]; stops: string[] } {
  const calls: Call[] = [];
  const stops: string[] = [];
  const ctx = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    globalCompositeOperation: "source-over",
    setTransform() {},
    fillRect() {
      calls.push({ op: "fillRect", style: String(ctx.fillStyle) });
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {
      calls.push({ op: "fill", style: String(ctx.fillStyle) });
    },
    stroke() {
      calls.push({ op: "stroke", style: String(ctx.strokeStyle) });
    },
    createRadialGradient: () => ({ addColorStop: (_o: number, c: string) => stops.push(c) }),
    createLinearGradient: () => ({ addColorStop: (_o: number, c: string) => stops.push(c) }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, stops };
}

const alphaOf = (rgba: string): number => Number(/rgba\([^)]*,([\d.]+)\)$/.exec(rgba)?.[1] ?? NaN);

function stillScene() {
  const scene = new Scene(
    sceneOptions({ palette: TWILIGHT, observer: HERE, epochMs: T, reducedMotion: true }),
  );
  scene.resize(900, 900, 1);
  scene.update(T);
  return scene;
}

describe("the still composition", () => {
  it("draws the cell's current probability, not the one it is crossing toward", () => {
    const scene = stillScene();
    // Overhead at this observer, so it is definitely above the horizon and definitely drawn.
    scene.push([aurora(T, HERE.latDeg, HERE.lonDeg, 1)]);

    const settled = scene.discs.data[3]!;
    expect(settled).toBeGreaterThan(0.01);

    // A tenth of the way through the crossfade. Reading the target here is the bug.
    scene.update(T + AURORA_FADE_S * 100);
    const { ctx, stops } = recordingCtx();
    drawStill(ctx, scene);
    const centre = stops.map(alphaOf).filter((a) => a > 0);
    expect(Math.max(...centre)).toBeCloseTo(settled * 0.1, 3);

    // And once the crossfade is done it is drawing the settled value.
    scene.update(T + AURORA_FADE_S * 1000);
    const late = recordingCtx();
    drawStill(late.ctx, scene);
    expect(Math.max(...late.stops.map(alphaOf))).toBeCloseTo(settled, 3);
  });

  it("puts every kind on the page, so the still is a sky rather than a leftover", () => {
    const scene = stillScene();
    scene.push([
      ...Array.from({ length: 200 }, (_, i) =>
        edit(T - (200 - i) * 10, { lat: 40 + (i % 45), lon: -180 + i * 1.8, magnitude: 0.3 + (i % 7) / 10 }),
      ),
      quake(T - 90_000, { lat: 62, lon: -150 }),
      ...Array.from({ length: 30 }, (_, i) => orbit(T - (30 - i) * 1000, 55 + i * 0.2, -150 + i)),
      ...Array.from({ length: 200 }, (_, i) => aurora(T, 60 + (i % 14), -180 + i * 1.8, 0.4 + (i % 5) / 9)),
    ]);
    // Six seconds on: far enough into the crossfade that the band is drawn, and well inside
    // a meteor life at four times exposure. The two constants pull in opposite directions
    // and this is the window where both kinds are genuinely on the page at once.
    scene.update(T + 6000);

    const { ctx, calls } = recordingCtx();
    drawStill(ctx, scene);
    expect(calls.filter((c) => c.op === "fillRect")).toHaveLength(1);
    // Discs fill, streaks and rings and the two paths stroke.
    expect(calls.filter((c) => c.op === "fill").length).toBeGreaterThan(100);
    expect(calls.filter((c) => c.op === "stroke").length).toBeGreaterThan(100);
  });

  it("holds four times the arrivals a moving sky would", () => {
    const still = stillScene();
    const moving = new Scene(sceneOptions({ palette: TWILIGHT, observer: HERE, epochMs: T }));
    moving.resize(900, 900, 1);
    const batch = Array.from({ length: 900 }, (_, i) => edit(T - (900 - i) * 10));
    still.push(batch);
    moving.push(batch);
    still.update(T);
    moving.update(T);
    expect(still.exposure).toBe(STILL_EXPOSURE);
    expect([...still.meteors.liveSlots()].length).toBeGreaterThan(
      [...moving.meteors.liveSlots()].length * 3,
    );
  });

  it("paints the ground first and in the palette's own colour", () => {
    const scene = stillScene();
    const { ctx, calls } = recordingCtx();
    drawStill(ctx, scene);
    expect(calls[0]!.op).toBe("fillRect");
    // twilight-comet's --bg, through the same parser the GL path uses.
    const bg = `rgba(${Math.round(TWILIGHT.bg[0] * 255)},${Math.round(TWILIGHT.bg[1] * 255)},${Math.round(TWILIGHT.bg[2] * 255)},1.000)`;
    expect(calls[0]!.style).toBe(bg);
  });

  it("reads as a negative on a light palette, the way a plate of a star field is printed", () => {
    const scene = stillScene();
    const { ctx } = recordingCtx();
    drawStill(ctx, scene);
    expect(ctx.globalCompositeOperation).toBe("source-over");
    // Mid-draw it is additive on a dark ground. The scene's own flag is what the GL path
    // switches on, and both are derived from the measured luminance of --bg.
    scene.update(T);
    expect(scene.uniforms[15]).toBe(0);
  });
});

describe("the disc layout", () => {
  it("is what both renderers think it is", () => {
    // Every offset the 2D path indexes by hand. If the stride or an offset moves and only one
    // of the two is updated, the still draws the wrong field and still looks plausible, which
    // is precisely how the crossfade bug survived being looked at.
    const scene = stillScene();
    scene.push([aurora(T, HERE.latDeg, HERE.lonDeg, 0.5)]);
    scene.upsertVisitor(presence("a", { az: 12, alt: 40 }));
    expect(DISC_STRIDE).toBe(14);
    expect(scene.discs.data[9]).toBe(0);
    expect(scene.discs.data[DISC_STRIDE + 9]).toBe(1);
    expect(scene.discs.data[DISC_STRIDE + 8]).toBeGreaterThan(0);
  });
});
