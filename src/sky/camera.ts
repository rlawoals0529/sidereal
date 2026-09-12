/**
 * Where the observer is looking, and how a drag, a wheel and a key change it.
 *
 * Everything in this file is arithmetic over numbers, with no DOM in it, because the parts of
 * a camera that are actually wrong are the parts with answers: whether a fling decays to a
 * stop, whether the field of view stays inside its limits, whether dragging to the zenith and
 * carrying on flips the sky over. `controls.ts` is the part that listens to events, and it has
 * no arithmetic of its own worth testing.
 *
 * **The camera does not fight the sky's rotation, by construction rather than by tuning.** The
 * gaze is an azimuth and an altitude in the OBSERVER's horizontal frame, which is the frame of
 * somebody standing in a field; the stars are fixed to the celestial sphere and that sphere
 * turns underneath. Those are two different frames and the only thing that reads both is the
 * projection. So looking somewhere and staying there is exactly what a person does, and the sky
 * drifting through the view while you hold still is exactly what a sky does. There is no
 * counter-rotation term here because there is nothing to counter: at fifteen arcseconds a second
 * the sidereal rate would be a two hundredth of a pixel a frame in any case.
 *
 * **Momentum is a rate, not a queue of positions.** A release hands over the average angular
 * velocity of the last few tens of milliseconds and the view carries on at that rate, decaying
 * exponentially. The alternative, replaying the tail of the drag, is what produces a flick that
 * repeats the last jitter of a finger coming off the glass.
 */
import { DEG, rotateGaze } from "./astro.ts";
import { FOV_MAX_DEG, FOV_MIN_DEG } from "./constants.ts";

export type CameraState = {
  azDeg: number;
  altDeg: number;
  fovDeg: number;
};

/**
 * How far below the horizon the gaze can be pointed.
 *
 * Not zero, because the horizon ring is a boundary and a boundary you can never put in the
 * middle of the frame is hard to read as one. Not much more than this either: this renderer
 * draws nothing below the horizon on purpose, so further down is an empty screen, and an
 * interaction that lets you arrive somewhere with nothing in it is a bug however defensible
 * the arithmetic.
 */
export const MIN_ALT_DEG = -20;
/** Straight up. The default, and the top of the range: you cannot look further up than up. */
export const MAX_ALT_DEG = 90;

/**
 * How long a fling takes to lose its speed, seconds, as an exponential time constant.
 *
 * A third of a second: fast enough that letting go feels like letting go rather than like
 * handing over to an animation, slow enough that a flick across the sky reads as one movement.
 * After three time constants the view has travelled 95 per cent of the distance it was ever
 * going to, so the glide is effectively over in a second.
 */
export const GLIDE_TAU_S = 0.32;
/** Below this the glide is finished. A twentieth of a degree a second is less than a pixel a minute. */
const GLIDE_STOP_RAD_S = 0.001;

/**
 * The window a release reads its speed from, milliseconds.
 *
 * Long enough to average out the jitter of a finger or a trackpad, short enough that it is the
 * speed you were moving at when you let go rather than the speed you were moving at earlier.
 * A drag that stopped moving for longer than this before the release hands over nothing, which
 * is the behaviour you want: putting a finger down, moving, stopping, and lifting means you
 * placed the view somewhere deliberately and it should stay there.
 */
export const FLING_WINDOW_MS = 90;

/** Degrees a second the keyboard turns the view at a 180 degree field, while a key is held. */
export const KEY_LOOK_DEG_S = 55;
/** Degrees the keyboard turns the view per press at a 180 degree field, when motion is reduced. */
export const KEY_STEP_DEG = 7;
/** How fast held zoom keys change the field of view, in e-foldings per second. */
export const KEY_ZOOM_RATE = 1.1;
/** How much one press changes the field of view when motion is reduced, as a ratio. */
export const KEY_ZOOM_STEP = 1.18;

/**
 * Wheel travel to zoom, in e-foldings of field of view per pixel of deltaY.
 *
 * A notch of a mouse wheel is about 100 pixels of deltaY and a trackpad scroll is a few pixels
 * per frame, so this is set from the mouse end: one notch moves the field of view by about 12
 * per cent, and the full range from 210 degrees to 20 is twenty notches. A trackpad covers the
 * same range in one unhurried gesture because it delivers far more, smaller, events.
 */
export const WHEEL_ZOOM_PER_PX = 0.00115;

/**
 * The pinch multiplier, on top of the wheel's.
 *
 * A pinch on a trackpad arrives as a wheel event with `ctrlKey` set and a much smaller deltaY
 * than a scroll of the same physical size, which is a convention rather than a standard and is
 * the only reason this number exists. Without it a pinch moves the view about a twentieth as
 * far as the fingers did and reads as broken.
 */
export const PINCH_MULTIPLIER = 18;

type Sample = { atMs: number; right: number; up: number };

export class Camera {
  private azDeg: number;
  private altDeg: number;
  private fovDeg: number;
  private readonly home: CameraState;

  /** Angular rate in the screen's own basis, radians a second. Zero unless a fling is running. */
  private velRight = 0;
  private velUp = 0;
  private dragging = false;
  private samples: Sample[] = [];

  /** -1, 0 or 1 per axis, from whichever keys are currently held. */
  private keyRight = 0;
  private keyUp = 0;
  private keyZoom = 0;

  private reduced: boolean;

  constructor(initial: CameraState, reducedMotion = false) {
    this.azDeg = initial.azDeg;
    this.altDeg = clampAlt(initial.altDeg);
    this.fovDeg = clampFov(initial.fovDeg);
    this.home = { azDeg: this.azDeg, altDeg: this.altDeg, fovDeg: this.fovDeg };
    this.reduced = reducedMotion;
  }

  get state(): CameraState {
    return { azDeg: this.azDeg, altDeg: this.altDeg, fovDeg: this.fovDeg };
  }

  /** True while a fling or a held key still has work to do, so a caller knows to keep drawing. */
  get moving(): boolean {
    return this.velRight !== 0 || this.velUp !== 0 || this.keyRight !== 0 || this.keyUp !== 0 || this.keyZoom !== 0;
  }

  /**
   * Adopt a gaze that came from somewhere other than this camera.
   *
   * `Sky.look` and `Sky.setObserver` are part of the public surface and a page is allowed to
   * call them. Without this the camera would keep its own idea of where the view is pointing
   * and the next drag would snap back to it.
   */
  adopt(state: Partial<CameraState>): void {
    if (state.azDeg !== undefined) this.azDeg = state.azDeg;
    if (state.altDeg !== undefined) this.altDeg = clampAlt(state.altDeg);
    if (state.fovDeg !== undefined) this.fovDeg = clampFov(state.fovDeg);
    this.stop();
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
    if (on) this.stop();
  }

  /** Cancel a glide and forget every held key. Also what a window losing focus has to do. */
  stop(): void {
    this.velRight = 0;
    this.velUp = 0;
    this.keyRight = 0;
    this.keyUp = 0;
    this.keyZoom = 0;
    this.samples = [];
  }

  // ---------------------------------------------------------------- pointer

  beginDrag(): void {
    this.dragging = true;
    this.velRight = 0;
    this.velUp = 0;
    this.samples = [];
  }

  /**
   * Move the view by a pointer delta in CSS pixels.
   *
   * `radPerPx` comes from the scene's own scale rather than a sensitivity constant, which is
   * what makes this direct manipulation instead of a rate control: the piece of sky under the
   * pointer when the drag started is still under it when the drag ends, at any field of view
   * and any canvas size. The projection is conformal, so the ratio is exact at the centre of
   * the frame and tightens slightly toward the edge; nothing about a hand on a trackpad can
   * tell the difference.
   *
   * The signs are grab-and-pull, like a map and unlike a first-person camera. Dragging right
   * moves the SKY right, which means the gaze turns left.
   */
  dragBy(dxCss: number, dyCss: number, radPerPx: number, atMs: number): void {
    const right = -dxCss * radPerPx;
    const up = dyCss * radPerPx;
    this.turn(right, up);
    this.samples.push({ atMs, right, up });
    // Everything older than the fling window is dead weight; trimming here rather than at the
    // release keeps the array at a handful of entries however long the drag lasts.
    const cut = atMs - FLING_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0]!.atMs < cut) this.samples.shift();
  }

  /**
   * Let go, and hand the glide whatever speed the last few tens of milliseconds were carrying.
   *
   * With motion reduced there is no glide. Dragging still works, and has to: a motion
   * preference is a statement about animation, not a request to have the controls taken away.
   * What it removes is the part that keeps moving after the hand has stopped.
   */
  endDrag(atMs: number): void {
    this.dragging = false;
    if (this.reduced) {
      this.samples = [];
      return;
    }
    const cut = atMs - FLING_WINDOW_MS;
    const recent = this.samples.filter((s) => s.atMs >= cut);
    this.samples = [];
    if (recent.length === 0) return;
    const span = (atMs - recent[0]!.atMs) / 1000;
    // A pause before the release, or a single event with no elapsed time to divide by. Either
    // way there is no measured speed, and inventing one is how a deliberate placement ends up
    // drifting away from where it was put.
    if (span <= 0.001) return;
    this.velRight = recent.reduce((a, s) => a + s.right, 0) / span;
    this.velUp = recent.reduce((a, s) => a + s.up, 0) / span;
  }

  // ---------------------------------------------------------------- zoom

  /** Multiply the field of view. Below 1 is a closer look, above 1 is a wider sky. */
  zoomBy(factor: number): void {
    this.fovDeg = clampFov(this.fovDeg * factor);
  }

  /** A wheel or a pinch, in the units a `wheel` event reports. */
  wheel(deltaYPx: number, pinch: boolean): void {
    const gain = WHEEL_ZOOM_PER_PX * (pinch ? PINCH_MULTIPLIER : 1);
    this.zoomBy(Math.exp(deltaYPx * gain));
  }

  // ---------------------------------------------------------------- keyboard

  /** -1, 0 or 1 per axis, recomputed by the caller from whichever keys are down. */
  hold(right: number, up: number, zoom: number): void {
    this.keyRight = right;
    this.keyUp = up;
    this.keyZoom = zoom;
  }

  /**
   * One discrete press, for when there is no frame loop to hold a key against.
   *
   * This is the reduced-motion path and the whole reason it exists: with motion off the sky
   * draws on demand rather than sixty times a second, so a held key has nothing to integrate
   * against. A press becomes a step instead, the view arrives there immediately, and the
   * keyboard stays exactly as capable as the pointer.
   */
  nudge(right: number, up: number): void {
    const step = KEY_STEP_DEG * DEG * this.zoomScale();
    this.turn(right * step, up * step);
  }

  /** One discrete zoom press, same reasoning as `nudge`. */
  nudgeZoom(direction: number): void {
    if (direction === 0) return;
    this.zoomBy(direction > 0 ? 1 / KEY_ZOOM_STEP : KEY_ZOOM_STEP);
  }

  /** Back to the view the sky opened on: straight up, facing south, whole hemisphere. */
  reset(): void {
    this.stop();
    this.azDeg = this.home.azDeg;
    this.altDeg = this.home.altDeg;
    this.fovDeg = this.home.fovDeg;
  }

  // ---------------------------------------------------------------- per frame

  /**
   * Advance held keys and the glide by one frame. True when anything moved.
   *
   * A held key sets a rate rather than adding a step per event, so the view turns at the same
   * speed on a 60 Hz display and a 120 Hz one, and a dropped frame moves it further rather
   * than slower. It also cancels the glide: pressing a direction is a statement about where
   * you want to be looking, and having it fight a fling that is still running is the kind of
   * thing that reads as the page being broken.
   */
  step(dtSec: number): boolean {
    if (dtSec <= 0) return false;
    let moved = false;

    if (this.keyZoom !== 0) {
      this.zoomBy(Math.exp(-this.keyZoom * KEY_ZOOM_RATE * dtSec));
      moved = true;
    }

    if (this.keyRight !== 0 || this.keyUp !== 0) {
      this.velRight = 0;
      this.velUp = 0;
      const rate = KEY_LOOK_DEG_S * DEG * this.zoomScale() * dtSec;
      this.turn(this.keyRight * rate, this.keyUp * rate);
      return true;
    }

    if (this.dragging) return moved;

    const speed = Math.hypot(this.velRight, this.velUp);
    if (speed > GLIDE_STOP_RAD_S) {
      this.turn(this.velRight * dtSec, this.velUp * dtSec);
      const decay = Math.exp(-dtSec / GLIDE_TAU_S);
      this.velRight *= decay;
      this.velUp *= decay;
      moved = true;
    } else if (speed > 0) {
      this.velRight = 0;
      this.velUp = 0;
    }

    return moved;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Turn by an angle measured in the plane of the screen, with the altitude limits applied to
   * the REQUEST rather than to the result.
   *
   * Clamping afterwards is the version that looks right and is wrong. Rotating past the zenith
   * produces an altitude on the way back down and an azimuth 180 degrees round, so a clamp on
   * the altitude alone leaves the view facing the opposite way with no sign that anything
   * happened. Moving along the screen's up vector changes altitude by exactly that angle, so
   * limiting the angle first is both simpler and the thing that actually holds.
   */
  private turn(dRightRad: number, dUpRad: number): void {
    const alt = this.altDeg * DEG;
    const up = Math.max(MIN_ALT_DEG * DEG - alt, Math.min(MAX_ALT_DEG * DEG - alt, dUpRad));
    if (dRightRad === 0 && up === 0) return;
    const next = rotateGaze(this.azDeg, this.altDeg, dRightRad, up);
    this.azDeg = next.azDeg;
    this.altDeg = clampAlt(next.altDeg);
  }

  /**
   * Keyboard speed, scaled by how far in the view is zoomed.
   *
   * Without this the arrow keys sweep the whole sky in three seconds at a 20 degree field,
   * which makes the close look useless: the thing you zoomed in to see leaves the frame on the
   * first tap. Turning a fixed fraction of the visible field per second is what every map does
   * and is the only scaling that feels the same at both ends.
   */
  private zoomScale(): number {
    return this.fovDeg / 180;
  }
}

function clampAlt(deg: number): number {
  return deg < MIN_ALT_DEG ? MIN_ALT_DEG : deg > MAX_ALT_DEG ? MAX_ALT_DEG : deg;
}

function clampFov(deg: number): number {
  return deg < FOV_MIN_DEG ? FOV_MIN_DEG : deg > FOV_MAX_DEG ? FOV_MAX_DEG : deg;
}

/**
 * Radians of sky per CSS pixel at the centre of the frame.
 *
 * The one number that makes a drag track the sky rather than approximate it, and it is derived
 * rather than chosen. The stereographic plane radius of an angle theta is `2 tan(theta/2)`,
 * whose derivative at zero is exactly 1, so one radian of sky at the centre of gaze is `scale`
 * device pixels, and dividing by the device pixel ratio puts it in the units a pointer event
 * speaks. Wrong by a few per cent at the edge of a 180 degree frame, which is the projection
 * being a projection, and invisible to a hand.
 */
export function radiansPerCssPixel(scale: number, dpr: number): number {
  return dpr / Math.max(scale, 1e-6);
}
