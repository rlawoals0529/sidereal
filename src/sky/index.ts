/**
 * `createSky(canvas, options)`: the whole surface the UI drives.
 *
 * Everything a caller needs and nothing it does not. Push events, tell it where the observer
 * is standing and which way they are looking, keep it up to date on who else is here, ask it
 * what is under the cursor, and ask it to prove every light on screen is earned.
 *
 * Three things about the loop that are easy to get wrong and are handled here.
 *
 * **The clock is epoch time, derived once.** Events carry epoch milliseconds and
 * `requestAnimationFrame` hands you a `performance.now` timestamp, so the two are pinned
 * together at start and the offset is reused. Calling `Date.now()` per frame would work until
 * the machine's clock is corrected under you, at which point the entire sky jumps; measuring
 * from a monotonic origin means a clock correction moves the sky by the amount the clock was
 * actually wrong, once, which is the right answer.
 *
 * **With motion reduced there is no loop at all.** The sky renders once and then only when
 * something arrives, and the something is drawn as a step rather than an animation. A still
 * frame that never changes is a screenshot, not a sky, so new data does land; what does not
 * happen is anything moving.
 *
 * **Palette changes come from the cascade, not from an argument.** Switching `data-theme`
 * repaints without a reload, because the tokens are re-read rather than remembered.
 */
import type { SkyEvent } from "../shared/event.ts";
import type { Presence, ServerMessage } from "../shared/protocol.ts";
import type { Observer } from "./astro.ts";
import { DEFAULT_CAPACITY, Scene, sceneOptions, type Hit } from "./scene.ts";
import {
  documentSource,
  readPalette,
  watchPalette,
  type PaletteSource,
  type SkyPalette,
} from "./palette.ts";
import { assertEveryLightIsEarned, type Audit } from "./provenance.ts";
import { Renderer } from "./renderer.ts";
import { drawStill } from "./still2d.ts";
import type { Gl } from "./gl/device.ts";

export type { Hit, Observer };
export type { Audit } from "./provenance.ts";
export type { SkyPalette } from "./palette.ts";
export { CHROME, describeViolations } from "./provenance.ts";
export { SIDEREAL_DAY_MS } from "./astro.ts";

export type SkyOptions = {
  /** Where the viewer is standing and looking. Defaults to Greenwich, looking straight up. */
  observer?: Partial<Observer>;
  /** Full angle across the frame. 180 puts the whole hemisphere on screen with the horizon as a ring. */
  fovDeg?: number;
  reducedMotion?: boolean | "auto";
  /** Draw the viewer's own light. Off if the UI would rather render that itself. */
  showSelf?: boolean;
  /** A visitor's yozora palette id to their accent, so they appear in their own colour. */
  resolveAccent?: (paletteId: string) => string | null;
  capacity?: Partial<typeof DEFAULT_CAPACITY>;
  /** Override where tokens are read from. The tests pass a fake; the page should not. */
  paletteSource?: PaletteSource;
  /** Epoch milliseconds. Injected by the benchmark so it can run a day of sky in a second. */
  clock?: () => number;
  /** Force the fallback path, to see what a machine without WebGL2 gets. */
  force2d?: boolean;
  autoStart?: boolean;
};

export type FrameStats = {
  frames: number;
  /** Milliseconds of work this renderer did, not the interval between frames. */
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
  /** Median milliseconds between frames actually delivered. Zero until the loop has run. */
  intervalP50Ms: number;
  /**
   * The measured interval that made this sky give up on animating, or null.
   *
   * Never a guess about the machine. A software WebGL2 implementation reports itself as
   * WebGL2 and links every shader, so there is nothing to feature-detect: this renderer was
   * measured at ten frames a second under Chrome's SwiftShader, and sniffing the renderer
   * string for "SwiftShader" would still miss every slow real GPU. So the sky watches its own
   * delivered frame rate and collapses to the still composition if it cannot hold a
   * reasonable one, with the number that made it decide. See `DEGRADE_AFTER_MS`.
   */
  degradedAtMs: number | null;
};

/**
 * Median frame interval above which animating is doing more harm than good.
 *
 * Forty milliseconds is twenty five frames a second. Below that, motion has stopped being
 * motion and become a slideshow, and a slideshow of a rotating sky is worse than a still of
 * one in every way including the accessibility one.
 */
export const DEGRADE_AFTER_MS = 40;
/** Samples before the decision, so a cold start and a single hitch cannot trigger it. */
const DEGRADE_WINDOW = 120;
/** An interval longer than this is a tab switch or a sleep, not a slow frame. */
const NOT_A_FRAME_MS = 500;

export type Sky = {
  readonly backend: "webgl2" | "canvas2d";
  /** One tick of the world. Safe to call with an empty batch. */
  push(events: readonly SkyEvent[]): void;
  /** Drive the whole thing straight off the wire. */
  handle(msg: ServerMessage): void;
  upsertVisitor(p: Presence, isSelf?: boolean): void;
  removeVisitor(id: string): void;
  setFocus(id: string, on: boolean): void;
  setGaze(id: string, azDeg: number, altDeg: number): void;
  /** Which presence is the viewer, so it can be drawn as theirs. */
  setSelf(id: string): void;
  setObserver(o: Partial<Observer>): void;
  look(azDeg: number, altDeg: number): void;
  setFov(deg: number): void;
  setReducedMotion(v: boolean | "auto"): void;
  resize(): void;
  /** What is under the cursor, in CSS pixels relative to the canvas. */
  hitTest(x: number, y: number, radiusPx?: number): Hit | null;
  /** Every light on screen, checked against the record it was drawn from. */
  audit(): Audit;
  /** The same check, as an assertion. Throws naming every violation. */
  assertEarned(): void;
  palette(): SkyPalette;
  start(): void;
  stop(): void;
  /** Draw one frame now. Used by the still path and by the benchmark. */
  frame(atMs?: number): void;
  stats(): { frame: FrameStats; scene: ReturnType<Scene["stats"]> };
  destroy(): void;
};

const monotonic = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export function createSky(canvas: HTMLCanvasElement, options: SkyOptions = {}): Sky {
  const root =
    typeof document !== "undefined" ? document.documentElement : (canvas as unknown as HTMLElement);
  const source = options.paletteSource ?? documentSource(root);
  const clock = options.clock ?? Date.now;

  const scene = new Scene(
    sceneOptions({
      palette: readPalette(source),
      observer: {
        latDeg: 51.4769,
        lonDeg: -0.0005,
        gazeAzDeg: 180,
        gazeAltDeg: 90,
        ...options.observer,
      },
      ...(options.fovDeg === undefined ? {} : { fovDeg: options.fovDeg }),
      ...(options.showSelf === undefined ? {} : { showSelf: options.showSelf }),
      resolveAccent: options.resolveAccent ?? null,
      capacity: { ...DEFAULT_CAPACITY, ...options.capacity },
      reducedMotion: resolveReducedMotion(options.reducedMotion ?? "auto"),
      epochMs: clock(),
    }),
  );

  const gl = options.force2d
    ? null
    : (canvas.getContext("webgl2", {
        alpha: false,
        antialias: true,
        // The sky is never read back and never composited against the page, so neither of
        // these buys anything and both cost memory bandwidth on every frame.
        depth: false,
        stencil: false,
        powerPreference: "low-power",
        preserveDrawingBuffer: false,
      }) as WebGL2RenderingContext | null);

  const renderer = gl ? new Renderer(gl as Gl, scene) : null;
  const ctx2d = renderer ? null : (canvas.getContext("2d") as CanvasRenderingContext2D | null);

  // No WebGL2 means the still composition, whatever the media query says, and this is a
  // decision rather than a shortcut. The 2D path draws a radial gradient per light and a
  // stroke per streak; at four thousand lights that is a fifth of a second a frame, so
  // running it as a loop would produce a stuttering sky that is worse than no motion in
  // every way including the accessibility one. It draws one honest still and stops.
  if (!renderer) scene.setReducedMotion(true);

  let selfId: string | null = null;
  let running = false;
  let rafId = 0;
  let pending = false;
  let epochAtStart = clock();
  let monoAtStart = monotonic();

  const times: number[] = [];
  const intervals: number[] = [];
  let frames = 0;
  let degradedAtMs: number | null = null;

  const sizeCanvas = (): void => {
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const rect = canvas.getBoundingClientRect?.() ?? { width: canvas.width, height: canvas.height };
    const w = Math.max(1, Math.round(rect.width || canvas.width || 1));
    const h = Math.max(1, Math.round(rect.height || canvas.height || 1));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scene.resize(w, h, dpr);
    renderer?.resize();
  };

  const frame = (atMs?: number): void => {
    const t0 = monotonic();
    scene.update(atMs ?? clock());
    if (renderer) renderer.render();
    else if (ctx2d) drawStill(ctx2d, scene);
    const dt = monotonic() - t0;
    frames++;
    times.push(dt);
    // A bounded window, so a tab left open for a day reports the last few seconds rather
    // than an average smeared over everything that has ever happened to it.
    if (times.length > 240) times.shift();
  };

  /** One frame, soon, and only one however many times this is called before it lands. */
  const invalidate = (): void => {
    if (running || pending) return;
    pending = true;
    const go = (): void => {
      pending = false;
      frame();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
    else go();
  };

  let lastTs = 0;
  const loop = (ts: number): void => {
    if (!running) return;
    const gap = lastTs === 0 ? 0 : ts - lastTs;
    lastTs = ts;
    // A tab that was in the background reports one enormous gap on its way back. That is not
    // a slow frame and counting it would collapse a perfectly healthy sky to a still.
    if (gap > 0 && gap < NOT_A_FRAME_MS) {
      intervals.push(gap);
      if (intervals.length > DEGRADE_WINDOW) intervals.shift();
    }
    frame(epochAtStart + (ts - monoAtStart));
    if (intervals.length === DEGRADE_WINDOW && degradedAtMs === null) {
      const p50 = median(intervals);
      if (p50 > DEGRADE_AFTER_MS) {
        degradedAtMs = p50;
        sky.setReducedMotion(true);
        return;
      }
    }
    rafId = requestAnimationFrame(loop);
  };

  const stopPalette = watchPalette(root, source, (p) => {
    scene.setPalette(p);
    invalidate();
  });

  let motionQuery: MediaQueryList | null = null;
  let onMotion: (() => void) | null = null;
  if ((options.reducedMotion ?? "auto") === "auto" && typeof matchMedia === "function") {
    motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    onMotion = (): void => {
      sky.setReducedMotion("auto");
    };
    motionQuery.addEventListener("change", onMotion);
  }

  let observerRO: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    observerRO = new ResizeObserver(() => {
      sizeCanvas();
      invalidate();
    });
    observerRO.observe(canvas);
  }

  const sky: Sky = {
    backend: renderer ? "webgl2" : "canvas2d",

    push(events) {
      if (events.length === 0) return;
      scene.push(events);
      invalidate();
    },

    handle(msg) {
      switch (msg.t) {
        case "welcome":
          selfId = msg.you;
          for (const who of msg.others) scene.upsertVisitor(who, who.id === selfId);
          break;
        case "join":
          scene.upsertVisitor(msg.who, msg.who.id === selfId);
          break;
        case "leave":
          scene.removeVisitor(msg.id);
          break;
        case "move":
          scene.setGaze(msg.id, msg.az, msg.alt);
          break;
        case "focus":
          scene.setFocus(msg.id, msg.on);
          break;
        case "events":
          scene.push(msg.batch);
          break;
      }
      invalidate();
    },

    upsertVisitor(p, isSelf) {
      scene.upsertVisitor(p, isSelf ?? p.id === selfId);
      invalidate();
    },
    removeVisitor(id) {
      scene.removeVisitor(id);
      invalidate();
    },
    setFocus(id, on) {
      scene.setFocus(id, on);
      invalidate();
    },
    setGaze(id, az, alt) {
      scene.setGaze(id, az, alt);
      invalidate();
    },
    setSelf(id) {
      selfId = id;
    },

    setObserver(o) {
      scene.setObserver({ ...scene.observer, ...o });
      invalidate();
    },
    look(az, alt) {
      scene.look(az, alt);
      invalidate();
    },
    setFov(deg) {
      scene.setFov(deg);
      invalidate();
    },

    setReducedMotion(v) {
      const on = resolveReducedMotion(v);
      if (on === scene.reducedMotion) return;
      scene.setReducedMotion(on);
      if (on) {
        sky.stop();
        invalidate();
      } else if (!running) {
        sky.start();
      }
    },

    resize() {
      sizeCanvas();
      invalidate();
    },

    hitTest: (x, y, r) => scene.hitTest(x, y, r),

    audit: () => scene.runAudit(renderer?.draws() ?? []),

    assertEarned() {
      assertEveryLightIsEarned(sky.audit());
    },

    palette: () => scene.palette,

    start() {
      // Motion reduced means no loop, ever. Data still lands, as a step.
      if (running || scene.reducedMotion) {
        invalidate();
        return;
      }
      running = true;
      epochAtStart = clock();
      monoAtStart = monotonic();
      if (typeof requestAnimationFrame === "function") rafId = requestAnimationFrame(loop);
      else running = false;
    },

    stop() {
      running = false;
      if (rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
      rafId = 0;
    },

    frame,

    stats: () => ({
      frame: { ...summarise(times, frames), intervalP50Ms: median(intervals), degradedAtMs },
      scene: scene.stats(),
    }),

    destroy() {
      sky.stop();
      stopPalette();
      observerRO?.disconnect();
      if (motionQuery && onMotion) motionQuery.removeEventListener("change", onMotion);
      renderer?.destroy();
    },
  };

  sizeCanvas();
  if (options.autoStart !== false) sky.start();
  return sky;
}

function resolveReducedMotion(v: boolean | "auto"): boolean {
  if (typeof v === "boolean") return v;
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The frame-time half of `FrameStats`. The benchmark reports from this too, so the number a
 *  page prints and the number the benchmark prints are the same measurement. */
export function summarise(
  times: readonly number[],
  frames: number,
): Omit<FrameStats, "intervalP50Ms" | "degradedAtMs"> {
  if (times.length === 0) return { frames, meanMs: 0, p50Ms: 0, p95Ms: 0, worstMs: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    frames,
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    worstMs: sorted[sorted.length - 1]!,
  };
}
