/**
 * Looking around: that a drag moves the sky by the amount the hand moved, that a fling stops,
 * that the zenith does not flip the world over, and that a motion preference takes the
 * animation away without taking the controls away.
 *
 * All of it runs in plain node. A camera is arithmetic over a gaze, and every failure worth
 * catching here is a number rather than a pixel: an inverted sign, a clamp applied after the
 * rotation instead of before it, a decay that never reaches zero, a key rate that depends on
 * the frame rate. The browser half is `test/ui/keyboard-walk.mjs` and the DOM half is
 * `controls.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  Camera,
  FLING_WINDOW_MS,
  GLIDE_TAU_S,
  KEY_LOOK_DEG_S,
  MAX_ALT_DEG,
  MIN_ALT_DEG,
  radiansPerCssPixel,
} from "../../src/sky/camera.ts";
import { FOV_MAX_DEG, FOV_MIN_DEG } from "../../src/sky/constants.ts";
import { DEG, RAD, rotateGaze } from "../../src/sky/astro.ts";

const HOME = { azDeg: 180, altDeg: 90, fovDeg: 180 };
/** A view that is not at the zenith, so azimuth is well defined and a horizontal drag has work. */
const TILTED = { azDeg: 180, altDeg: 45, fovDeg: 90 };

const make = (over: Partial<typeof HOME> = {}, reduced = false): Camera =>
  new Camera({ ...HOME, ...over }, reduced);

/** Angle between two gaze directions, degrees. The only honest way to measure "how far it moved". */
function separation(a: { azDeg: number; altDeg: number }, b: { azDeg: number; altDeg: number }): number {
  const v = (g: { azDeg: number; altDeg: number }) => {
    const c = Math.cos(g.altDeg * DEG);
    return [c * Math.sin(g.azDeg * DEG), c * Math.cos(g.azDeg * DEG), Math.sin(g.altDeg * DEG)];
  };
  const [ax, ay, az] = v(a) as [number, number, number];
  const [bx, by, bz] = v(b) as [number, number, number];
  return Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz))) * RAD;
}

describe("rotating the gaze", () => {
  it("moves by the angle it was asked for", () => {
    for (const alt of [-15, 0, 30, 60, 89]) {
      const next = rotateGaze(120, alt, 0.05, 0);
      expect(separation({ azDeg: 120, altDeg: alt }, next)).toBeCloseTo(0.05 * RAD, 2);
    }
  });

  it("keeps the horizon level, because there is no roll to accumulate", () => {
    // Screen-right is defined from the azimuth alone in `viewFrame`, so a long wandering drag
    // cannot tilt the frame. A camera built on a free quaternion would, and the symptom is a
    // horizon that ends up at an angle with nothing to put it back.
    let g = { azDeg: 45, altDeg: 20 };
    for (let i = 0; i < 400; i++) {
      g = rotateGaze(g.azDeg, g.altDeg, 0.02 * Math.sin(i / 7), 0.02 * Math.cos(i / 5));
    }
    // The only state is an azimuth and an altitude, so being able to read them back as a valid
    // pair IS the absence of roll.
    expect(Number.isFinite(g.azDeg)).toBe(true);
    expect(g.altDeg).toBeGreaterThan(-90);
    expect(g.altDeg).toBeLessThan(90);
  });

  it("holds the azimuth at the zenith rather than picking one out of the noise", () => {
    // Straight up is where this sky opens, and azimuth has no value there. Whatever `atan2`
    // returns for a direction that is 1e-17 off the pole is numerical noise, and taking it
    // would spin the frame on the first pixel of any drag.
    const next = rotateGaze(180, 90, 0, 0);
    expect(next.azDeg).toBe(180);
    expect(next.altDeg).toBe(90);
  });
});

describe("dragging", () => {
  it("moves the sky with the pointer, not against it", () => {
    // Grab and pull, like a map. Dragging right moves the sky right, which means the gaze
    // turns left. Getting this backwards is the single most common camera bug and it produces
    // something that works perfectly and feels wrong.
    const c = make(TILTED);
    c.beginDrag();
    c.dragBy(100, 0, 0.002, 0);
    expect(c.state.azDeg).toBeLessThan(TILTED.azDeg);

    const d = make(TILTED);
    d.beginDrag();
    d.dragBy(0, 100, 0.002, 0);
    expect(d.state.altDeg).toBeGreaterThan(TILTED.altDeg);
  });

  it("moves the sky by the angle the pointer covered", () => {
    // Direct manipulation: the scale comes from the projection, so a 200 pixel drag at a known
    // radians-per-pixel is a known angle and nothing is tuned.
    const radPerPx = radiansPerCssPixel(300, 1);
    const c = make(TILTED);
    c.beginDrag();
    c.dragBy(200, 0, radPerPx, 0);
    // One rotation, so the angle turned is exactly the angle asked for. A first-order step
    // would come up short here by atan(x) against x, which is nine per cent at this size.
    expect(separation(TILTED, c.state)).toBeCloseTo(200 * radPerPx * RAD, 6);
  });

  it("derives the scale from the projection rather than from a sensitivity constant", () => {
    // The stereographic plane radius of theta is 2 tan(theta/2), whose derivative at 0 is 1, so
    // one radian at the centre of gaze is exactly `scale` device pixels.
    expect(radiansPerCssPixel(440, 2)).toBeCloseTo(2 / 440, 12);
    expect(radiansPerCssPixel(440, 1)).toBeCloseTo(1 / 440, 12);
  });

  it("is unaffected by how many events the drag arrived in", () => {
    // A trackpad delivers a hundred small moves where a mouse delivers ten large ones, and the
    // same gesture has to land in the same place.
    const few = make(TILTED);
    few.beginDrag();
    for (let i = 0; i < 10; i++) few.dragBy(20, 0, 0.0005, i);
    const many = make(TILTED);
    many.beginDrag();
    for (let i = 0; i < 200; i++) many.dragBy(1, 0, 0.0005, i);
    // Not identical, and cannot be: a drag follows a great circle whose direction is recomputed
    // at every step, so twenty short arcs and two long ones are genuinely different paths. What
    // matters is that the difference is far below a pixel: two thousandths of a degree over
    // eight degrees travelled, which at any field of view this sky offers is a fortieth of one.
    const drift = Math.abs(few.state.azDeg - many.state.azDeg) / Math.abs(many.state.azDeg - TILTED.azDeg);
    expect(drift).toBeLessThan(1e-3);
  });
});

describe("the glide", () => {
  it("carries on after the release, and stops", () => {
    const c = make(TILTED);
    c.beginDrag();
    for (let t = 0; t <= 60; t += 10) c.dragBy(12, 0, 0.002, t);
    c.endDrag(60);
    expect(c.moving).toBe(true);
    const atRelease = c.state.azDeg;

    c.step(1 / 60);
    expect(c.state.azDeg).not.toBe(atRelease);

    // Run it out. Bounded, so a decay that never reaches the stop threshold fails here rather
    // than hanging the suite, which is the shape the bug would actually take.
    let frames = 0;
    while (c.moving && frames < 600) {
      c.step(1 / 60);
      frames++;
    }
    expect(c.moving).toBe(false);
    // A hard flick runs for about two and a half seconds, of which the last second is under a
    // pixel a second and is there so the view settles rather than snapping.
    expect(frames).toBeLessThan(200);
    const settled = c.state.azDeg;
    for (let i = 0; i < 120; i++) c.step(1 / 60);
    expect(c.state.azDeg).toBe(settled);
  });

  it("decays rather than running on at a constant rate", () => {
    const c = make(TILTED);
    c.beginDrag();
    for (let t = 0; t <= 60; t += 10) c.dragBy(12, 0, 0.002, t);
    c.endDrag(60);

    const start = c.state.azDeg;
    for (let i = 0; i < 6; i++) c.step(1 / 60);
    const firstTenth = Math.abs(c.state.azDeg - start);
    const middle = c.state.azDeg;
    for (let i = 0; i < 6; i++) c.step(1 / 60);
    const secondTenth = Math.abs(c.state.azDeg - middle);
    expect(secondTenth).toBeLessThan(firstTenth * 0.9);
  });

  it("does not fling when the hand had stopped before it let go", () => {
    // Putting a pointer down, moving, pausing and lifting means the view was placed somewhere
    // deliberately. Reading the whole drag's average speed instead of the recent window is how
    // a deliberate placement drifts away from where it was put.
    const c = make(TILTED);
    c.beginDrag();
    for (let t = 0; t <= 100; t += 10) c.dragBy(12, 0, 0.002, t);
    const parked = c.state.azDeg;
    c.endDrag(100 + FLING_WINDOW_MS * 3);
    expect(c.moving).toBe(false);
    c.step(1 / 60);
    expect(c.state.azDeg).toBe(parked);
  });

  it("is cancelled by a new drag rather than added to it", () => {
    const c = make(TILTED);
    c.beginDrag();
    for (let t = 0; t <= 60; t += 10) c.dragBy(20, 0, 0.002, t);
    c.endDrag(60);
    expect(c.moving).toBe(true);
    c.beginDrag();
    expect(c.moving).toBe(false);
  });
});

describe("the altitude limits", () => {
  it("stops at the zenith instead of tumbling over it", () => {
    // Clamping the RESULT is the version that looks right: rotating past the pole gives an
    // altitude on the way back down and an azimuth 180 degrees round, so the view silently ends
    // up facing the other way. The limit is applied to the request instead.
    const c = make({ altDeg: 88 });
    c.beginDrag();
    c.dragBy(0, 4000, 0.002, 0);
    expect(c.state.altDeg).toBe(MAX_ALT_DEG);
    expect(c.state.azDeg).toBe(HOME.azDeg);
  });

  it("stops below the horizon rather than pointing at nothing", () => {
    const c = make({ altDeg: 0 });
    c.beginDrag();
    c.dragBy(0, -4000, 0.002, 0);
    expect(c.state.altDeg).toBe(MIN_ALT_DEG);
  });

  it("still turns sideways while pinned against a limit", () => {
    const c = make({ altDeg: 90 });
    c.beginDrag();
    c.dragBy(300, 200, 0.002, 0);
    expect(c.state.altDeg).toBeLessThanOrEqual(MAX_ALT_DEG);
    expect(separation({ azDeg: 180, altDeg: 90 }, c.state)).toBeGreaterThan(1);
  });
});

describe("zoom", () => {
  it("stays inside the limits at both ends", () => {
    const c = make();
    for (let i = 0; i < 200; i++) c.zoomBy(0.7);
    expect(c.state.fovDeg).toBe(FOV_MIN_DEG);
    for (let i = 0; i < 200; i++) c.zoomBy(1.4);
    expect(c.state.fovDeg).toBe(FOV_MAX_DEG);
  });

  it("is a ratio, so the same gesture covers the same proportion wherever it starts", () => {
    const wide = make({ fovDeg: 160 });
    const close = make({ fovDeg: 40 });
    wide.wheel(-100, false);
    close.wheel(-100, false);
    expect(160 / wide.state.fovDeg).toBeCloseTo(40 / close.state.fovDeg, 10);
  });

  it("goes in on a scroll up and back out on a scroll down", () => {
    const c = make();
    c.wheel(-200, false);
    const inward = c.state.fovDeg;
    expect(inward).toBeLessThan(HOME.fovDeg);
    c.wheel(200, false);
    expect(c.state.fovDeg).toBeCloseTo(HOME.fovDeg, 8);
  });

  it("takes a pinch further than a scroll of the same reported delta", () => {
    // A trackpad pinch arrives as a wheel event with ctrlKey and a much smaller delta than a
    // scroll of the same physical size. Without the multiplier a pinch barely moves.
    const scrolled = make();
    const pinched = make();
    scrolled.wheel(-8, false);
    pinched.wheel(-8, true);
    expect(pinched.state.fovDeg).toBeLessThan(scrolled.state.fovDeg);
  });

  it("covers the whole range in an unhurried number of mouse notches", () => {
    const c = make({ fovDeg: FOV_MAX_DEG });
    let notches = 0;
    while (c.state.fovDeg > FOV_MIN_DEG && notches < 500) {
      c.wheel(-100, false);
      notches++;
    }
    expect(notches).toBeGreaterThan(8);
    expect(notches).toBeLessThan(40);
  });
});

describe("the keyboard", () => {
  it("turns at a rate, so the frame rate does not change where it gets to", () => {
    // A step per keydown makes a 120 Hz display turn twice as fast as a 60 Hz one, and a
    // dropped frame slow it down. Integrating a rate is what makes it the same everywhere.
    const fast = make(TILTED);
    const slow = make(TILTED);
    fast.hold(1, 0, 0);
    slow.hold(1, 0, 0);
    for (let i = 0; i < 120; i++) fast.step(1 / 120);
    for (let i = 0; i < 30; i++) slow.step(1 / 30);
    // Within a thousandth of the distance travelled. A step-per-event camera would be four
    // times apart here, which is the bug this is for; the residue is the path curvature that
    // "unaffected by how many events" measures above.
    const a = separation(TILTED, fast.state);
    const b = separation(TILTED, slow.state);
    expect(Math.abs(a - b) / b).toBeLessThan(1e-3);
  });

  it("turns at the speed it says it does", () => {
    const c = make(TILTED);
    c.hold(1, 0, 0);
    // One second in one step, so the answer is one rotation and is exact. Split across sixty
    // frames it comes out a fraction under, because sixty short arcs along a moving tangent is
    // a slightly different path from one long one.
    c.step(1);
    // Scaled by how far the view is zoomed in: a fixed fraction of the visible field, not a
    // fixed number of degrees.
    expect(separation(TILTED, c.state)).toBeCloseTo((KEY_LOOK_DEG_S * TILTED.fovDeg) / 180, 6);
  });

  it("moves more slowly when zoomed in, so a close look survives a key press", () => {
    const wide = make({ altDeg: 45, fovDeg: 180 });
    const close = make({ altDeg: 45, fovDeg: 25 });
    wide.hold(1, 0, 0);
    close.hold(1, 0, 0);
    for (let i = 0; i < 30; i++) {
      wide.step(1 / 60);
      close.step(1 / 60);
    }
    const wideMoved = separation({ azDeg: 180, altDeg: 45 }, wide.state);
    const closeMoved = separation({ azDeg: 180, altDeg: 45 }, close.state);
    expect(closeMoved).toBeLessThan(wideMoved / 5);
  });

  it("cancels a glide rather than fighting it", () => {
    const c = make(TILTED);
    c.beginDrag();
    for (let t = 0; t <= 60; t += 10) c.dragBy(-30, 0, 0.002, t);
    c.endDrag(60);
    const drifting = c.state.azDeg;
    c.hold(-1, 0, 0);
    c.step(1 / 60);
    // Moving the other way from the fling, by the key's own amount and not by the difference.
    expect(c.state.azDeg).toBeLessThan(drifting);
    c.hold(0, 0, 0);
    const stopped = c.state.azDeg;
    for (let i = 0; i < 60; i++) c.step(1 / 60);
    expect(c.state.azDeg).toBe(stopped);
  });

  it("zooms while held, in and out", () => {
    const c = make();
    c.hold(0, 0, 1);
    for (let i = 0; i < 30; i++) c.step(1 / 60);
    const zoomedIn = c.state.fovDeg;
    expect(zoomedIn).toBeLessThan(HOME.fovDeg);
    c.hold(0, 0, -1);
    for (let i = 0; i < 30; i++) c.step(1 / 60);
    expect(c.state.fovDeg).toBeGreaterThan(zoomedIn);
  });

  it("goes back to exactly the view the sky opened on", () => {
    const c = make();
    c.beginDrag();
    c.dragBy(310, -170, 0.002, 0);
    c.endDrag(0);
    c.zoomBy(0.3);
    c.reset();
    expect(c.state).toEqual(HOME);
    expect(c.moving).toBe(false);
  });

  it("resets to where the sky opened, not to a second set of defaults", () => {
    // A page is allowed to open somewhere else. Reset means "back to where this started".
    const elsewhere = { azDeg: 300, altDeg: 12, fovDeg: 60 };
    const c = new Camera(elsewhere, false);
    c.zoomBy(0.5);
    c.reset();
    expect(c.state).toEqual(elsewhere);
  });
});

describe("a motion preference takes the animation, not the controls", () => {
  it("still drags", () => {
    const c = make(TILTED, true);
    c.beginDrag();
    c.dragBy(150, 60, 0.002, 0);
    expect(separation(TILTED, c.state)).toBeGreaterThan(1);
  });

  it("but never glides", () => {
    const c = make(TILTED, true);
    c.beginDrag();
    for (let t = 0; t <= 60; t += 10) c.dragBy(20, 0, 0.002, t);
    const parked = c.state.azDeg;
    c.endDrag(60);
    expect(c.moving).toBe(false);
    for (let i = 0; i < 60; i++) c.step(1 / 60);
    expect(c.state.azDeg).toBe(parked);
  });

  it("steps on a press, because there is no frame loop to hold a key against", () => {
    const c = make(TILTED, true);
    c.nudge(1, 0);
    expect(separation(TILTED, c.state)).toBeGreaterThan(0.5);
    const afterOne = c.state.azDeg;
    c.nudge(1, 0);
    expect(c.state.azDeg).not.toBe(afterOne);
  });

  it("zooms on a press too, in both directions", () => {
    const c = make({}, true);
    c.nudgeZoom(1);
    const inward = c.state.fovDeg;
    expect(inward).toBeLessThan(HOME.fovDeg);
    c.nudgeZoom(-1);
    expect(c.state.fovDeg).toBeCloseTo(HOME.fovDeg, 8);
    c.nudgeZoom(0);
    expect(c.state.fovDeg).toBeCloseTo(HOME.fovDeg, 8);
  });

  it("drops a running glide the moment the preference turns on", () => {
    const c = make(TILTED);
    c.beginDrag();
    for (let t = 0; t <= 60; t += 10) c.dragBy(20, 0, 0.002, t);
    c.endDrag(60);
    expect(c.moving).toBe(true);
    c.setReducedMotion(true);
    expect(c.moving).toBe(false);
  });
});

describe("state that arrives from outside", () => {
  it("is adopted, so a page calling look does not get snapped back", () => {
    const c = make();
    c.adopt({ azDeg: 90, altDeg: 30 });
    expect(c.state.azDeg).toBe(90);
    expect(c.state.altDeg).toBe(30);
    c.beginDrag();
    c.dragBy(10, 0, 0.002, 0);
    expect(c.state.altDeg).toBeCloseTo(30, 1);
  });

  it("is clamped on the way in, so the limits hold however the view was set", () => {
    const c = make();
    c.adopt({ altDeg: 400, fovDeg: 5000 });
    expect(c.state.altDeg).toBe(MAX_ALT_DEG);
    expect(c.state.fovDeg).toBe(FOV_MAX_DEG);
    c.adopt({ altDeg: -400, fovDeg: 0 });
    expect(c.state.altDeg).toBe(MIN_ALT_DEG);
    expect(c.state.fovDeg).toBe(FOV_MIN_DEG);
  });

  it("stops everything, because a caller placing the view means it", () => {
    const c = make(TILTED);
    c.hold(1, 0, 0);
    c.adopt({ azDeg: 10 });
    expect(c.moving).toBe(false);
  });
});
