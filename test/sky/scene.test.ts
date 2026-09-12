/**
 * What goes into the sky, what stays, and what the panel is told when you point at it.
 *
 * The projection has its own file of tests. This one is about the behaviour built on top of
 * it: that a replayed batch does not double render, that an aurora cell moves its own light
 * rather than adding a second, that a focused visitor is legibly different from an idle one,
 * and that pointing at something hands back the record the feed actually sent rather than a
 * description of it.
 */
import { describe, expect, it } from "vitest";
import { DEG } from "../../src/sky/astro.ts";
import { METEOR_LIFE_S, QUAKE_LIFE_S, STILL_EXPOSURE } from "../../src/sky/constants.ts";
import {
  DISC_STRIDE,
  Scene,
  auroraCellKey,
  sceneOptions,
  type SceneOptions,
} from "../../src/sky/scene.ts";
import type { SkyPalette } from "../../src/sky/palette.ts";
import { TWILIGHT, paletteFromCss, aurora, edit, orbit, presence, quake } from "./fixtures.ts";

const T = Date.UTC(2024, 5, 15, 3, 17, 42);
/** The observer, and therefore the point of sky at the dead centre of the frame. */
const HERE = { latDeg: 51.4769, lonDeg: -0.0005, gazeAzDeg: 180, gazeAltDeg: 90 };
const OVERHEAD = { lat: HERE.latDeg, lon: HERE.lonDeg };

type Over = { palette?: SkyPalette; reducedMotion?: boolean; capacity?: SceneOptions["capacity"] };

function sky(over: Over = {}) {
  const { palette = TWILIGHT, ...rest } = over;
  const scene = new Scene(sceneOptions({ observer: HERE, epochMs: T, palette, ...rest }));
  scene.resize(900, 900, 1);
  scene.update(T);
  return scene;
}

const live = (s: Scene, which: "meteors" | "quakes" | "discs"): number => [...s[which].liveSlots()].length;

describe("ingestion", () => {
  it("puts one light up per edit", () => {
    const s = sky();
    s.push([edit(T), edit(T), edit(T)]);
    expect(live(s, "meteors")).toBe(3);
  });

  it("does not double render a replayed batch", () => {
    // The reason SkyEvent carries a stable id at all. A reconnect that resends the last tick
    // must not double the sky.
    const s = sky();
    const batch = [edit(T), quake(T)];
    s.push(batch);
    s.push(batch);
    s.push([...batch]);
    expect(live(s, "meteors")).toBe(1);
    expect(live(s, "quakes")).toBe(1);
  });

  it("retires a meteor when its life is up, and forgets its record with it", () => {
    const s = sky();
    s.push([edit(T)]);
    s.update(T + METEOR_LIFE_S * 1000 - 50);
    expect(live(s, "meteors")).toBe(1);
    s.update(T + METEOR_LIFE_S * 1000 + 50);
    expect(live(s, "meteors")).toBe(0);
    expect(s.ledger.size).toBe(0);
  });

  it("keeps a quake for six minutes, which is a hundred and sixty times longer", () => {
    const s = sky();
    s.push([quake(T)]);
    s.update(T + 60_000);
    expect(live(s, "quakes")).toBe(1);
    s.update(T + QUAKE_LIFE_S * 1000 + 1000);
    expect(live(s, "quakes")).toBe(0);
  });

  it("frees a slot late rather than early when a batch arrives out of time order", () => {
    // The retire scan stops at the first live slot, which is what keeps it proportional to
    // what expired rather than to what is on the sky. Newest-first therefore pins the queue
    // until the newest ages out. Pinned here because it is a deliberate trade and somebody
    // will otherwise read it as a leak.
    const s = sky();
    s.push(Array.from({ length: 50 }, (_, i) => edit(T - i * 200)));
    // The oldest is nine seconds past its life and the newest still has a second left, so
    // every one of them is held.
    s.update(T + 1000);
    expect(live(s, "meteors")).toBe(50);
    // Nothing wrong is on screen: the shader discards a stalled slot, and it frees itself.
    s.update(T + METEOR_LIFE_S * 1000 + 100);
    expect(live(s, "meteors")).toBe(0);
  });

  it("counts what it had to drop rather than losing it quietly", () => {
    const s = sky({ capacity: { meteors: 8, quakes: 8, discs: 8, track: 8 } });
    s.push(Array.from({ length: 20 }, (_, i) => edit(T - i)));
    expect(live(s, "meteors")).toBe(8);
    // A non-zero drop count is the only way anyone would ever find out that capacity is
    // below the arrival rate, because the symptom is a sky that just feels thin.
    expect(s.meteors.stats().dropped).toBe(12);
  });
});

describe("the aurora", () => {
  it("moves a cell's own light rather than adding a second one beside it", () => {
    // OVATION reports the same grid cell every five minutes. Whether its normalizer gives
    // that a stable id is its business, so the cell is keyed by where it is.
    const s = sky();
    s.push([aurora(T, 66.5, -147.2, 0.3)]);
    s.push([aurora(T + 300_000, 66.5, -147.2, 0.8)]);
    expect(live(s, "discs")).toBe(1);
    expect(auroraCellKey(aurora(T, 66.5, -147.2, 0.3))).toBe(auroraCellKey(aurora(T + 1, 66.5, -147.2, 0.9)));
  });

  it("crosses from the probability it was showing to the new one, not from zero", () => {
    const s = sky();
    s.push([aurora(T, 66.5, -147.2, 0.9)]);
    // Long enough that the first crossfade has finished, so the cell is sitting at its value.
    s.update(T + 120_000);
    const settled = s.discs.data[0 * DISC_STRIDE + 3]!;
    s.push([aurora(T + 120_000, 66.5, -147.2, 0.1)]);
    const from = s.discs.data[0 * DISC_STRIDE + 2]!;
    expect(from).toBeCloseTo(settled, 5);
    expect(s.discs.data[0 * DISC_STRIDE + 3]!).toBeLessThan(from);
  });

  it("is brighter where the measured probability is higher, and nowhere else", () => {
    // Both values sit in the range OVATION actually publishes on an ordinary night, so this
    // measures the curve rather than the saturation at the top of it. Picking 0.95 here, as
    // this once did, tested the clamp by accident and said nothing about a real sky.
    const s = sky();
    s.push([aurora(T, 66, -140, 0.04), aurora(T, 66, -139, 0.16)]);
    const alphaAt = (slot: number): number => s.discs.data[slot * DISC_STRIDE + 3]!;
    expect(alphaAt(1)).toBeGreaterThan(alphaAt(0) * 3);
  });

  it("saturates rather than overflowing when a real storm arrives", () => {
    // A storm reading is far above the reference the display is scaled to. It must pin to full
    // strength instead of running past it, and it must still be plainly brighter than a quiet
    // cell next to it.
    const s = sky();
    s.push([aurora(T, 66, -140, 0.05), aurora(T, 66, -139, 0.9)]);
    const alphaAt = (slot: number): number => s.discs.data[slot * DISC_STRIDE + 3]!;
    expect(alphaAt(1)).toBeLessThanOrEqual(0.1 + 1e-6);
    expect(alphaAt(1)).toBeGreaterThan(alphaAt(0) * 4);
  });

  it("gives an ordinary night enough brightness to be seen at all", () => {
    // The failure this replaced: probability was mapped straight onto alpha, so a four per
    // cent cell drew at 0.00057 and the band was invisible on a perfectly working sky. The
    // number below is not a target for how it should look, it is a floor under "visible".
    const s = sky();
    s.push([aurora(T, 66, -140, 0.04)]);
    expect(s.discs.data[3]!).toBeGreaterThan(0.002);
  });
});

describe("the ISS", () => {
  it("is one light and one track, however many fixes arrive", () => {
    const s = sky();
    for (let i = 0; i < 300; i++) s.push([orbit(T - (300 - i) * 1000, 40 - i * 0.05, -120 + i * 0.4)]);
    expect(live(s, "discs")).toBe(1);
    // Two vertices per fix, capped at the window we keep.
    expect([...s.track.liveSlots()].length).toBe(180 * 2);
  });

  it("gives every vertex of the track its own backing fix", () => {
    const s = sky();
    for (let i = 0; i < 5; i++) s.push([orbit(T - (5 - i) * 1000, 40, i)]);
    const keys = [...s.track.liveSlots()].map((v) => s.track.slotBacking(v));
    expect(keys.every((k) => k !== null && s.ledger.get(k) !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(5);
  });
});

describe("visitors, and the one signal the whole social layer rests on", () => {
  const driftOf = (s: Scene, id: string): number =>
    s.discs.data[s.discs.slotFor(`visitor:${id}`)! * DISC_STRIDE + 8]!;
  const sizeOf = (s: Scene, id: string): number =>
    s.discs.data[s.discs.slotFor(`visitor:${id}`)! * DISC_STRIDE + 6]!;

  it("holds a focused light perfectly still and lets an idle one drift", () => {
    const s = sky();
    s.upsertVisitor(presence("a", { focused: true }));
    s.upsertVisitor(presence("b", { focused: false }));
    expect(driftOf(s, "a")).toBe(0);
    expect(driftOf(s, "b")).toBeGreaterThan(1);
  });

  it("makes the difference legible in size as well as motion", () => {
    // One channel is not enough at two pixels across. A focused star is bigger and brighter
    // as well as still.
    const s = sky();
    s.upsertVisitor(presence("a", { focused: true }));
    s.upsertVisitor(presence("b", { focused: false }));
    expect(sizeOf(s, "a")).toBeGreaterThan(sizeOf(s, "b"));
  });

  it("changes both the instant a focus session starts", () => {
    const s = sky();
    s.upsertVisitor(presence("a", { focused: false }));
    expect(driftOf(s, "a")).toBeGreaterThan(0);
    s.setFocus("a", true);
    expect(driftOf(s, "a")).toBe(0);
  });

  it("places a visitor where they are looking, and moves them when they look elsewhere", () => {
    const s = sky();
    s.upsertVisitor(presence("a", { az: 90, alt: 30 }));
    const slot = s.discs.slotFor("visitor:a")!;
    expect(s.discs.data[slot * DISC_STRIDE + 1]).toBeCloseTo(90 * DEG, 5);
    s.setGaze("a", 270, 60);
    expect(s.discs.data[slot * DISC_STRIDE + 1]).toBeCloseTo(270 * DEG, 5);
    // Horizontal space, so it does not turn with the sky. Nobody told us where they are.
    expect(s.discs.data[slot * DISC_STRIDE + 9]).toBe(1);
  });

  it("takes a visitor's light away when they leave", () => {
    const s = sky();
    s.upsertVisitor(presence("a"));
    s.upsertVisitor(presence("b"));
    s.removeVisitor("a");
    expect(live(s, "discs")).toBe(1);
    expect(s.discs.slotFor("visitor:a")).toBeUndefined();
    // The swap-remove must not have lost the other one's key.
    expect(s.discs.slotFor("visitor:b")).toBe(0);
  });
});

describe("pointing at a light", () => {
  it("hands back the record the feed sent, not a description of it", () => {
    const s = sky();
    const e = edit(T, { ...OVERHEAD, label: "en.wikipedia: Hour angle", magnitude: 0.8 });
    s.push([e]);
    s.update(T + 300);
    const hit = s.hitTest(450, 450);
    expect(hit).not.toBeNull();
    expect(hit!.event).toBe(e);
    expect(hit!.event!.label).toBe("en.wikipedia: Hour angle");
    expect(hit!.event!.source).toBe("Wikimedia EventStreams");
    // Not exactly 90: the edit happened 300ms ago and the sky has turned 0.00125 degrees
    // since. That residue is the premise working, so it is asserted rather than rounded away.
    expect(hit!.altDeg).toBeCloseTo(90, 2);
    expect(hit!.altDeg).toBeLessThan(90);
  });

  it("says when a position was inferred rather than measured", () => {
    // An edit has no location. Calling the wiki's region the editor's desk would be a lie
    // printed in pixels, so the hit carries the feed's own word for it.
    const s = sky();
    s.push([edit(T, OVERHEAD)]);
    s.update(T + 300);
    expect(s.hitTest(450, 450)!.inferredPlacement).toBe(true);

    const q = sky();
    q.push([quake(T, OVERHEAD)]);
    q.update(T + 300_000);
    expect(q.hitTest(450 + 36, 450)!.inferredPlacement).toBe(false);
  });

  it("explains what the drawing means as well as what it is", () => {
    const s = sky();
    s.push([edit(T, { ...OVERHEAD, magnitude: 0.8 })]);
    s.update(T + 300);
    // The streak's direction is the sky's rotation and not the edit's, and the panel has to
    // be able to say so.
    expect(s.hitTest(450, 450)!.encoding).toContain("bytes changed");
    expect(s.hitTest(450, 450)!.encoding).toContain("rotation");
  });

  it("tests a quake against its ring and not against the empty middle of it", () => {
    const s = sky();
    s.push([quake(T - 300_000, OVERHEAD)]);
    s.update(T);
    // 3.5 km/s for five minutes is 1050 km, which at this scale is 36 pixels out.
    expect(s.hitTest(450, 450)).toBeNull();
    const onRing = s.hitTest(450 + 36, 450);
    expect(onRing).not.toBeNull();
    expect(onRing!.kind).toBe("quake");
    expect(onRing!.encoding).toContain("Rayleigh");
  });

  it("cannot hit something on the far side of the planet", () => {
    const s = sky();
    s.push([quake(T, { lat: -HERE.latDeg, lon: HERE.lonDeg + 180 })]);
    s.update(T + 1000);
    for (let x = 0; x <= 900; x += 30) {
      for (let y = 0; y <= 900; y += 30) expect(s.hitTest(x, y)).toBeNull();
    }
  });

  it("returns nothing at all for empty sky", () => {
    const s = sky();
    s.push([edit(T, OVERHEAD)]);
    s.update(T + 300);
    expect(s.hitTest(120, 120)).toBeNull();
  });

  it("prefers the nearer of two overlapping lights", () => {
    const s = sky();
    s.push([
      edit(T, { ...OVERHEAD, id: "near", label: "near" }),
      edit(T, { lat: HERE.latDeg + 2, lon: HERE.lonDeg, id: "far", label: "far" }),
    ]);
    s.update(T + 300);
    expect(s.hitTest(450, 450)!.event!.id).toBe("near");
  });

  it("finds a visitor by where they are looking", () => {
    const s = sky();
    // Looking straight up is the centre of the frame for an observer also looking straight up.
    s.upsertVisitor(presence("a", { az: 180, alt: 89.99, focused: true }));
    s.update(T);
    const hit = s.hitTest(450, 450);
    expect(hit!.kind).toBe("visitor");
    expect(hit!.visitor!.id).toBe("a");
    expect(hit!.encoding).toContain("focus session");
    expect(hit!.encoding).toContain("only position anyone sends");
  });
});

describe("with motion reduced", () => {
  it("freezes and holds a long exposure instead of an empty frame", () => {
    const still = sky({ reducedMotion: true });
    const moving = sky({ reducedMotion: false });
    // Oldest first, which is the order a feed delivers a tick in. See the out-of-order case
    // below for what happens when it is not.
    // Spread across forty seconds on purpose. The window has to be longer than the still
    // exposure or both skies keep everything and this measures the fixture instead of the
    // exposure, which is what happened when the meteor lifetime went from 2.2 seconds to 7.
    const batch = Array.from({ length: 400 }, (_, i) => edit(T - (400 - i) * 100));
    still.push(batch);
    moving.push(batch);
    still.update(T);
    moving.update(T);
    // Four times the life means four times the sky. A still frame is a long exposure, which
    // is what a photograph of a meteor shower is, and it is why this does not come out empty.
    expect(still.exposure).toBe(STILL_EXPOSURE);
    expect(live(still, "meteors")).toBeGreaterThan(live(moving, "meteors") * 3);
  });

  it("tells the shader to stop moving anything", () => {
    const s = sky({ reducedMotion: true });
    s.update(T);
    expect(s.uniforms[18]).toBe(STILL_EXPOSURE);
    expect(s.uniforms[19]).toBe(1);
  });

  it("stops an idle visitor drifting, in the hit test as well as on screen", () => {
    const s = sky({ reducedMotion: true });
    s.upsertVisitor(presence("a", { az: 180, alt: 89.99 }));
    s.update(T);
    const a = s.hitTest(450, 450);
    s.update(T + 37_000);
    const b = s.hitTest(450, 450);
    expect(a!.x).toBeCloseTo(b!.x, 9);
    expect(a!.y).toBeCloseTo(b!.y, 9);
  });

  it("is still a composition: several kinds, at several ages, all at once", () => {
    const s = sky({ reducedMotion: true });
    s.push([
      ...Array.from({ length: 300 }, (_, i) => edit(T - i * 25, { lat: (i % 90) - 45, lon: (i * 7) % 360 })),
      quake(T - 30_000, OVERHEAD),
      quake(T - 250_000, { lat: 20, lon: 10 }),
      ...Array.from({ length: 60 }, (_, i) => aurora(T, 64 + (i % 8), -180 + i * 6, 0.3 + (i % 5) / 8)),
    ]);
    s.update(T);
    expect(live(s, "meteors")).toBeGreaterThan(250);
    expect(live(s, "quakes")).toBe(2);
    expect(live(s, "discs")).toBe(60);
  });
});

describe("the clock", () => {
  it("rebases without moving anything, so a week-old tab draws like a fresh one", () => {
    const s = sky();
    s.push([quake(T, OVERHEAD)]);
    s.update(T);
    const before = s.hitTest(450 + 1, 450);
    const epochBefore = s.stats().epochMs;

    // Two hours on, past the rebase threshold. The quake itself is long gone, so this is
    // about a fresh one landing after the epoch has moved.
    s.update(T + 7_200_000);
    expect(s.stats().epochMs).toBeGreaterThan(epochBefore);

    s.push([quake(T + 7_200_000, { ...OVERHEAD, id: "later" })]);
    s.update(T + 7_200_000);
    const after = s.hitTest(450 + 1, 450);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.event!.id).toBe("later");
  });
});

describe("palette changes", () => {
  it("repaints what carries a colour without touching what does not", () => {
    const s = sky();
    s.push([aurora(T, 66, -140, 0.6)]);
    const before = [...s.discs.data.slice(10, 13)];
    s.setPalette(paletteFromCss("sakura-lake"));
    const after = [...s.discs.data.slice(10, 13)];
    expect(after).not.toEqual(before);
    expect(s.palette.id).toBe("sakura-lake");
    // A light palette flips the blend mode, which is the whole reason the scheme is derived
    // from the ground rather than trusted from a label.
    s.update(T);
    expect(s.uniforms[15]).toBe(1);
  });
});
