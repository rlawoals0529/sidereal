/**
 * The sky on a 2D canvas, for a context that cannot give us WebGL2.
 *
 * One frame, no loop, no animation. It exists so that `createSky` never throws and never
 * leaves a blank rectangle: a machine too old for WebGL2 gets the same composition that
 * `prefers-reduced-motion` gets, which is a real still of a real sky rather than a message
 * saying it could not draw one.
 *
 * It is deliberately not a second renderer. It reads the same instance buffers, uses the same
 * projection out of `astro.ts`, and draws the same five things at the same phases of their
 * own lives. What it does not do is animate, and what it gives up is the GPU-side decay
 * curves, which it approximates with globalAlpha. Nobody should be looking at this path if
 * the other one is available.
 *
 * A still sky is mostly empty, and the composition is the horizon ring, the aurora band
 * where the aurora actually is, the quake rings at whatever radii their own ages put them,
 * and the streaks caught at every stage of drawing themselves in. That is a long exposure,
 * which is exactly what a photograph of a meteor shower is.
 */
import {
  ANTIPODE_CUT,
  DEG,
  extinction,
  horizontal,
  localFromEquatorialUnit,
  localVec,
  stereographic,
} from "./astro.ts";
import {
  EARTH_RADIUS_KM,
  METEOR_DRAW_S,
  METEOR_LIFE_S,
  METEOR_MAX_DEG,
  METEOR_MIN_DEG,
  QUAKE_LIFE_S,
  GLARE_R0_PX,
  RAYLEIGH_KM_S,
  SPREAD_R0,
  STAR_CORE,
} from "./constants.ts";
import type { RGB } from "./palette.ts";
import { ARC_STRIDE, DISC_STRIDE, RING_STRIDE, STAR_STRIDE, STREAK_STRIDE, type Scene } from "./scene.ts";
import { catalogue } from "./stars.ts";

function css(c: RGB, a: number): string {
  const to255 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${to255(c[0])},${to255(c[1])},${to255(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** `smoothstep` with the edges the shader's own call uses, so the two taper the same way. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function drawStill(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const v = scene.viewport;
  const f = scene.view;
  const p = scene.palette;
  const w = v.widthCss * v.dpr;
  const h = v.heightCss * v.dpr;
  const cx = w / 2;
  const cy = h / 2;
  const s = scene.viewport.scale;
  const nowSec = (scene.nowEpochMs - scene.epoch) / 1000;
  const exposure = scene.exposure;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css(p.bg, 1);
  ctx.fillRect(0, 0, w, h);
  // The negative reading a light palette gets in the GL path. Same reason: a light sky with
  // light marks on it is not a sky.
  ctx.globalCompositeOperation = p.scheme === "light" ? "multiply" : "lighter";

  const project = (a: number, b: number, alreadyHorizontal = false): { x: number; y: number; k: number; alt: number } | null => {
    const hz = alreadyHorizontal ? { alt: a, az: b } : horizontal({ dec: a, ra: b }, f.lst, f.sinPhi, f.cosPhi);
    if (hz.alt <= 0) return null;
    const vec = localVec(hz);
    const pt = stereographic(vec, f);
    if (!pt) return null;
    const z = vec.x * f.forward.x + vec.y * f.forward.y + vec.z * f.forward.z;
    return { x: cx + pt.x * s, y: cy - pt.y * s, k: 2 / (1 + z), alt: hz.alt };
  };

  // The stars, first, because everything else happens against them.
  //
  // Squares, not discs, and that is the whole reason this path can draw nine thousand of them
  // in a still. A radial gradient per star is about forty microseconds, which is most of a
  // second for the catalogue; a `fillRect` is a memory write. At the size a star is drawn, two
  // pixels for almost all of them, the difference between a square and a disc is not visible,
  // and where it would be, the few hundred that carry a glare skirt, the gradient is worth
  // paying for and is used.
  //
  // The skirt's shape is the same inverse square the shader draws, sampled at five stops.
  // The diffraction arms are NOT drawn here: an angular modulation needs a shader or a path per
  // arm, and this is the fallback for a machine that could not give us a shader at all. The
  // eleven stars that carry arms still carry their halo, so the composition is the same sky
  // with one optical detail missing rather than a different one.
  //
  // Same curves as the GL path, off the same instance buffer, so the two agree by construction.
  {
    const sinLst = Math.sin(f.lst);
    const cosLst = Math.cos(f.lst);
    const stars = catalogue();
    const d = scene.stars.data;
    for (let i = 0; i < stars.length; i++) {
      const vec = localFromEquatorialUnit(stars[i]!.unit, sinLst, cosLst, f.sinPhi, f.cosPhi);
      if (vec.z <= 0) continue;
      const z = vec.x * f.forward.x + vec.y * f.forward.y + vec.z * f.forward.z;
      if (z <= ANTIPODE_CUT) continue;
      const k = 2 / (1 + z);
      const x = cx + k * (vec.x * f.right.x + vec.y * f.right.y + vec.z * f.right.z) * s;
      const y = cy - k * (vec.x * f.up.x + vec.y * f.up.y + vec.z * f.up.z) * s;
      if (x < -8 || y < -8 || x > w + 8 || y > h + 8) continue;
      const o = i * STAR_STRIDE;
      const core = d[o + 2]!;
      const quad = d[o + 4]!;
      const glare = d[o + 5]! + d[o + 6]!;
      const sky = extinction(Math.asin(vec.z));
      const alpha = d[o + 3]! * sky;
      if (alpha <= 0.004 && glare <= 0) continue;
      const colour: RGB = [d[o + 7]!, d[o + 8]!, d[o + 9]!];
      if (glare > 0) {
        const radius = quad / 2;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
        for (const stop of [0, 0.15, 0.3, 0.6, 1]) {
          const rPx = Math.max(stop * radius, 0.35);
          const skirt = glare * ((GLARE_R0_PX * GLARE_R0_PX) / (rPx * rPx)) * smoothstep(1, 0.8, stop);
          grad.addColorStop(stop, css(colour, sky * (alpha * Math.exp(-STAR_CORE * (rPx * rPx) / ((core / 2) ** 2)) + skirt)));
        }
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = css(colour, alpha);
        ctx.fillRect(x - core / 2, y - core / 2, core, core);
      }
    }
  }

  // Horizon.
  ctx.lineWidth = 1.1 * v.dpr;
  const hor = scene.horizon;
  ctx.beginPath();
  let open = false;
  for (const slot of hor.liveSlots()) {
    // One side of the ribbon only. This path draws a stroked line rather than a two triangle
    // strip, so the second vertex of each pair is the same point.
    if (slot % 2 !== 0) continue;
    const o = slot * ARC_STRIDE;
    // The horizon sits at altitude exactly zero and `project` culls anything at or below it,
    // which is right for a light and wrong for the boundary itself. A millionth of a degree
    // above lifts it over the cull without moving it anywhere a pixel can tell.
    const pt = project(hor.data[o]! + 1e-6, hor.data[o + 1]!, true);
    if (!pt) {
      open = false;
      continue;
    }
    if (open) ctx.lineTo(pt.x, pt.y);
    else ctx.moveTo(pt.x, pt.y);
    open = true;
  }
  ctx.strokeStyle = css(p.chrome, 0.45);
  ctx.stroke();

  // Quake rings, each at the radius its own age has carried it to.
  ctx.lineWidth = 1.4 * v.dpr;
  for (const slot of scene.quakes.liveSlots()) {
    const o = slot * RING_STRIDE;
    const d = scene.quakes.data;
    const pt = project(d[o]!, d[o + 1]!);
    if (!pt) continue;
    const age = nowSec - d[o + 2]!;
    const rRad = (RAYLEIGH_KM_S * age) / EARTH_RADIUS_KM;
    const spread = Math.sqrt(SPREAD_R0 / Math.max(Math.sin(rRad), SPREAD_R0));
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rRad * pt.k * s, 0, Math.PI * 2);
    ctx.strokeStyle = css(p.quake, (0.25 + 0.75 * d[o + 3]!) * spread * (1 - age / (QUAKE_LIFE_S * exposure)));
    ctx.stroke();
  }

  // Discs.
  for (const slot of scene.discs.liveSlots()) {
    const o = slot * DISC_STRIDE;
    const d = scene.discs.data;
    const pt = project(d[o]!, d[o + 1]!, d[o + 9]! > 0.5);
    if (!pt) continue;
    // The interpolated value, not the target. Reading `fadeTo` here drew the aurora at the
    // brightness it was heading for rather than the one it is at, which came out five times
    // too bright and, worse, made the GL path look correct when it was only being compared
    // against a frame that had not finished fading in.
    const fadeT = Math.max(0, Math.min(1, (nowSec - d[o + 4]!) / Math.max(d[o + 5]!, 0.001)));
    const alpha = d[o + 2]! + (d[o + 3]! - d[o + 2]!) * fadeT;
    if (alpha <= 0.002) continue;
    const radius = Math.max(1.2, (d[o + 6]! * DEG * pt.k * s) / 2);
    const colour: RGB = [d[o + 10]!, d[o + 11]!, d[o + 12]!];
    // Four stops approximating the shader's exp(-sharp * d * d), so the two paths put the
    // same amount of light on the page. A linear ramp puts noticeably more.
    const sharp = 9 - 7 * d[o + 7]!;
    const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radius);
    for (const stop of [0, 0.25, 0.5, 0.75, 1]) {
      grad.addColorStop(stop, css(colour, alpha * Math.exp(-sharp * stop * stop)));
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // The ISS track.
  ctx.lineWidth = 1.6 * v.dpr;
  ctx.beginPath();
  open = false;
  for (const slot of scene.track.liveSlots()) {
    if (slot % 2 !== 0) continue;
    const o = slot * ARC_STRIDE;
    const pt = project(scene.track.data[o]!, scene.track.data[o + 1]!);
    if (!pt) {
      open = false;
      continue;
    }
    if (open) ctx.lineTo(pt.x, pt.y);
    else ctx.moveTo(pt.x, pt.y);
    open = true;
  }
  ctx.strokeStyle = css(p.orbit, 0.55);
  ctx.stroke();

  // Streaks, each caught wherever its own age has it.
  for (const slot of scene.meteors.liveSlots()) {
    const o = slot * STREAK_STRIDE;
    const d = scene.meteors.data;
    const pt = project(d[o]!, d[o + 1]!);
    if (!pt) continue;
    const age = nowSec - d[o + 2]!;
    const mag = d[o + 3]!;
    const drawn = Math.min(1, age / (METEOR_DRAW_S * exposure));
    const len = (METEOR_MIN_DEG + (METEOR_MAX_DEG - METEOR_MIN_DEG) * mag) * DEG * pt.k * s * drawn * (3 - 2 * drawn) * drawn;
    // Direction as a finite difference, exactly as the shader does it.
    const next = project(d[o]!, d[o + 1]! - 1e-4);
    const dx = next ? next.x - pt.x : 1;
    const dy = next ? next.y - pt.y : 0;
    const dl = Math.hypot(dx, dy) || 1;
    const alpha = (0.2 + 0.8 * mag) * (1 - age / (METEOR_LIFE_S * exposure)) ** 1.8;
    const grad = ctx.createLinearGradient(pt.x, pt.y, pt.x + (dx / dl) * len, pt.y + (dy / dl) * len);
    grad.addColorStop(0, css(p.meteor, 0));
    grad.addColorStop(1, css(mag > 0.6 ? p.meteorHot : p.meteor, alpha));
    ctx.strokeStyle = grad;
    ctx.lineWidth = (0.9 + 0.8 * mag) * v.dpr;
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    ctx.lineTo(pt.x + (dx / dl) * len, pt.y + (dy / dl) * len);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "source-over";
}
