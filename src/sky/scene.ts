/**
 * The sky with no GPU attached: what is up there, where it is, and what it means.
 *
 * Everything in this file runs in plain node, which is the point. The projection, the
 * ingestion, the retiring, the hit test and the provenance audit are the parts with answers
 * that can be right or wrong, so they are kept where a test can reach them without a browser
 * and a canvas. `renderer.ts` is the part that only knows how to upload and draw, and it has
 * no arithmetic of its own worth testing.
 *
 * Placement, per kind, and the honesty each one costs:
 *
 * - **edit, quake, orbit, aurora** carry latitude and longitude and go onto the celestial
 *   sphere at the point that was overhead them when they happened. They turn with it.
 * - **a visitor** carries no position at all. The only spatial thing a person sends is where
 *   they are looking, so that is where their light goes, in the viewer's own horizontal
 *   frame, live. It does not turn with the sky, because it is not on the sky. Two people
 *   looking at the same patch overlap, and that overlap is true rather than a bug.
 *
 * The remaining honesty problem is `placement`, which is the feed's word and not ours: an
 * edit says `regional`, and every hit on one hands that straight back so the panel can say
 * the position is the wiki's region and not the editor's desk.
 */
import type { EventKind, SkyEvent } from "../shared/event.ts";
import type { Presence } from "../shared/protocol.ts";
import {
  ANTIPODE_CUT,
  DEG,
  RAD,
  airmass,
  celestialPoint,
  diurnalDirection,
  horizontal,
  localFromEquatorialUnit,
  localVec,
  planeRadius,
  stereographic,
  viewFrame,
  type Observer,
  type ViewFrame,
} from "./astro.ts";
import {
  AURORA_FADE_S,
  EARTH_RADIUS_KM,
  FOV_MAX_DEG,
  FOV_MIN_DEG,
  METEOR_DRAW_S,
  METEOR_LIFE_S,
  METEOR_MAX_DEG,
  METEOR_MIN_DEG,
  QUAKE_LIFE_S,
  RAYLEIGH_KM_S,
  STILL_EXPOSURE,
} from "./constants.ts";
import { CatalogueLayer, FifoLayer, PathLayer, SlotLayer, type LayerStats } from "./layers.ts";
import { parseColour, type PaletteSource, type RGB, type SkyPalette } from "./palette.ts";
import { Ledger, audit, type Audit, type Auditable, type DrawReport } from "./provenance.ts";
import {
  STAR_SIZE_MAX_PX,
  brightnessOf,
  catalogue,
  describeStar,
  kelvinOf,
  sizeOf,
  starColour,
  type Star,
} from "./stars.ts";

export type { Observer } from "./astro.ts";

/** Floats per instance. Kept beside the attribute wiring in `renderer.ts`; change both. */
export const STREAK_STRIDE = 4;
export const RING_STRIDE = 4;
export const DISC_STRIDE = 14;
export const ARC_STRIDE = 6;
export const STAR_STRIDE = 8;

/** Offsets of the one field in each layout that a clock rebase has to shift. */
const STREAK_TIME = 2;
const RING_TIME = 2;
const DISC_TIME = 4;

/** Once an hour, before float32 seconds lose enough resolution for meteors to judder. */
const REBASE_AFTER_MS = 3_600_000;

const HORIZON_POINTS = 288;

/**
 * How far outside a star's drawn edge still counts as pointing at it, CSS pixels.
 *
 * Smaller than the thirteen pixels an event gets, and it has to be. An event is one of a few
 * dozen lights and a generous radius is what makes a two-pixel meteor clickable; a star is one
 * of nine thousand, so the same radius would mean the panel named whichever anonymous
 * sixth-magnitude speck happened to be nearest rather than the star being pointed at. Three
 * pixels outside the drawn edge is close to "on it", which is the only honest threshold when
 * the whole hemisphere is on a nine hundred pixel canvas and a single pixel is a sixth of a
 * degree of sky.
 */
const STAR_HIT_SLOP_CSS = 3;

export type SceneOptions = {
  observer: Observer;
  palette: SkyPalette;
  fovDeg: number;
  reducedMotion: boolean;
  showSelf: boolean;
  /** Maps a visitor's yozora palette id to their accent colour, so they show up as themselves. */
  resolveAccent: ((paletteId: string) => string | null) | null;
  capacity: { meteors: number; quakes: number; discs: number; track: number };
  epochMs: number;
};

/**
 * Slots per layer. `track` is in fixes, and at 1 Hz the default is three minutes of real
 * orbit; the others are sized for the arrival rates in the concept document with headroom,
 * and `stats().layers[n].dropped` is how you find out one of them is too small.
 */
export const DEFAULT_CAPACITY = { meteors: 4096, quakes: 512, discs: 8192, track: 180 };

export type Hit = {
  kind: EventKind | "visitor" | "star";
  /** The record, verbatim. The panel prints `label` and `source` from here and nothing else. */
  event: SkyEvent | null;
  visitor: Presence | null;
  /**
   * The catalogue row, when the thing under the cursor is a star.
   *
   * Here rather than in a hit test of its own because a reader pointing at the sky is asking
   * one question, and answering it through two mechanisms is how the two start disagreeing
   * about which of an overlapping pair is on top. A caller that only handles events reads
   * `event` and gets null for a star, which is the same miss it already gets for a visitor.
   */
  star: Star | null;
  /**
   * What it is, in one line, whichever of the three it turned out to be.
   *
   * An event already carries its own `label` and this hands that straight back, unchanged: the
   * field exists because a star does not have one and the alternative was a caller switching on
   * `kind` to find out where to read the name from. Never generated or embellished, exactly as
   * `SkyEvent.label` is not.
   */
  label: string;
  altDeg: number;
  azDeg: number;
  /** CSS pixels, where the light actually landed. */
  x: number;
  y: number;
  distancePx: number;
  /** What the drawing is saying, so the panel can explain the picture as well as the record. */
  encoding: string;
  /** True when the feed placed this by region rather than measuring it. */
  inferredPlacement: boolean;
};

type VisitorState = { presence: Presence; isSelf: boolean };

/** Deterministic, so a light drifts the same way across a reload. FNV-1a, 32 bit. */
export function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * The key an aurora cell is stored under.
 *
 * Deliberately not the event id. OVATION reports the same grid cell every five minutes, and
 * whether the normalizer gives that a stable id or one that carries the poll timestamp is its
 * business, not ours. Keying by the coordinate means a cell always updates its own light
 * rather than adding a second one beside it, whichever choice the normalizer made. Two
 * decimal places is finer than any OVATION grid, so it cannot merge two real cells.
 */
export function auroraCellKey(e: SkyEvent): string {
  return `aurora:${e.lat.toFixed(2)}:${e.lon.toFixed(2)}`;
}

export class Scene {
  readonly ledger = new Ledger();
  readonly meteors: FifoLayer;
  readonly quakes: FifoLayer;
  readonly discs: SlotLayer;
  readonly track: PathLayer;
  readonly horizon: PathLayer;
  /** The fixed stars. Written once; only the rotation uniform changes after that. */
  readonly stars: CatalogueLayer;

  private opts: SceneOptions;
  private visitors = new Map<string, VisitorState>();
  private trackFixes: SkyEvent[] = [];
  private frame: ViewFrame;
  private epochMs: number;
  private nowMs: number;
  private widthCss = 1;
  private heightCss = 1;
  private dpr = 1;
  /** Device pixels per plane unit. Everything the shader does with sizes goes through this. */
  private scale = 1;
  private paletteRev = 0;

  readonly uniforms = new Float32Array(24);

  constructor(opts: SceneOptions) {
    this.opts = opts;
    this.epochMs = opts.epochMs;
    this.nowMs = opts.epochMs;
    this.meteors = new FifoLayer("meteors", opts.capacity.meteors, STREAK_STRIDE, this.ledger);
    this.quakes = new FifoLayer("quakes", opts.capacity.quakes, RING_STRIDE, this.ledger);
    this.discs = new SlotLayer("discs", opts.capacity.discs, DISC_STRIDE, this.ledger);
    this.track = new PathLayer("track", opts.capacity.track, this.ledger);
    // The horizon is not a light layer and is never handed to the audit as one. It is
    // declared chrome, and the audit checks it by name on the draw side instead.
    this.horizon = new PathLayer("horizon", HORIZON_POINTS + 1, this.ledger);
    // Exactly as long as the catalogue, which is the property the audit leans on: there is no
    // spare slot for a light with no record behind it to sit in.
    this.stars = new CatalogueLayer("stars", catalogue().length, STAR_STRIDE, this.ledger);
    this.frame = viewFrame(opts.observer, this.epochMs);
    this.buildHorizon();
    this.buildStars();
  }

  /** The layers the provenance audit walks. Chrome is deliberately not among them. */
  auditableLayers(): Auditable[] {
    return [this.meteors, this.quakes, this.discs, this.track, this.stars];
  }

  get palette(): SkyPalette {
    return this.opts.palette;
  }

  get observer(): Observer {
    return this.opts.observer;
  }

  get reducedMotion(): boolean {
    return this.opts.reducedMotion;
  }

  /** Full angle across the frame, degrees. What the camera reads to seed itself. */
  get fov(): number {
    return this.opts.fovDeg;
  }

  get exposure(): number {
    return this.opts.reducedMotion ? STILL_EXPOSURE : 1;
  }

  get paletteRevision(): number {
    return this.paletteRev;
  }

  // ---------------------------------------------------------------- ingestion

  push(events: readonly SkyEvent[]): void {
    for (const e of events) this.pushOne(e);
  }

  private pushOne(e: SkyEvent): void {
    switch (e.kind) {
      case "edit":
        this.pushTransient(this.meteors, e);
        return;
      case "quake":
        this.pushTransient(this.quakes, e);
        return;
      case "aurora":
        this.pushAurora(e);
        return;
      case "orbit":
        this.pushOrbit(e);
        return;
    }
  }

  /**
   * Meteors and quakes, and the replay guard.
   *
   * `SkyEvent.id` is stable at the source precisely so a replayed batch cannot double render,
   * and the ledger already holds a key per live light, so asking it is the whole check. An id
   * that has already aged off the sky is not rejected, which is right: it would be re-added
   * with its original timestamp and retired on the same frame.
   */
  private pushTransient(layer: FifoLayer, e: SkyEvent): void {
    if (this.ledger.get(`e:${e.id}`)) return;
    const eq = celestialPoint(e.lat, e.lon, e.at);
    const t = (e.at - this.epochMs) / 1000;
    const mag = clamp01(e.magnitude);
    layer.push({ of: "event", event: e }, e.at, (into, at) => {
      into[at] = eq.dec;
      into[at + 1] = eq.ra;
      into[at + 2] = t;
      into[at + 3] = mag;
    });
  }

  private pushAurora(e: SkyEvent): void {
    const key = auroraCellKey(e);
    const eq = celestialPoint(e.lat, e.lon, e.at);
    // The two numbers here are the difference between a band and a bruise.
    //
    // Cells overlap: the grid is finer than a cell is wide, so roughly eight of them land on
    // any given pixel and the blend is additive. A generous per-cell alpha therefore sums to
    // a solid wash, which is exactly the soft glowing blob this project exists not to be. The
    // ceiling here is what one cell contributes to a texture, not how bright the aurora is.
    //
    // Tune this against a SETTLED band, not a fresh one. A cell crosses to its new value over
    // forty seconds, so a screenshot taken four seconds after a poll lands is showing a tenth
    // of the brightness it is heading for, and the first pass of this number was set from
    // exactly such a screenshot and came out four times too high.
    //
    // The exponent holds the faint edge of the oval down so the band keeps its shape rather
    // than smearing out to its own threshold.
    // The probability that counts as a full-strength aurora on screen.
    //
    // OVATION's scale runs to 100 per cent, and the data does not. A quiet night sits between
    // two and fifteen per cent and a strong storm reaches the sixties, so mapping the published
    // number straight onto brightness spends almost the whole display range on values that
    // never arrive. It showed: a four per cent cell rendered at 0.04^1.6 * 0.1, which is six
    // hundredths of one per cent alpha, and the band was invisible on a working sky.
    //
    // Normalising against a reference is the same move as choosing sensible axis limits on a
    // chart rather than always starting at zero. It changes no measurement: `magnitude` stays
    // the probability the feed published and the panel still prints that number. What changes
    // is how much of the screen's range a real reading gets to use.
    //
    // Clamped, so a genuine storm saturates rather than overflowing, and cells above the
    // reference still read as brighter than everything around them.
    const AURORA_FULL_AT = 0.35;
    const norm = clamp01(e.magnitude / AURORA_FULL_AT);
    const target = Math.pow(norm, 1.6) * 0.1;
    const slot = this.discs.slotFor(key);
    const from = slot === undefined ? 0 : this.currentDiscAlpha(slot);
    const colour = this.opts.palette.aurora;
    this.discs.upsert(key, { of: "event", event: e }, (into, at) => {
      writeDisc(into, at, {
        a: eq.dec,
        b: eq.ra,
        from,
        to: target,
        startSec: (this.nowMs - this.epochMs) / 1000,
        durSec: AURORA_FADE_S,
        // Close to a real OVATION cell, which is about a degree of latitude by two of
        // longitude. Larger than that and neighbours stop being distinguishable.
        sizeDeg: 3,
        soften: 1,
        driftPx: 0,
        horizontalSpace: false,
        colour,
        seed: seedOf(key),
      });
    });
  }

  private pushOrbit(e: SkyEvent): void {
    if (this.ledger.get(`e:${e.id}`) && this.trackFixes.some((f) => f.id === e.id)) return;
    const eq = celestialPoint(e.lat, e.lon, e.at);
    this.discs.upsert("iss", { of: "event", event: e }, (into, at) => {
      writeDisc(into, at, {
        a: eq.dec,
        b: eq.ra,
        from: 1,
        to: 1,
        startSec: 0,
        durSec: 1,
        sizeDeg: 2,
        soften: 0.15,
        driftPx: 0,
        horizontalSpace: false,
        colour: this.opts.palette.orbit,
        seed: 0,
      });
    });
    this.trackFixes.push(e);
    // Off the capacity rather than off a constant of its own. The path layer truncates to the
    // capacity it was built with, so a second number here would silently keep fixes that
    // never get drawn.
    if (this.trackFixes.length > this.opts.capacity.track) this.trackFixes.shift();
    this.rebuildTrack();
  }

  private rebuildTrack(): void {
    const n = this.trackFixes.length;
    this.track.set(
      this.trackFixes.map((f, i) => {
        const eq = celestialPoint(f.lat, f.lon, f.at);
        return {
          a: eq.dec,
          b: eq.ra,
          // Oldest end nearly gone, newest end full. The track is a memory of where it has
          // been, and a memory that does not fade is a line.
          fade: 0.1 + 0.9 * ((i + 1) / n) ** 2,
          backing: { of: "event" as const, event: f },
        };
      }),
    );
  }

  // ---------------------------------------------------------------- visitors

  upsertVisitor(p: Presence, isSelf = false): void {
    this.visitors.set(p.id, { presence: p, isSelf });
    this.writeVisitor(p, isSelf);
  }

  removeVisitor(id: string): void {
    this.visitors.delete(id);
    this.discs.remove(`visitor:${id}`);
  }

  setFocus(id: string, on: boolean): void {
    const v = this.visitors.get(id);
    if (!v) return;
    v.presence = { ...v.presence, focused: on };
    this.writeVisitor(v.presence, v.isSelf);
  }

  setGaze(id: string, azDeg: number, altDeg: number): void {
    const v = this.visitors.get(id);
    if (!v) return;
    v.presence = { ...v.presence, az: azDeg, alt: altDeg };
    this.writeVisitor(v.presence, v.isSelf);
  }

  private writeVisitor(p: Presence, isSelf: boolean): void {
    if (isSelf && !this.opts.showSelf) return;
    const key = `visitor:${p.id}`;
    const slot = this.discs.slotFor(key);
    const from = slot === undefined ? 0 : this.currentDiscAlpha(slot);
    const alpha = p.focused ? 0.95 : 0.6;
    // The contrast the whole social layer rests on, in two channels so it survives being
    // small: a focused light is bigger and brighter, and its drift is exactly zero. The
    // shader reads a zero drift as "do not scintillate either", so a focused star is the only
    // thing in the sky that is completely still.
    const sizeDeg = (isSelf ? 0.9 : 0) + (p.focused ? 2.1 : 1.5);
    const driftPx = p.focused ? 0 : 2.4;
    const colour = this.visitorColour(p, isSelf);
    this.discs.upsert(key, { of: "visitor", presence: p }, (into, at) => {
      writeDisc(into, at, {
        a: p.alt * DEG,
        b: p.az * DEG,
        from,
        to: alpha,
        startSec: (this.nowMs - this.epochMs) / 1000,
        // A focus session starting is a thing you should see happen, so it takes a beat
        // rather than a step, and it is the only fast crossfade in here.
        durSec: 1.2,
        sizeDeg,
        soften: 0,
        driftPx,
        horizontalSpace: true,
        colour,
        seed: seedOf(key),
      });
    });
  }

  private visitorColour(p: Presence, isSelf: boolean): RGB {
    if (isSelf) return this.opts.palette.you;
    const hex = this.opts.resolveAccent?.(p.palette) ?? null;
    if (hex === null) return this.opts.palette.visitor;
    return parseOr(hex, this.opts.palette.visitor);
  }

  private currentDiscAlpha(slot: number): number {
    const o = slot * DISC_STRIDE;
    const d = this.discs.data;
    const from = d[o + 2]!;
    const to = d[o + 3]!;
    const start = d[o + 4]!;
    const dur = Math.max(d[o + 5]!, 0.001);
    const t = clamp01(((this.nowMs - this.epochMs) / 1000 - start) / dur);
    return from + (to - from) * t;
  }

  // ---------------------------------------------------------------- view state

  setObserver(o: Observer): void {
    this.opts = { ...this.opts, observer: o };
  }

  look(azDeg: number, altDeg: number): void {
    this.opts = { ...this.opts, observer: { ...this.opts.observer, gazeAzDeg: azDeg, gazeAltDeg: altDeg } };
  }

  setFov(deg: number): void {
    // The same limits the camera clamps to, from the same constants, so a field of view that
    // arrives through `Sky.setFov` and one that arrives through a pinch cannot end up with two
    // different ideas of how wide the sky is allowed to be.
    this.opts = { ...this.opts, fovDeg: Math.max(FOV_MIN_DEG, Math.min(FOV_MAX_DEG, deg)) };
    this.resize(this.widthCss, this.heightCss, this.dpr);
  }

  setReducedMotion(on: boolean): void {
    this.opts = { ...this.opts, reducedMotion: on };
  }

  /**
   * Re-read the palette and repaint everything that carries a colour in its instance data.
   *
   * Only the disc layer does; meteors, rings, the track and the horizon take their colour
   * from a uniform, so they cost nothing. The discs are rewritten rather than tinted because
   * a visitor's colour comes from their own palette and an aurora cell's from the viewer's,
   * and only the writer knows which.
   */
  setPalette(p: SkyPalette): void {
    this.opts = { ...this.opts, palette: p };
    this.paletteRev++;
    for (const v of this.visitors.values()) this.writeVisitor(v.presence, v.isSelf);
    const d = this.discs.data;
    for (const slot of this.discs.liveSlots()) {
      const key = this.discs.slotBacking(slot);
      if (key === null) continue;
      const backing = this.ledger.get(key);
      if (!backing || backing.of !== "event") continue;
      const colour = backing.event.kind === "orbit" ? p.orbit : p.aurora;
      const o = slot * DISC_STRIDE;
      d[o + 10] = colour[0];
      d[o + 11] = colour[1];
      d[o + 12] = colour[2];
      this.discs.touchSlot(slot);
    }
    // The stars carry a colour too, and the colourless end of it is the palette's. Cheaper
    // than it looks: `starColour` returns the token unchanged for anything fainter than third
    // magnitude, so only a few hundred of the nine thousand do any arithmetic.
    this.repaintStars();
  }

  resize(widthCss: number, heightCss: number, dpr: number): void {
    this.widthCss = Math.max(1, widthCss);
    this.heightCss = Math.max(1, heightCss);
    const previousDpr = this.dpr;
    this.dpr = Math.max(0.5, dpr);
    // A star is sized in device pixels rather than degrees of sky, so its instance data is the
    // one thing in the scene that depends on the device pixel ratio. Moving a window between a
    // laptop screen and an external monitor is the case, and it is rare enough that rewriting
    // nine thousand instances is the right trade against carrying a dpr uniform for it.
    if (this.dpr !== previousDpr) this.repaintStars();
    const edgePx = (Math.min(this.widthCss, this.heightCss) * this.dpr) / 2;
    // Two percent of margin so the horizon ring is inside the frame rather than tangent to
    // it, which reads as a crop rather than as a boundary.
    this.scale = (edgePx * 0.98) / planeRadius((this.opts.fovDeg / 2) * DEG);
  }

  /** The observer frame the last `update` computed. Read by the 2D still fallback. */
  get view(): ViewFrame {
    return this.frame;
  }

  get nowEpochMs(): number {
    return this.nowMs;
  }

  get epoch(): number {
    return this.epochMs;
  }

  get viewport(): { widthCss: number; heightCss: number; dpr: number; scale: number } {
    return { widthCss: this.widthCss, heightCss: this.heightCss, dpr: this.dpr, scale: this.scale };
  }

  // ---------------------------------------------------------------- per frame

  /**
   * Everything a frame needs, done once.
   *
   * Retire, rebase if the clock has drifted far enough to matter, recompute the observer's
   * frame, fill the uniform block. Nothing here is proportional to how many lights are on the
   * sky: the two retire loops walk only what actually expired.
   */
  update(nowMs: number): void {
    this.nowMs = nowMs;
    if (nowMs - this.epochMs > REBASE_AFTER_MS) this.rebaseClock(nowMs);

    const exposure = this.exposure;
    this.meteors.retire(nowMs, METEOR_LIFE_S * 1000 * exposure);
    this.quakes.retire(nowMs, QUAKE_LIFE_S * 1000 * exposure);

    this.frame = viewFrame(this.opts.observer, nowMs);
    this.fillUniforms();
  }

  /**
   * Move the epoch forward so instance times stay small.
   *
   * float32 holds about seven significant digits. At a day old, a stored time in seconds has
   * 5ms of resolution, and a meteor whose whole life is 2.2 seconds quantises visibly. This
   * is the fix, and it is the reason a tab left open for a week looks the same as one opened
   * a minute ago.
   */
  private rebaseClock(nowMs: number): void {
    const delta = nowMs - this.epochMs - 60_000;
    this.meteors.rebase(delta, STREAK_TIME);
    this.quakes.rebase(delta, RING_TIME);
    this.discs.rebase(delta, DISC_TIME);
    this.epochMs += delta;
  }

  private fillUniforms(): void {
    const u = this.uniforms;
    const f = this.frame;
    const p = this.opts.palette;
    const wPx = this.widthCss * this.dpr;
    const hPx = this.heightCss * this.dpr;

    u[0] = f.right.x; u[1] = f.right.y; u[2] = f.right.z; u[3] = this.scale;
    u[4] = f.up.x; u[5] = f.up.y; u[6] = f.up.z; u[7] = 0.85 * this.dpr;
    u[8] = f.forward.x; u[9] = f.forward.y; u[10] = f.forward.z;
    u[11] = (this.nowMs - this.epochMs) / 1000;
    u[12] = f.lst; u[13] = f.sinPhi; u[14] = f.cosPhi;
    u[15] = p.scheme === "light" ? 1 : 0;
    u[16] = 2 / wPx; u[17] = 2 / hPx;
    u[18] = this.exposure;
    u[19] = this.opts.reducedMotion ? 1 : 0;
    u[20] = p.bg[0]; u[21] = p.bg[1]; u[22] = p.bg[2];
    u[23] = 1;
  }

  // ---------------------------------------------------------------- chrome

  /**
   * The horizon, and the compass in it.
   *
   * A ring at altitude zero, in horizontal coordinates, so it does not turn with the sky. The
   * four cardinal points are the same ring brightened over six degrees of azimuth rather than
   * four extra marks, and North is brighter than the other three so the ring says which way
   * round it is without a label. One element instead of five, which is the whole argument for
   * doing it this way.
   */
  private buildHorizon(): void {
    const pts: { a: number; b: number; fade: number; backing: null }[] = [];
    for (let i = 0; i <= HORIZON_POINTS; i++) {
      const az = ((i % HORIZON_POINTS) / HORIZON_POINTS) * 360;
      let fade = 0.34;
      for (const [card, weight] of [[0, 1], [90, 0.5], [180, 0.5], [270, 0.5]] as const) {
        // Signed difference in degrees, wrapped to [-180, 180], so the arc around azimuth 0
        // does not break in half at the seam.
        const diff = Math.abs(((az - card + 540) % 360) - 180);
        const near = Math.max(0, 1 - diff / 6);
        fade = Math.max(fade, 0.34 + 0.66 * weight * near * near);
      }
      pts.push({ a: 0, b: az * DEG, fade, backing: null });
    }
    this.horizon.set(pts);
  }

  // ---------------------------------------------------------------- the catalogue

  /**
   * The fixed stars, written once.
   *
   * Every per-star number that can be worked out in advance is worked out here and never
   * again: brightness from magnitude, diameter from brightness, colour from the colour index
   * and the palette's neutral. The shader is then left with the only things that actually
   * change, which are where the star is in this observer's sky and how much air it is being
   * seen through, and both of those come off the same rotation uniform every other layer
   * already reads. That is why nine thousand more lights cost one more draw call and no more
   * per-frame work.
   *
   * The curves themselves live in `stars.ts` and exist once. Recomputing them in GLSL would
   * have meant a second copy of the magnitude scale for the parity test to guard, for
   * arithmetic whose inputs are constant.
   */
  private buildStars(): void {
    const stars = catalogue();
    this.stars.fill(
      stars.map((star) => ({ of: "star" as const, star })),
      (into, at, i) => this.writeStar(into, at, stars[i]!),
    );
  }

  private writeStar(into: Float32Array, at: number, star: Star): void {
    const colour = starColour(star.mag, star.ci, this.opts.palette.star);
    into[at] = star.decRad;
    into[at + 1] = star.raRad;
    into[at + 2] = sizeOf(star.mag) * this.dpr;
    into[at + 3] = brightnessOf(star.mag);
    into[at + 4] = colour[0];
    into[at + 5] = colour[1];
    into[at + 6] = colour[2];
    // Off the catalogue index, so a star shimmers the same way across a reload and no two
    // neighbours shimmer together.
    into[at + 7] = seedOf(`star:${star.index}`);
  }

  private repaintStars(): void {
    const stars = catalogue();
    this.stars.recolour((into, at, i) => this.writeStar(into, at, stars[i]!));
  }

  // ---------------------------------------------------------------- audit

  runAudit(draws: readonly DrawReport[]): Audit {
    return audit(this.ledger, this.auditableLayers(), draws);
  }

  stats(): { layers: LayerStats[]; ledger: number; visitors: number; epochMs: number } {
    return {
      layers: [
        this.meteors.stats(),
        this.quakes.stats(),
        this.discs.stats(),
        this.track.stats(),
        this.stars.stats(),
      ],
      ledger: this.ledger.size,
      visitors: this.visitors.size,
      epochMs: this.epochMs,
    };
  }

  // ---------------------------------------------------------------- hit test

  /**
   * What is under the cursor, so the panel can say exactly what it was.
   *
   * Brute force over every live light, on purpose. Four thousand lights is four thousand
   * projections, which is under a tenth of a millisecond; a spatial index would be a second
   * copy of the scene to keep in step with the first for no measurable gain. Hover is not a
   * frame, and this is the one place where doing the simple thing is also the fast thing.
   *
   * The geometry each kind is tested against is its real geometry: the distance to a streak
   * is the distance to the segment, and to a quake it is the distance to the ring's
   * circumference rather than to its centre, because the middle of a quake ring is empty and
   * clicking empty sky should not select it.
   *
   * The one thing mirrored from the shader here is the idle visitor's drift. If you change
   * the wobble in `DISC_VERT` you have to change it here, or hovering a drifting star will
   * pick up the star it used to be.
   */
  hitTest(xCss: number, yCss: number, radiusCss = 13): Hit | null {
    const cx = this.widthCss / 2;
    const cy = this.heightCss / 2;
    // Everything below works in CSS pixels about the centre of the canvas, with y up, so the
    // scale has to come back down by the device pixel ratio the uniform took it up by.
    const s = this.scale / this.dpr;
    const px = xCss - cx;
    const py = -(yCss - cy);
    const nowSec = (this.nowMs - this.epochMs) / 1000;
    const exposure = this.exposure;
    const f = this.frame;

    let best: Hit | null = null;
    let bestDist = radiusCss;

    // Shared with `locate`, because the two answer different questions and must still agree
    // on where every light is.
    const project = (dec: number, ra: number, alreadyHorizontal = false) =>
      this.projectDrawn(dec, ra, alreadyHorizontal);

    // Meteors: distance to the streak, which is a segment, not to the point it grew from.
    for (const slot of this.meteors.liveSlots()) {
      const d = this.meteors.data;
      const o = slot * STREAK_STRIDE;
      const dec = d[o]!;
      const ra = d[o + 1]!;
      const p = project(dec, ra);
      if (!p) continue;
      const mag = d[o + 3]!;
      const drawn = smoothstep01(clamp01((nowSec - d[o + 2]!) / (METEOR_DRAW_S * exposure)));
      const len = (METEOR_MIN_DEG + (METEOR_MAX_DEG - METEOR_MIN_DEG) * mag) * DEG * p.k * s * drawn;
      const dir = diurnalDirection({ dec, ra }, f);
      const hx = p.x + (dir?.dx ?? 0) * len;
      const hy = p.y + (dir?.dy ?? 0) * len;
      const dist = distanceToSegment(px, py, p.x, p.y, hx, hy);
      if (dist >= bestDist) continue;
      const backing = this.backingOf(this.meteors.slotBacking(slot));
      if (!backing || backing.of !== "event") continue;
      best = this.hitOf({ event: backing.event }, { altRad: p.alt, azRad: p.az, distancePx: dist, x: hx, y: hy },
        `length and brightness are the magnitude the feed reported, ${Math.round(mag * 100)} percent, which for an edit is bytes changed. The direction is the sky's own rotation carrying that point, not a path the edit took.`);
      bestDist = dist;
    }

    // Quakes: distance to the circumference. The middle of a ring is empty sky and clicking
    // empty sky should not select the earthquake that happens to be centred on it.
    for (const slot of this.quakes.liveSlots()) {
      const d = this.quakes.data;
      const o = slot * RING_STRIDE;
      const p = project(d[o]!, d[o + 1]!);
      if (!p) continue;
      const age = nowSec - d[o + 2]!;
      const rRad = (RAYLEIGH_KM_S * age) / EARTH_RADIUS_KM;
      // Conformal, so a small circle of angular radius r lands at plane radius r times k.
      const rPx = rRad * p.k * s;
      const dist = Math.abs(Math.hypot(px - p.x, py - p.y) - rPx);
      if (dist >= bestDist) continue;
      const backing = this.backingOf(this.quakes.slotBacking(slot));
      if (!backing || backing.of !== "event") continue;
      best = this.hitOf({ event: backing.event }, { altRad: p.alt, azRad: p.az, distancePx: dist, x: p.x, y: p.y },
        `the ring is the Rayleigh surface wave at 3.5 km per second, ${Math.round(RAYLEIGH_KM_S * age)} km out after ${Math.round(age)} seconds.`);
      bestDist = dist;
    }

    // Discs: aurora cells, the ISS head, and the people.
    for (const slot of this.discs.liveSlots()) {
      const d = this.discs.data;
      const o = slot * DISC_STRIDE;
      const p = project(d[o]!, d[o + 1]!, d[o + 9]! > 0.5);
      if (!p) continue;
      const { x: hx, y: hy } = this.discDrawnPoint(o, p.x, p.y, nowSec);
      const dist = Math.hypot(px - hx, py - hy);
      if (dist >= bestDist) continue;
      const backing = this.backingOf(this.discs.slotBacking(slot));
      if (!backing) continue;
      const where = { altRad: p.alt, azRad: p.az, distancePx: dist, x: hx, y: hy };
      if (backing.of === "visitor") {
        const who = backing.presence;
        best = this.hitOf({ visitor: who }, where,
          who.focused
            ? "in a focus session, so it holds perfectly still. Placed where they are looking, which is the only position anyone sends."
            : "idle, so it drifts and scintillates. Placed where they are looking, which is the only position anyone sends.");
      } else if (backing.of === "event") {
        const e = backing.event;
        best = this.hitOf({ event: e }, where,
          e.kind === "aurora"
            ? `brightness is the OVATION probability at this cell, ${Math.round(e.magnitude * 100)} percent.`
            : "the ISS, at the position its own track reported. The trail behind it is the last three minutes of fixes.");
      } else {
        // Nothing in the disc layer is a star. Skipping rather than asserting, because the
        // audit is what enforces what is allowed to be in which layer.
        continue;
      }
      bestDist = dist;
    }

    // Stars, and only if nothing else was hit.
    //
    // **Not in the same nearest-wins race as everything else, on purpose.** There are 8,920
    // stars and roughly four thousand of them are above the horizon at any moment, so at a
    // thirteen pixel grab radius there are usually several inside the cursor and one of them
    // is almost always nearer than the meteor you were actually pointing at. Letting stars
    // compete on distance would mean the evidence panel could no longer be pointed at an
    // event, which is the thing this page is for. So the events and the people win, and the
    // catalogue answers the rest of the sky.
    //
    // Within the catalogue the contest is by EDGE rather than by centre: a star's score is its
    // distance minus its own drawn radius, so the brightest star near the cursor wins over a
    // fainter one a pixel closer. You hit what you can see, which is the behaviour anybody
    // pointing at Vega expects.
    if (best === null) best = this.hitStar(px, py, s);

    return best;
  }

  /**
   * The catalogue under the cursor, in one pass with no trigonometry in it.
   *
   * Nine thousand stars on every pointer move is the one place in this file where the obvious
   * loop is too slow: `horizontal` costs four transcendentals a point, which at this size is
   * most of a millisecond and turns a hover into a stutter. A star's position never changes,
   * so its equatorial unit vector is cached in the catalogue and the per-frame part is a
   * rotation. See `localFromEquatorialUnit`.
   *
   * The projection below is the same one `projectDrawn` applies, written against a direction
   * vector instead of a declination and a right ascension because that is what the fast path
   * produces. `test/sky/stars.test.ts` pins the two against each other.
   */
  private hitStar(px: number, py: number, scaleCss: number): Hit | null {
    const f = this.frame;
    const sinLst = Math.sin(f.lst);
    const cosLst = Math.cos(f.lst);
    const stars = catalogue();
    const data = this.stars.data;

    // A cheap rejection bound before any square root: the furthest a cursor can be from a
    // star's centre and still touch it is the biggest drawn radius plus the slop.
    const reach = STAR_SIZE_MAX_PX / 2 + STAR_HIT_SLOP_CSS;
    const reach2 = reach * reach;

    let bestScore = STAR_HIT_SLOP_CSS;
    let bestStar: Star | null = null;
    let bestVec = { x: 0, y: 0, z: 0 };
    let bestX = 0;
    let bestY = 0;
    let bestDist = 0;

    for (let i = 0; i < stars.length; i++) {
      const star = stars[i]!;
      const v = localFromEquatorialUnit(star.unit, sinLst, cosLst, f.sinPhi, f.cosPhi);
      // Below the horizon. Half the catalogue, rejected on a sign test.
      if (v.z <= 0) continue;
      const z = v.x * f.forward.x + v.y * f.forward.y + v.z * f.forward.z;
      if (z <= ANTIPODE_CUT) continue;
      const k = (2 / (1 + z)) * scaleCss;
      const dx = px - k * (v.x * f.right.x + v.y * f.right.y + v.z * f.right.z);
      const dy = py - k * (v.x * f.up.x + v.y * f.up.y + v.z * f.up.z);
      const d2 = dx * dx + dy * dy;
      if (d2 > reach2) continue;

      const dist = Math.sqrt(d2);
      // The drawn diameter is in device pixels, and everything here is in CSS pixels.
      const score = dist - data[i * STAR_STRIDE + 2]! / (2 * this.dpr);
      if (score >= bestScore) continue;
      bestScore = score;
      bestStar = star;
      bestVec = v;
      bestX = px - dx;
      bestY = py - dy;
      bestDist = dist;
    }

    if (bestStar === null) return null;
    const alt = Math.asin(Math.max(-1, Math.min(1, bestVec.z)));
    return this.hitOf(
      { star: bestStar },
      {
        altRad: alt,
        azRad: Math.atan2(bestVec.x, bestVec.y),
        distancePx: bestDist,
        x: bestX,
        y: bestY,
      },
      `brightness is apparent magnitude ${bestStar.mag.toFixed(2)}, on the real scale, where one ` +
        `magnitude is 2.512 times the light and the naked eye stops at 6.5. The colour is a ` +
        `blackbody at ${Math.round(kelvinOf(bestStar.ci) / 10) * 10} K, which is what this star's ` +
        `colour index of ${bestStar.ci.toFixed(2)} means. Dimmed here by the ` +
        `${airmass(alt).toFixed(2)} airmasses of atmosphere it is being seen through.`,
    );
  }

  /**
   * Where a point on the celestial sphere lands right now, in CSS pixels about the centre.
   *
   * Extracted so `hitTest` and `locate` cannot disagree. They answer opposite questions, what
   * is under this pixel and where is this record, but both depend on the same projection, and
   * two copies of a projection drift the moment one of them is tuned.
   */
  private projectDrawn(
    dec: number,
    ra: number,
    alreadyHorizontal = false,
  ): { x: number; y: number; k: number; alt: number; az: number } | null {
    const f = this.frame;
    const s = this.scale / this.dpr;
    const h = alreadyHorizontal ? { alt: dec, az: ra } : horizontal({ dec, ra }, f.lst, f.sinPhi, f.cosPhi);
    if (h.alt <= 0) return null;
    const v = localVec(h);
    const p = stereographic(v, f);
    if (!p) return null;
    const z = v.x * f.forward.x + v.y * f.forward.y + v.z * f.forward.z;
    return { x: p.x * s, y: p.y * s, k: 2 / (1 + z), alt: h.alt, az: h.az };
  }

  /**
   * Where a disc is actually drawn, wobble included.
   *
   * Mirrored from DISC_VERT. Change the wobble there and you must change it here, or hovering
   * a drifting star picks up where it was rather than where it is. One copy on this side,
   * shared by `hitTest` and `locate`, so the mirror stays a pair rather than becoming a trio.
   */
  private discDrawnPoint(o: number, x: number, y: number, nowSec: number): { x: number; y: number } {
    const driftPx = this.discs.data[o + 8]!;
    if (!(driftPx > 0) || this.opts.reducedMotion) return { x, y };
    const seed = this.discs.data[o + 13]!;
    return {
      x: x + driftPx * Math.sin(nowSec * 0.11 + seed * 6.2832),
      y: y + driftPx * Math.sin(nowSec * 0.083 + seed * 9.911),
    };
  }

  /**
   * Where the light for a record is on screen right now, or null if it is not drawn.
   *
   * The inverse of `hitTest`, and it exists for the keyboard. Someone arrowing through the
   * register has selected a record, and without this there is no way to point back at the light
   * it belongs to: the ring would have to be guessed. A caller draws that ring in the DOM rather
   * than here on purpose, because a ring drawn by this renderer would be a draw call with no
   * backing event and the provenance audit would be right to refuse it.
   *
   * **Null is a real answer and must be drawn as nothing.** It means the light is genuinely not
   * on screen, either because it has aged out of its layer or because that part of the sky is
   * below the horizon, and both are ordinary. A caller that falls back to a plausible position
   * is inventing one, which is the same failure the placement rules exist to prevent.
   */
  locate(id: string): { x: number; y: number } | null {
    const nowSec = (this.nowMs - this.epochMs) / 1000;
    const cx = this.widthCss / 2;
    const cy = this.heightCss / 2;
    /** Canvas pixels, matching `hitOf`, so a ring lands where a pointer would have hit. */
    const at = (x: number, y: number) => ({ x: cx + x, y: cy - y });

    // Stars are deliberately not reachable here. `locate` exists so the keyboard can ring the
    // light it has selected in the register, and the register holds events; a star has no id in
    // that namespace and nothing ever asks for one.
    const matches = (key: string | null): boolean => {
      const b = this.backingOf(key);
      if (!b) return false;
      if (b.of === "event") return b.event.id === id;
      if (b.of === "visitor") return b.presence.id === id;
      return false;
    };

    // Meteors report the head of the streak, not the point it grew from, because the head is
    // where the eye is and where the streak's own hit test is closest.
    for (const slot of this.meteors.liveSlots()) {
      if (!matches(this.meteors.slotBacking(slot))) continue;
      const d = this.meteors.data;
      const o = slot * STREAK_STRIDE;
      const dec = d[o]!;
      const ra = d[o + 1]!;
      const p = this.projectDrawn(dec, ra);
      if (!p) return null;
      const drawn = smoothstep01(clamp01((nowSec - d[o + 2]!) / (METEOR_DRAW_S * this.exposure)));
      const len =
        (METEOR_MIN_DEG + (METEOR_MAX_DEG - METEOR_MIN_DEG) * d[o + 3]!) * DEG * p.k * (this.scale / this.dpr) * drawn;
      const dir = diurnalDirection({ dec, ra }, this.frame);
      return at(p.x + (dir?.dx ?? 0) * len, p.y + (dir?.dy ?? 0) * len);
    }

    // A quake reports its centre, which is where the epicentre is, even though the hit test
    // wants the circumference. A ring around a ring would be unreadable.
    for (const slot of this.quakes.liveSlots()) {
      if (!matches(this.quakes.slotBacking(slot))) continue;
      const d = this.quakes.data;
      const o = slot * RING_STRIDE;
      const p = this.projectDrawn(d[o]!, d[o + 1]!);
      return p ? at(p.x, p.y) : null;
    }

    for (const slot of this.discs.liveSlots()) {
      if (!matches(this.discs.slotBacking(slot))) continue;
      const d = this.discs.data;
      const o = slot * DISC_STRIDE;
      const p = this.projectDrawn(d[o]!, d[o + 1]!, d[o + 9]! > 0.5);
      if (!p) return null;
      const q = this.discDrawnPoint(o, p.x, p.y, nowSec);
      return at(q.x, q.y);
    }

    return null;
  }

  private backingOf(key: string | null): ReturnType<Ledger["get"]> {
    return key === null ? undefined : this.ledger.get(key);
  }

  /**
   * One subject, not three nullable ones.
   *
   * There are three kinds of thing that can be under a cursor and each carries a different
   * record, so the alternative was a positional argument per kind with nulls in the other two
   * slots. That shape is how a call ends up passing the right record in the wrong position.
   */
  private hitOf(
    subject: { event: SkyEvent } | { visitor: Presence } | { star: Star },
    at: { altRad: number; azRad: number; distancePx: number; x: number; y: number },
    encoding: string,
  ): Hit {
    const event = "event" in subject ? subject.event : null;
    const visitor = "visitor" in subject ? subject.visitor : null;
    const star = "star" in subject ? subject.star : null;
    return {
      kind: star ? "star" : visitor ? "visitor" : (event?.kind ?? "edit"),
      event,
      visitor,
      star,
      label: star ? describeStar(star) : (event?.label ?? visitorLabel(visitor)),
      altDeg: at.altRad * RAD,
      azDeg: at.azRad * RAD,
      x: this.widthCss / 2 + at.x,
      y: this.heightCss / 2 - at.y,
      distancePx: at.distancePx,
      encoding,
      // A catalogue position and a feed's measured coordinate are both measurements. Only an
      // event can be regional, and only because a feed said so.
      inferredPlacement: event?.placement === "regional",
    };
  }
}

/**
 * A person, in words, and deliberately without their id in it.
 *
 * The only things a visitor sends are a palette, where they are looking and whether they are in
 * a session. None of those is a name, so there is nothing to print but the fact of them, and a
 * server-assigned id rendered as a label would read as one. A caller that needs the id has the
 * whole `Presence` on the hit.
 */
function visitorLabel(visitor: Presence | null): string {
  if (!visitor) return "";
  return visitor.focused ? "A visitor, in a focus session" : "A visitor";
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function writeDisc(
  into: Float32Array,
  at: number,
  d: {
    a: number;
    b: number;
    from: number;
    to: number;
    startSec: number;
    durSec: number;
    sizeDeg: number;
    soften: number;
    driftPx: number;
    horizontalSpace: boolean;
    colour: RGB;
    seed: number;
  },
): void {
  into[at] = d.a;
  into[at + 1] = d.b;
  into[at + 2] = d.from;
  into[at + 3] = d.to;
  into[at + 4] = d.startSec;
  into[at + 5] = d.durSec;
  into[at + 6] = d.sizeDeg;
  into[at + 7] = d.soften;
  into[at + 8] = d.driftPx;
  into[at + 9] = d.horizontalSpace ? 1 : 0;
  into[at + 10] = d.colour[0];
  into[at + 11] = d.colour[1];
  into[at + 12] = d.colour[2];
  into[at + 13] = d.seed;
}

function parseOr(hex: string, fallback: RGB): RGB {
  return parseColour(hex) ?? fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t);
}

export function sceneOptions(
  partial: Partial<SceneOptions> & { palette: SkyPalette },
): SceneOptions {
  return {
    observer: { latDeg: 51.4769, lonDeg: -0.0005, gazeAzDeg: 180, gazeAltDeg: 90 },
    fovDeg: 180,
    reducedMotion: false,
    showSelf: true,
    resolveAccent: null,
    capacity: DEFAULT_CAPACITY,
    epochMs: Date.now(),
    ...partial,
  };
}

export type { PaletteSource, SkyPalette, Audit, DrawReport, SkyEvent, Presence };
