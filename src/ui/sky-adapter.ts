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
 * **`highlight` has nowhere to land.** The renderer has no method for ringing a light by id, so
 * it is dropped rather than faked. What the renderer would need is either `highlight(id)` or a
 * `locate(id)` returning the CSS pixel the light was drawn at, which would let this side draw
 * the ring. Until then a keyboard user gets the register selection and the evidence panel, and
 * loses only the pointer back into the canvas.
 */
import type { SkyEvent } from "../shared/event.ts";
import type { SkyHandle, SkyOptions } from "./ports.ts";

/** The part of `src/sky`'s `Sky` this uses, restated so a change there fails the typecheck here
 *  rather than at runtime in a panel. */
type Renderer = {
  handle(message: Parameters<SkyHandle["forward"]>[0]): void;
  setFocus(id: string, on: boolean): void;
  hitTest(x: number, y: number, radiusPx?: number): { event: SkyEvent | null } | null;
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
    highlight() {},
    hitTest(x, y) {
      // A visitor under the cursor comes back with `event: null`, and that is a miss as far as
      // the evidence panel is concerned.
      return sky.hitTest(x, y)?.event ?? null;
    },
    setFocus(on) {
      focused = on;
      if (selfId) sky.setFocus(selfId, on);
    },
    destroy: () => sky.destroy(),
  };
}
