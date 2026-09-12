/**
 * Who gets a key press, and what a browser event turns into.
 *
 * The two failures worth catching here are both invisible to any automated accessibility rule.
 * Taking the arrow keys from the register's listbox leaves a page that passes every markup
 * check and cannot be used with a keyboard. And a key that goes down while the window has focus
 * and comes up after it has lost it leaves the view turning until a reload.
 *
 * The DOM is faked rather than run, because everything under test is a decision and not a
 * rendering. `gl-stub.ts` does the same for WebGL, for the same reason.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Camera } from "../../src/sky/camera.ts";
import { KEY_TIERS, attachControls, wheelPixels } from "../../src/sky/controls.ts";

type Listener = (e: unknown) => void;

/** A node that records its listeners, so a test can fire an event at it and see what happens. */
function fakeTarget() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    addEventListener(type: string, fn: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    fire(type: string, event: Record<string, unknown> = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    count(type: string) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

type World = ReturnType<typeof world>;

function world(activeElement: unknown = null) {
  const win = fakeTarget();
  const body = { tagName: "BODY" };
  const docTarget = fakeTarget();
  const document = {
    body,
    activeElement,
    defaultView: win,
    addEventListener: docTarget.addEventListener,
    removeEventListener: docTarget.removeEventListener,
  };
  const canvas = fakeTarget();
  const element = {
    ownerDocument: document,
    style: { cursor: "" },
    setPointerCapture: () => {},
    addEventListener: canvas.addEventListener,
    removeEventListener: canvas.removeEventListener,
  };
  let changed = 0;
  const camera = new Camera({ azDeg: 180, altDeg: 45, fovDeg: 90 }, false);
  let reduced = false;
  const controls = attachControls(
    element as unknown as HTMLCanvasElement,
    camera,
    { viewport: () => ({ scale: 300, dpr: 1 }), changed: () => { changed++; } },
    () => reduced,
  );
  return {
    camera,
    controls,
    element,
    body,
    key: (type: string, e: Record<string, unknown>) => docTarget.fire(type, e),
    pointer: (type: string, e: Record<string, unknown>) => canvas.fire(type, e),
    win,
    focus: (el: unknown) => {
      document.activeElement = el as typeof document.activeElement;
    },
    changes: () => changed,
    reduce: (on: boolean) => {
      reduced = on;
      camera.setReducedMotion(on);
    },
    docListeners: docTarget,
    canvasListeners: canvas,
  };
}

/** Ran the camera forward far enough for a held key to have visibly moved it. */
const run = (w: World, seconds = 0.5): void => {
  for (let i = 0; i < seconds * 60; i++) w.camera.step(1 / 60);
};

const az = (w: World): number => w.camera.state.azDeg;

describe("the two key tiers", () => {
  it("gives the camera W A S D wherever focus is", () => {
    const w = world();
    w.focus({ tagName: "BUTTON", className: "entry" });
    w.key("keydown", { key: "d" });
    run(w);
    expect(az(w)).toBeGreaterThan(180);
  });

  it("and leaves the arrow keys to whatever has focus", () => {
    // The register is a listbox and the palette picker is a radio group. Both own the arrows by
    // specification, and a camera that also moved on one would make the list unusable.
    const w = world();
    w.focus({ tagName: "BUTTON", className: "entry" });
    w.key("keydown", { key: "ArrowRight" });
    run(w);
    expect(az(w)).toBe(180);
  });

  it("but takes the arrows when nothing else has focus", () => {
    const w = world();
    w.focus(null);
    w.key("keydown", { key: "ArrowRight" });
    run(w);
    expect(az(w)).toBeGreaterThan(180);
  });

  it("counts the body as nothing having focus, which is where a page starts", () => {
    // The real body element, by identity. A tag name comparison would also let through a
    // second body-shaped object, and "is this THE body" is the actual question.
    const w = world();
    w.focus(w.body);
    w.key("keydown", { key: "ArrowLeft" });
    run(w);
    expect(az(w)).toBeLessThan(180);
  });

  it("offers every direction on both tiers, so the arrow tier can never be the only route", () => {
    // The accessibility claim rests on this. If a direction existed only as an arrow key, a
    // reader inside the register could not reach it at all.
    const letters = Object.entries(KEY_TIERS.LOOK_KEYS).filter(([, v]) => !v.arrow);
    const arrows = Object.entries(KEY_TIERS.LOOK_KEYS).filter(([, v]) => v.arrow);
    const axis = (list: [string, { right: number; up: number }][]) =>
      new Set(list.map(([, v]) => `${v.right},${v.up}`));
    expect(axis(letters)).toEqual(axis(arrows));
    expect(axis(letters).size).toBe(4);
  });

  it("zooms and resets without needing an arrow key either", () => {
    const w = world();
    w.focus({ tagName: "BUTTON", className: "entry" });
    w.key("keydown", { key: "+" });
    run(w);
    expect(w.camera.state.fovDeg).toBeLessThan(90);
    w.key("keyup", { key: "+" });
    w.key("keydown", { key: "0" });
    expect(w.camera.state.fovDeg).toBe(90);
  });

  it("leaves Home to the register, because the register uses it", () => {
    const w = world();
    w.camera.zoomBy(0.5);
    const zoomed = w.camera.state.fovDeg;
    w.focus({ tagName: "BUTTON", className: "entry" });
    w.key("keydown", { key: "Home" });
    expect(w.camera.state.fovDeg).toBe(zoomed);
    w.focus(null);
    w.key("keydown", { key: "Home" });
    expect(w.camera.state.fovDeg).toBe(90);
  });
});

describe("presses this page must not take", () => {
  it("ignores anything with a modifier, because the browser owns those", () => {
    // Cmd-minus is the browser's own zoom. Taking it would be a worse bug than having no
    // zoom key at all.
    const w = world();
    w.focus(null);
    for (const mod of ["metaKey", "ctrlKey", "altKey"]) {
      w.key("keydown", { key: "-", [mod]: true });
      w.key("keydown", { key: "d", [mod]: true });
    }
    run(w);
    expect(az(w)).toBe(180);
    expect(w.camera.state.fovDeg).toBe(90);
  });

  it("ignores a key that arrived from a field, because somebody is typing", () => {
    const w = world();
    w.focus(null);
    for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { isContentEditable: true }]) {
      w.key("keydown", { key: "d", target });
      w.key("keydown", { key: "s", target });
    }
    run(w);
    expect(az(w)).toBe(180);
  });

  it("prevents the default only for keys it actually took", () => {
    const w = world();
    w.focus(null);
    let prevented = 0;
    w.key("keydown", { key: "ArrowDown", preventDefault: () => { prevented++; } });
    expect(prevented).toBe(1);
    // A key nobody here wants, and one this page wants but is not entitled to right now.
    w.key("keydown", { key: "q", preventDefault: () => { prevented++; } });
    w.focus({ tagName: "BUTTON" });
    w.key("keydown", { key: "ArrowDown", preventDefault: () => { prevented++; } });
    expect(prevented).toBe(1);
  });
});

describe("keys that are let go of", () => {
  it("stop the view when released", () => {
    const w = world();
    w.focus(null);
    w.key("keydown", { key: "d" });
    run(w, 0.2);
    w.key("keyup", { key: "d" });
    const parked = az(w);
    run(w, 1);
    expect(az(w)).toBe(parked);
  });

  it("are released whatever case they come back up in", () => {
    // Caps lock, or a shift let go before the letter. `keyup` reports "D" where `keydown`
    // reported "d", and a set keyed on the raw string never loses the entry.
    const w = world();
    w.focus(null);
    w.key("keydown", { key: "d" });
    w.key("keyup", { key: "D" });
    run(w, 1);
    expect(az(w)).toBe(180);
  });

  it("are dropped when the window loses focus, which never delivers a keyup", () => {
    // Alt-tab mid-press. Without this the sky turns forever and only a reload stops it.
    const w = world();
    w.focus(null);
    w.key("keydown", { key: "d" });
    run(w, 0.2);
    w.win.fire("blur");
    const parked = az(w);
    run(w, 2);
    expect(az(w)).toBe(parked);
  });

  it("combine, so two directions at once move diagonally", () => {
    const w = world();
    w.focus(null);
    w.key("keydown", { key: "d" });
    w.key("keydown", { key: "w" });
    run(w, 0.3);
    expect(az(w)).toBeGreaterThan(180);
    expect(w.camera.state.altDeg).toBeGreaterThan(45);
  });

  it("cancel each other when both directions of one axis are held", () => {
    const w = world();
    w.focus(null);
    w.key("keydown", { key: "a" });
    w.key("keydown", { key: "d" });
    run(w, 0.5);
    expect(az(w)).toBe(180);
  });
});

describe("with motion reduced", () => {
  it("a press steps the view, because there is no frame loop to hold it against", () => {
    const w = world();
    w.reduce(true);
    w.focus(null);
    w.key("keydown", { key: "d" });
    // No `step` at all: the move has to have happened by the time the handler returns.
    expect(az(w)).toBeGreaterThan(180);
  });

  it("and a release leaves nothing running", () => {
    const w = world();
    w.reduce(true);
    w.focus(null);
    w.key("keydown", { key: "d" });
    const parked = az(w);
    w.key("keyup", { key: "d" });
    run(w, 2);
    expect(az(w)).toBe(parked);
  });

  it("zoom keys step too", () => {
    const w = world();
    w.reduce(true);
    w.focus(null);
    w.key("keydown", { key: "=" });
    expect(w.camera.state.fovDeg).toBeLessThan(90);
  });

  it("dragging still works, because a motion preference is about animation", () => {
    const w = world();
    w.reduce(true);
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    w.pointer("pointermove", { pointerId: 1, clientX: 220, clientY: 100 });
    expect(az(w)).toBeLessThan(180);
    w.pointer("pointerup", { pointerId: 1, clientX: 220, clientY: 100 });
    const parked = az(w);
    run(w, 2);
    expect(az(w)).toBe(parked);
  });
});

describe("the pointer", () => {
  it("drags the sky and asks for a frame each time", () => {
    const w = world();
    const before = w.changes();
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    w.pointer("pointermove", { pointerId: 1, clientX: 160, clientY: 100 });
    expect(az(w)).toBeLessThan(180);
    expect(w.changes()).toBeGreaterThan(before);
  });

  it("says it is dragging, so the page can hold off on hover work", () => {
    const w = world();
    expect(w.controls.dragging).toBe(false);
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    expect(w.controls.dragging).toBe(true);
    w.pointer("pointerup", { pointerId: 1, clientX: 10, clientY: 10 });
    expect(w.controls.dragging).toBe(false);
  });

  it("shows a grab cursor, and a closed one while it is held", () => {
    const w = world();
    expect(w.element.style.cursor).toBe("grab");
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    expect(w.element.style.cursor).toBe("grabbing");
    w.pointer("pointerup", { pointerId: 1, clientX: 10, clientY: 10 });
    expect(w.element.style.cursor).toBe("grab");
  });

  it("leaves the secondary buttons to the browser", () => {
    const w = world();
    w.pointer("pointerdown", { pointerId: 1, button: 2, clientX: 10, clientY: 10 });
    w.pointer("pointermove", { pointerId: 1, clientX: 200, clientY: 10 });
    expect(az(w)).toBe(180);
    expect(w.controls.dragging).toBe(false);
  });

  it("ends the drag when the pointer is cancelled rather than lifted", () => {
    const w = world();
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    w.pointer("pointercancel", { pointerId: 1, clientX: 10, clientY: 10 });
    expect(w.controls.dragging).toBe(false);
  });

  it("turns a second finger into a pinch rather than a second drag", () => {
    const w = world();
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    w.pointer("pointerdown", { pointerId: 2, button: 0, clientX: 200, clientY: 100 });
    expect(w.controls.dragging).toBe(false);
    const wide = w.camera.state.fovDeg;
    // Fingers apart is a closer look.
    w.pointer("pointermove", { pointerId: 2, clientX: 300, clientY: 100 });
    expect(w.camera.state.fovDeg).toBeLessThan(wide);
    // And together again is a wider one.
    w.pointer("pointermove", { pointerId: 2, clientX: 150, clientY: 100 });
    expect(w.camera.state.fovDeg).toBeGreaterThan(wide);
  });

  it("hands the drag back to the finger left over when a pinch ends", () => {
    const w = world();
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    w.pointer("pointerdown", { pointerId: 2, button: 0, clientX: 200, clientY: 100 });
    w.pointer("pointerup", { pointerId: 2, clientX: 200, clientY: 100 });
    expect(w.controls.dragging).toBe(true);
    w.pointer("pointermove", { pointerId: 1, clientX: 160, clientY: 100 });
    expect(az(w)).toBeLessThan(180);
  });

  it("does not fling by the distance a pinch travelled", () => {
    // The second finger ends the drag rather than pausing it, so lifting one of them cannot
    // hand the glide a speed the hand never had.
    const w = world();
    w.pointer("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    w.pointer("pointerdown", { pointerId: 2, button: 0, clientX: 200, clientY: 100 });
    w.pointer("pointermove", { pointerId: 1, clientX: 40, clientY: 100 });
    w.pointer("pointerup", { pointerId: 1, clientX: 40, clientY: 100 });
    w.pointer("pointerup", { pointerId: 2, clientX: 200, clientY: 100 });
    const parked = az(w);
    run(w, 1);
    expect(az(w)).toBe(parked);
  });
});

describe("the wheel", () => {
  it("reads its delta in whatever unit the browser chose", () => {
    // Firefox reports lines on a mouse wheel. Ignoring deltaMode makes the zoom look broken in
    // one browser rather than looking like a units bug.
    expect(wheelPixels(3)).toBe(3);
    expect(wheelPixels(3, 0)).toBe(3);
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(1, 2)).toBe(400);
  });

  it("zooms, and stops the page scrolling behind the sky", () => {
    const w = world();
    let prevented = 0;
    w.pointer("wheel", { deltaY: -240, preventDefault: () => { prevented++; } });
    expect(w.camera.state.fovDeg).toBeLessThan(90);
    expect(prevented).toBe(1);
  });

  it("treats a ctrl-wheel as a trackpad pinch", () => {
    const a = world();
    const b = world();
    a.pointer("wheel", { deltaY: -6 });
    b.pointer("wheel", { deltaY: -6, ctrlKey: true });
    expect(b.camera.state.fovDeg).toBeLessThan(a.camera.state.fovDeg);
  });
});

describe("tearing down", () => {
  it("removes every listener it added", () => {
    const w = world();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel"]) {
      expect(w.canvasListeners.count(type)).toBe(1);
    }
    expect(w.docListeners.count("keydown")).toBe(1);
    w.controls.destroy();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel"]) {
      expect(w.canvasListeners.count(type)).toBe(0);
    }
    expect(w.docListeners.count("keydown")).toBe(0);
    expect(w.docListeners.count("keyup")).toBe(0);
  });

  it("puts the cursor back, since the canvas outlives this", () => {
    const w = world();
    w.controls.destroy();
    expect(w.element.style.cursor).toBe("");
  });

  it("stops a key that was still held", () => {
    const w = world();
    w.focus(null);
    w.key("keydown", { key: "d" });
    w.controls.destroy();
    const parked = az(w);
    run(w, 1);
    expect(az(w)).toBe(parked);
  });
});

describe("the sky is reachable by a pointer at all", () => {
  /**
   * The bug that made every one of the tests above moot.
   *
   * `.chrome` is a grid that covers the viewport, and a grid container is hit-testable across
   * the whole of its box whether or not anything is painted in it. So a pointer aimed at what
   * looks like empty sky landed on a transparent div: the hover that names a light never fired,
   * and neither did the drag. Nothing threw, nothing logged, the page simply did not respond.
   *
   * This reads the stylesheet, which is the most it can do from node. It cannot prove the
   * layout works, and it is not trying to: `test/ui/keyboard-walk.mjs` and the browser pass are
   * where that is established. What it can do is fail when somebody deletes the rule, which is
   * the way this comes back.
   */
  it("does not let the chrome swallow the pointer in its empty areas", () => {
    const css = readFileSync(new URL("../../src/ui/ui.css", import.meta.url), "utf8");
    const squashed = css.replace(/\s+/g, " ");
    expect(squashed).toContain(".chrome, .chrome > div { pointer-events: none; }");
    expect(squashed).toContain(".chrome > div > * { pointer-events: auto; }");
  });
});
