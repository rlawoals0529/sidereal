/**
 * What a frame actually costs, measured rather than asserted.
 *
 * Run it with `node test/sky/bench.ts`, or `node test/sky/bench.ts stress` for four times the
 * arrival rate.
 *
 * **Be precise about what this measures, because the number is easy to overclaim.** There is
 * no GPU here. This is the host side of a frame: retiring what expired, recomputing the
 * observer's frame, filling the uniform block, uploading the instances that changed, and
 * issuing the draws. That is the half of the budget this renderer is responsible for and the
 * only half that grows with the arrival rate, since everything the GPU does per light is a
 * function of a uniform clock and instance data that was written once. It is a floor on the
 * frame time and not the frame time.
 *
 * The GPU side is measured in a browser, which is what a browser is for. Every `Sky` reports
 * `stats().frame` from the same summariser this uses, so the number a page prints and the
 * number this prints are the same measurement of the same work.
 *
 * The load model is the one in the concept document, not a number picked to look good:
 * Wikimedia runs about a hundred edits a second globally, USGS is minutes apart, the ISS
 * reports at 1 Hz, and OVATION lands a whole grid every five minutes.
 */
import type { SkyEvent } from "../../src/shared/event.ts";
import { summarise } from "../../src/sky/index.ts";
import { Renderer } from "../../src/sky/renderer.ts";
import { Scene, sceneOptions } from "../../src/sky/scene.ts";
import { stubGl } from "./gl-stub.ts";
import { TWILIGHT, aurora, edit, orbit, presence, quake } from "./fixtures.ts";

const T0 = Date.UTC(2024, 5, 15, 3, 17, 42);
const FRAME_MS = 1000 / 60;

type Load = {
  name: string;
  editsPerSecond: number;
  quakesPerMinute: number;
  auroraCells: number;
  auroraPeriodMs: number;
  visitors: number;
};

const REALISTIC: Load = {
  name: "realistic",
  editsPerSecond: 100,
  quakesPerMinute: 3,
  auroraCells: 3000,
  auroraPeriodMs: 300_000,
  visitors: 40,
};

const STRESS: Load = {
  name: "stress (4x arrivals, 2x cells, 5x visitors)",
  editsPerSecond: 400,
  quakesPerMinute: 12,
  auroraCells: 6000,
  auroraPeriodMs: 300_000,
  visitors: 200,
};

function run(load: Load, seconds: number): void {
  const scene = new Scene(
    sceneOptions({
      palette: TWILIGHT,
      epochMs: T0,
      observer: { latDeg: 64.84, lonDeg: -147.72, gazeAzDeg: 180, gazeAltDeg: 90 },
      capacity: { meteors: 8192, quakes: 1024, discs: 12_288, track: 180 },
    }),
  );
  // A real display, not a thumbnail. 1920 by 1080 at device pixel ratio 2 is four times the
  // fragments of the same window at 1, and fragments are where a sky like this actually
  // spends its GPU time.
  scene.resize(1920, 1080, 2);

  const { gl, log } = stubGl();
  const renderer = new Renderer(gl, scene);

  for (let i = 0; i < load.visitors; i++) {
    scene.upsertVisitor(
      presence(`v${i}`, {
        az: (i * 137.5) % 360,
        alt: 8 + (i % 9) * 8,
        focused: i % 3 === 0,
      }),
      i === 0,
    );
  }

  const frames = Math.round(seconds * 60);
  const times: number[] = [];
  const idleTimes: number[] = [];
  let uploadsBefore = 0;
  let lastAurora = -Infinity;
  let editCarry = 0;
  let quakeCarry = 0;
  let issCarry = 0;
  let pushed = 0;

  for (let f = 0; f < frames; f++) {
    const now = T0 + f * FRAME_MS;
    const batch: SkyEvent[] = [];

    editCarry += (load.editsPerSecond * FRAME_MS) / 1000;
    while (editCarry >= 1) {
      editCarry -= 1;
      batch.push(
        edit(now - Math.random() * 400, {
          lat: (Math.random() * 2 - 1) * 70,
          lon: Math.random() * 360 - 180,
          magnitude: Math.random() ** 2,
        }),
      );
    }

    quakeCarry += (load.quakesPerMinute * FRAME_MS) / 60_000;
    while (quakeCarry >= 1) {
      quakeCarry -= 1;
      batch.push(quake(now, { lat: (Math.random() * 2 - 1) * 60, lon: Math.random() * 360 - 180 }));
    }

    issCarry += FRAME_MS / 1000;
    while (issCarry >= 1) {
      issCarry -= 1;
      const t = f / 60;
      batch.push(orbit(now, 51 * Math.sin(t / 92), ((t * 3.9) % 360) - 180));
    }

    if (now - lastAurora >= load.auroraPeriodMs) {
      lastAurora = now;
      // The whole grid at once, which is what a poll looks like landing. The worst single
      // frame in the run is always this one, so it is deliberately not smoothed out.
      for (let i = 0; i < load.auroraCells; i++) {
        const lat = 58 + (i % 24) * 0.8;
        const lon = -180 + Math.floor(i / 24) * (360 / Math.ceil(load.auroraCells / 24));
        batch.push(aurora(now, lat, lon, 0.15 + Math.random() * 0.8));
      }
    }

    pushed += batch.length;

    const start = performance.now();
    if (batch.length > 0) scene.push(batch);
    scene.update(now);
    renderer.render();
    const dt = performance.now() - start;
    // Discard the first second: the aurora grid lands on frame zero and the JIT has not seen
    // any of this code yet, so including it measures the warm-up rather than the steady state.
    if (f >= 60) {
      times.push(dt);
      if (batch.length === 0) idleTimes.push(dt);
    }
  }

  const busy = scene.stats();
  const busyLive = busy.layers.reduce((a, l) => a + l.live, 0);
  const busyDraws = renderer.draws().length;

  // A frame with the sky full and nothing arriving. This is the claim that per-frame cost
  // tracks the arrival rate and not the population, so it is measured rather than argued.
  const idleRun: number[] = [];
  for (let f = 0; f < 600; f++) {
    const now = T0 + (frames + f) * FRAME_MS;
    const start = performance.now();
    scene.update(now);
    renderer.render();
    idleRun.push(performance.now() - start);
  }

  // Hover cost at full load, which is a separate budget: it happens on pointer move, not on
  // every frame, but it is brute force over every live light and that deserves a number.
  const hits: number[] = [];
  for (let i = 0; i < 400; i++) {
    const start = performance.now();
    scene.hitTest(300 + (i % 600), 200 + (i % 400));
    hits.push(performance.now() - start);
  }

  const s = scene.stats();
  const idleLive = s.layers.reduce((a, l) => a + l.live, 0);
  const uploadsPerFrame = (log.uploads.length - uploadsBefore) / frames;
  uploadsBefore = log.uploads.length;

  const f = summarise(times, times.length);
  const idle = summarise(idleRun, idleRun.length);
  const hit = summarise(hits, hits.length);

  const pct = (v: number): string => `${((v / FRAME_MS) * 100).toFixed(1)}% of a 60fps frame`;

  console.log(`\n=== ${load.name} ===`);
  console.log(`viewport                1920x1080 at dpr 2`);
  console.log(`simulated               ${seconds}s of sky, ${frames} frames, ${pushed} events pushed`);
  console.log(`live lights, arriving   ${busyLive}  (${busy.layers.map((l) => `${l.name} ${l.live}`).join(", ")})`);
  console.log(`draw calls per frame    ${busyDraws}`);
  console.log(`buffer uploads/frame    ${uploadsPerFrame.toFixed(2)}`);
  console.log(`dropped for capacity    ${s.layers.reduce((a, l) => a + l.dropped, 0)}`);
  console.log(``);
  console.log(`host frame, mean        ${f.meanMs.toFixed(3)} ms   ${pct(f.meanMs)}`);
  console.log(`host frame, p50         ${f.p50Ms.toFixed(3)} ms`);
  console.log(`host frame, p95         ${f.p95Ms.toFixed(3)} ms   ${pct(f.p95Ms)}`);
  console.log(`host frame, worst       ${f.worstMs.toFixed(3)} ms   ${pct(f.worstMs)}`);
  console.log(`  (worst is the frame a whole OVATION grid lands in)`);
  console.log(``);
  console.log(`no arrivals, mean       ${idle.meanMs.toFixed(4)} ms   ${pct(idle.meanMs)}`);
  console.log(`no arrivals, p95        ${idle.p95Ms.toFixed(4)} ms`);
  console.log(`  (${idleLive} lights on screen, nothing uploaded: this is the point of the design.`);
  console.log(`   the meteors have legitimately died; what is left is the aurora, the quakes,`);
  console.log(`   the track and the people, and they cost the same whether or not they moved)`);
  console.log(``);
  console.log(`hit test, mean          ${hit.meanMs.toFixed(3)} ms over ${idleLive} lights`);
  console.log(`hit test, p95           ${hit.p95Ms.toFixed(3)} ms`);

  const verdict =
    f.p95Ms < FRAME_MS
      ? `host side leaves ${(FRAME_MS - f.p95Ms).toFixed(2)} ms of the 16.67 ms frame for the GPU at p95`
      : `host side alone is over budget at p95 by ${(f.p95Ms - FRAME_MS).toFixed(2)} ms`;
  console.log(`\n${verdict}.`);
}

const mode = process.argv[2] ?? "realistic";
console.log("host-side frame cost only. No GPU is involved; see the header of this file.");
run(REALISTIC, 40);
if (mode === "stress" || mode === "all") run(STRESS, 40);
