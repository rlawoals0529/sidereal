/**
 * The events that drive the camera, and the rules about who gets a key press.
 *
 * No arithmetic lives here on purpose: this file turns a `pointermove` into a delta and a
 * keydown into a held direction, and `camera.ts` decides what either of those means. The split
 * is the same one `scene.ts` and `renderer.ts` already make, and for the same reason - the part
 * that can be wrong should be reachable from a plain node test.
 *
 * **Keys are bound to the document, not to the canvas, because the canvas is `aria-hidden`.**
 * The page hides the canvas from assistive technology deliberately: it has no children, so
 * nothing in it could be focused or read, and the register beside it is the accessible
 * equivalent. Giving it a tabindex to catch key events would put a focusable element inside a
 * hidden subtree, which is the one combination the accessibility tree has no good answer for.
 * So the sky listens at the document and decides, per key, whether it is entitled to it.
 *
 * The rule, and it is the whole reason there are two tiers:
 *
 * - **WASD, plus, minus and zero work wherever focus is**, short of a text field. No control on
 *   this page uses a bare letter except `F` for the focus ritual, so these cannot be taken from
 *   anything. That is what makes the camera reachable without a pointer at any moment: a reader
 *   who has tabbed into the register can still look around without tabbing back out.
 * - **The arrow keys work only when nothing else has focus.** The register is a listbox and the
 *   palette picker is a radio group, and both own the arrows by specification. A camera that
 *   also moved on an arrow press would either steal them or fight for them, and stealing arrow
 *   keys from a listbox is how a page becomes unusable with a keyboard while passing every
 *   automated check.
 *
 * Nothing here is the only route to anything. Every camera control has a WASD form, so the
 * arrow tier is a convenience on top rather than a capability that can be lost.
 */
import type { Camera } from "./camera.ts";
import { radiansPerCssPixel } from "./camera.ts";

/** Everything this needs from the outside, so a test can supply all of it. */
export type ControlsHost = {
  /** CSS pixels per radian and the device pixel ratio, read fresh on every move. */
  viewport(): { scale: number; dpr: number };
  /** Something changed. Draw, now or on the next frame, whichever this sky is doing. */
  changed(): void;
};

type Target = {
  addEventListener(type: string, fn: (e: never) => void, options?: unknown): void;
  removeEventListener(type: string, fn: (e: never) => void, options?: unknown): void;
};

type PointerLike = {
  pointerId: number;
  button?: number;
  clientX: number;
  clientY: number;
  isPrimary?: boolean;
  preventDefault?: () => void;
  pointerType?: string;
};

type WheelLike = { deltaY: number; deltaMode?: number; ctrlKey?: boolean; preventDefault?: () => void };

type KeyLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: unknown;
  preventDefault?: () => void;
};

/**
 * A `wheel` event can report its delta in pixels, lines or pages, and a browser picks.
 *
 * Firefox on a mouse wheel reports lines. Ignoring `deltaMode` means the same notch zooms a
 * hundredth as far there as it does in Chrome, which does not look like a units bug, it looks
 * like the zoom is broken in one browser. Sixteen pixels a line is the usual line height and is
 * what every scroll library uses; a page is a screen, near enough.
 */
export function wheelPixels(deltaY: number, deltaMode = 0): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 400;
  return deltaY;
}

const LOOK_KEYS: Record<string, { right: number; up: number; arrow: boolean }> = {
  ArrowLeft: { right: -1, up: 0, arrow: true },
  ArrowRight: { right: 1, up: 0, arrow: true },
  ArrowUp: { right: 0, up: 1, arrow: true },
  ArrowDown: { right: 0, up: -1, arrow: true },
  a: { right: -1, up: 0, arrow: false },
  d: { right: 1, up: 0, arrow: false },
  w: { right: 0, up: 1, arrow: false },
  s: { right: 0, up: -1, arrow: false },
};

/** In is a smaller field of view, which is why the sign here is the opposite of the key. */
const ZOOM_KEYS: Record<string, number> = { "+": 1, "=": 1, "-": -1, _: -1 };

const RESET_KEYS = new Set(["0", "Home"]);

/** A press this page must not take: the person is typing, or the key belongs to the browser. */
function isTyping(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? "");
}

export type Controls = {
  /** True while a pointer is down and dragging, so a caller can hold off on hover work. */
  readonly dragging: boolean;
  destroy(): void;
};

export function attachControls(
  canvas: HTMLCanvasElement,
  camera: Camera,
  host: ControlsHost,
  reducedMotion: () => boolean,
): Controls {
  const doc = canvas.ownerDocument;
  const win = doc?.defaultView ?? null;

  /** Live pointers on the canvas, so two of them can be recognised as a pinch. */
  const down = new Map<number, { x: number; y: number }>();
  let dragId: number | null = null;
  let pinchSpan = 0;
  const held = new Set<string>();

  const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const radPerPx = (): number => {
    const v = host.viewport();
    return radiansPerCssPixel(v.scale, v.dpr);
  };

  /**
   * The only affordance saying the sky can be moved at all.
   *
   * A canvas that responds to a drag with nothing to suggest it will is a feature nobody finds.
   * Set here rather than in the stylesheet because it changes while the drag is running, and a
   * class toggled per frame is a worse version of the same line. Restored on teardown, since
   * the element outlives this.
   */
  const style = (canvas as unknown as { style?: { cursor: string } }).style;
  const priorCursor = style?.cursor ?? "";
  if (style) style.cursor = "grab";
  const setCursor = (down: boolean): void => {
    if (style) style.cursor = down ? "grabbing" : "grab";
  };

  const onPointerDown = (e: PointerLike): void => {
    // Secondary buttons belong to the browser's context menu and to nothing here.
    if (e.button !== undefined && e.button !== 0) return;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (canvas as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
    if (down.size === 1) {
      dragId = e.pointerId;
      camera.beginDrag();
      setCursor(true);
      return;
    }
    // A second finger turns the gesture into a pinch. The drag is ended rather than paused, so
    // lifting one finger does not fling the view by the distance the pinch moved.
    if (down.size === 2) {
      camera.endDrag(now());
      dragId = null;
      pinchSpan = spanOf(down);
    }
  };

  const onPointerMove = (e: PointerLike): void => {
    const from = down.get(e.pointerId);
    if (!from) return;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (down.size >= 2) {
      const span = spanOf(down);
      if (pinchSpan > 1 && span > 1) {
        // Fingers apart is a closer look, which is a smaller field of view.
        camera.zoomBy(pinchSpan / span);
        host.changed();
      }
      pinchSpan = span;
      return;
    }

    if (e.pointerId !== dragId) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (dx === 0 && dy === 0) return;
    camera.dragBy(dx, dy, radPerPx(), now());
    host.changed();
  };

  const onPointerUp = (e: PointerLike): void => {
    if (!down.delete(e.pointerId)) return;
    if (e.pointerId === dragId) {
      dragId = null;
      camera.endDrag(now());
      setCursor(false);
      host.changed();
    }
    // The finger left over from a pinch takes the drag on, so the gesture can end as a pan.
    if (down.size === 1) {
      dragId = [...down.keys()][0]!;
      camera.beginDrag();
    }
    if (down.size < 2) pinchSpan = 0;
  };

  const onWheel = (e: WheelLike): void => {
    // Without this the page scrolls behind the sky, which on a page with no scrollbar is an
    // invisible rubber band rather than nothing.
    e.preventDefault?.();
    camera.wheel(wheelPixels(e.deltaY, e.deltaMode), e.ctrlKey === true);
    host.changed();
  };

  /** Recompute the held axes from the set of keys that are down, and hand them over. */
  const applyHeld = (): void => {
    let right = 0;
    let up = 0;
    let zoom = 0;
    for (const key of held) {
      const look = LOOK_KEYS[key];
      if (look) {
        right += look.right;
        up += look.up;
      }
      zoom += ZOOM_KEYS[key] ?? 0;
    }
    camera.hold(Math.sign(right), Math.sign(up), Math.sign(zoom));
  };

  /**
   * Whether this page is entitled to a given key right now. See the header for the two tiers.
   *
   * `activeElement` and not the event target, because a key that reached the document from a
   * focused button still belongs to that button's widget. Comparing against the body covers
   * both the nothing-is-focused case and the case where focus was explicitly dropped.
   */
  const mayTake = (key: string, arrowOnly: boolean): boolean => {
    if (!arrowOnly) return true;
    const active = doc?.activeElement ?? null;
    return active === null || active === doc?.body || active === (canvas as unknown as Element);
  };

  const onKeyDown = (e: KeyLike): void => {
    // A modifier means the browser or the operating system owns it: Cmd-minus is the browser's
    // zoom, and taking that would be a worse bug than not having a zoom key at all.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const look = LOOK_KEYS[key];
    const zoom = ZOOM_KEYS[key];

    if (look) {
      if (!mayTake(key, look.arrow)) return;
      e.preventDefault?.();
      if (reducedMotion()) {
        // No frame loop to hold a key against, so a press is a step. Key repeat gives a held
        // key its repeats, which is the platform's own answer to the same question.
        camera.nudge(look.right, look.up);
        host.changed();
        return;
      }
      held.add(key);
      applyHeld();
      host.changed();
      return;
    }

    if (zoom !== undefined) {
      e.preventDefault?.();
      if (reducedMotion()) {
        camera.nudgeZoom(zoom);
        host.changed();
        return;
      }
      held.add(key);
      applyHeld();
      host.changed();
      return;
    }

    if (RESET_KEYS.has(key)) {
      // Home belongs to the register's listbox when the register has focus, and to nobody
      // otherwise. Zero belongs to nothing and always works.
      if (!mayTake(key, key === "Home")) return;
      e.preventDefault?.();
      held.clear();
      camera.reset();
      host.changed();
    }
  };

  const onKeyUp = (e: KeyLike): void => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!held.delete(key)) return;
    applyHeld();
  };

  /**
   * A window losing focus while a key is down never delivers the keyup.
   *
   * Without this, alt-tabbing away mid-press leaves the view turning forever and the only way
   * back is a reload. It is the cheapest bug in this file to write and among the most annoying
   * to hit.
   */
  const onBlur = (): void => {
    held.clear();
    camera.stop();
  };

  const on = (t: Target | null, type: string, fn: (e: never) => void, options?: unknown): (() => void) => {
    if (!t) return () => {};
    t.addEventListener(type, fn, options);
    return () => t.removeEventListener(type, fn, options);
  };

  const target = canvas as unknown as Target;
  const offs = [
    on(target, "pointerdown", onPointerDown as (e: never) => void),
    on(target, "pointermove", onPointerMove as (e: never) => void),
    on(target, "pointerup", onPointerUp as (e: never) => void),
    on(target, "pointercancel", onPointerUp as (e: never) => void),
    // Not passive: this one has to be able to stop the page scrolling.
    on(target, "wheel", onWheel as (e: never) => void, { passive: false }),
    on(doc as unknown as Target | null, "keydown", onKeyDown as (e: never) => void),
    on(doc as unknown as Target | null, "keyup", onKeyUp as (e: never) => void),
    on(win as unknown as Target | null, "blur", onBlur as (e: never) => void),
  ];

  return {
    get dragging(): boolean {
      return dragId !== null;
    },
    destroy(): void {
      for (const off of offs) off();
      if (style) style.cursor = priorCursor;
      held.clear();
      down.clear();
      camera.stop();
    },
  };
}

/** Distance between the first two live pointers, for the pinch. */
function spanOf(down: ReadonlyMap<number, { x: number; y: number }>): number {
  const pts = [...down.values()];
  const a = pts[0];
  const b = pts[1];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Exported for the test that checks the two tiers without a browser. */
export const KEY_TIERS = { LOOK_KEYS, ZOOM_KEYS, RESET_KEYS } as const;
