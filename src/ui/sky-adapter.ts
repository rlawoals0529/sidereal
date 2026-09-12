/**
 * The one file that knows both halves. Everything else in `src/ui/` codes against `ports.ts`.
 *
 * `src/sky/index.ts` exposes a much wider surface than this interface needs - observers, fields
 * of view, frame statistics, a provenance audit - and adapting it here rather than spreading
 * those calls through the panels means the day either side changes shape, one file moves.
 *
 * Three mismatches are resolved here and they are worth naming, because each one is a place a
 * naive wiring would be subtly wrong:
 *
 * **`setFocus` needs an id and the UI does not have one.** The renderer focuses a visitor by id;
 * this page only knows "me". The id arrives in `welcome`, which passes through `forward`, so the
 * adapter keeps it. Waiting for the server to echo a focus back would be the alternative, and it
 * would mean your own star lights up a round trip after you pressed the button, or never, since
 * a server has no reason to send you your own state.
 *
 * **The palette is not passed in, it is read from the cascade.** The renderer watches
 * `data-theme` itself, so the picker changing the attribute is already the whole update. A
 * `setPalette` call here would be a second path to the same state, and two paths to one state is
 * how they end up disagreeing.
 *
 * **The highlight ring is a DOM element, not a draw call.** `src/sky` answers `locate(id)` with
 * where a light currently is, and the ring is drawn here, over the canvas. That is not squeamish
 * about WebGL: a ring drawn by the renderer would be a draw call backed by no event, and the
 * provenance audit would be right to refuse it. The cursor is the reader's, not the sky's.
 *
 * The ring follows on its own frame loop because the sky keeps turning under a stationary
 * cursor. A one-shot placement would be correct for a few hundred milliseconds and then quietly
 * wrong, which is worse than no ring, since it would be pointing confidently at the wrong star.
 */
import type { SkyEvent } from "../shared/event.ts";
import type { SkyHandle, SkyOptions } from "./ports.ts";

/** The part of `src/sky`'s `Sky` this uses, restated so a change there fails the typecheck here
 *  rather than at runtime in a panel. */
type Renderer = {
  handle(message: Parameters<SkyHandle["forward"]>[0]): void;
  setFocus(id: string, on: boolean): void;
  hitTest(x: number, y: number, radiusPx?: number): { event: SkyEvent | null } | null;
  locate(id: string): { x: number; y: number } | null;
  start(): void;
  destroy(): void;
};

type CreateRenderer = (
  canvas: HTMLCanvasElement,
  options: { reducedMotion?: boolean | "auto" },
) => Renderer;

export function adaptSky(
  createRenderer: CreateRenderer,
  canvas: HTMLCanvasElement,
  options: SkyOptions,
): SkyHandle {
  const sky = createRenderer(canvas, { reducedMotion: options.reducedMotion });
  sky.start();

  let selfId: string | null = null;
  /** Held so that a focus session that began before `welcome` still ignites when the id lands. */
  let focused = false;

  let ringed: string | null = null;
  let ringFrame = 0;
  /**
   * Absolutely positioned over the canvas, and `aria-hidden` because it says nothing a screen
   * reader has not already been told: the register entry it mirrors carries the name and the
   * evidence panel carries the detail. A second announcement of the same light would be noise.
   */
  const ring = canvas.ownerDocument.createElement("div");
  ring.className = "sky-ring";
  ring.hidden = true;
  ring.setAttribute("aria-hidden", "true");
  canvas.parentElement?.insertBefore(ring, canvas.nextSibling);

  const placeRing = () => {
    ringFrame = 0;
    if (ringed === null) return;
    const at = sky.locate(ringed);
    // A light that is not on screen has aged out or is below the horizon, and both are ordinary.
    // Hiding is the only honest answer; a last known position would be a guess drawn confidently.
    ring.hidden = at === null;
    if (at) {
      ring.style.left = `${at.x}px`;
      ring.style.top = `${at.y}px`;
    }
    ringFrame = requestAnimationFrame(placeRing);
  };

  return {
    forward(message) {
      if (message.t === "welcome") {
        selfId = message.you;
        sky.handle(message);
        if (focused) sky.setFocus(selfId, true);
        return;
      }
      sky.handle(message);
    },
    highlight(id) {
      if (id === ringed) return;
      ringed = id;
      if (ringFrame) cancelAnimationFrame(ringFrame);
      ringFrame = 0;
      if (id === null) {
        ring.hidden = true;
        return;
      }
      placeRing();
    },
    hitTest(x, y) {
      // A visitor under the cursor comes back with `event: null`, and that is a miss as far as
      // the evidence panel is concerned.
      return sky.hitTest(x, y)?.event ?? null;
    },
    setFocus(on) {
      focused = on;
      if (selfId) sky.setFocus(selfId, on);
    },
    destroy() {
      if (ringFrame) cancelAnimationFrame(ringFrame);
      ring.remove();
      sky.destroy();
    },
  };
}
