/**
 * `locate` is the inverse of `hitTest`, and these tests are mostly about the two agreeing.
 *
 * The keyboard path depends on it: someone arrowing through the register has a record selected
 * and needs a ring over the light that record drew. The failure that matters is not a ring in
 * slightly the wrong place, it is a ring drawn confidently over the wrong star, or a ring drawn
 * at all for a light that is not on screen. So the assertions here are about agreement and
 * about null, rather than about any particular coordinate.
 */
import { describe, expect, it } from "vitest";
import { Scene, sceneOptions } from "../../src/sky/scene.ts";
import { TWILIGHT, edit, orbit, presence, quake } from "./fixtures.ts";

const T = Date.UTC(2024, 5, 15, 3, 17, 42);
const HERE = { latDeg: 51.4769, lonDeg: -0.0005, gazeAzDeg: 180, gazeAltDeg: 90 };
/** Directly under the observer, so it is unambiguously up and near the centre of the frame. */
const OVERHEAD = { lat: HERE.latDeg, lon: HERE.lonDeg };

function sky(): Scene {
  const s = new Scene(sceneOptions({ observer: HERE, epochMs: T, palette: TWILIGHT }));
  s.resize(900, 900, 1);
  s.update(T);
  return s;
}

describe("locate", () => {
  it("agrees with hitTest about where a light is", () => {
    // The one property worth having. If a pointer at (x, y) selects this record, then asking
    // where this record is has to answer near (x, y), or the ring and the cursor are pointing
    // at different things and one of them is lying.
    const s = sky();
    const e = quake(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon });
    s.push([e]);
    s.update(T + 30_000);

    const at = s.locate(e.id);
    expect(at).not.toBeNull();

    // A quake's own hit test wants the circumference, so probe there rather than at the centre
    // locate reports: the ring is expanding and the middle of it is empty sky.
    const hit = s.hitTest(at!.x, at!.y, 400);
    expect(hit?.event?.id).toBe(e.id);
  });

  it("finds a light of every shape, because each layer is walked separately", () => {
    const s = sky();
    const m = edit(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon });
    const q = quake(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon });
    const o = orbit(T, OVERHEAD.lat, OVERHEAD.lon);
    s.push([m, q, o]);
    s.update(T + 1000);

    for (const e of [m, q, o]) expect(s.locate(e.id), e.kind).not.toBeNull();
  });

  it("finds a visitor, who is a light without being an event", () => {
    const s = sky();
    s.upsertVisitor(presence("someone-else"));
    s.update(T + 1000);
    expect(s.locate("someone-else")).not.toBeNull();
  });

  it("returns null for a record it has never seen, with other lights up to be mistaken for it", () => {
    // The other lights are the point. On an empty sky this passes even if the id is never
    // compared at all, because there is nothing to wrongly return. It did, until this line.
    const s = sky();
    s.push([edit(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon }), quake(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon })]);
    s.upsertVisitor(presence("also-here"));
    s.update(T + 1000);
    expect(s.locate("nothing-by-this-name")).toBeNull();
  });

  it("returns null once a light has aged out, rather than its last position", () => {
    // The ring has to disappear with the light. Reporting where it used to be would be a guess
    // drawn confidently, which is the failure this whole project is organised against.
    const s = sky();
    const e = edit(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon });
    s.push([e]);
    s.update(T + 1000);
    expect(s.locate(e.id)).not.toBeNull();

    s.update(T + 600_000);
    expect(s.locate(e.id)).toBeNull();
  });

  it("returns null for a light below the horizon, which is most of the planet", () => {
    // The antipode of the observer. It is a real record, still in the ledger, and simply not
    // in the sky yet. Null is the correct answer and the caller must draw nothing.
    const s = sky();
    const under = quake(T, { lat: -HERE.latDeg, lon: HERE.lonDeg + 180 });
    // Pushed alongside one that IS up, at the same instant. Without this the test cannot tell
    // "below the horizon" from "locate found nothing at all", and would keep passing if the
    // whole lookup broke.
    const up = quake(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon });
    s.push([under, up]);
    s.update(T + 1000);

    expect(s.locate(up.id)).not.toBeNull();
    expect(s.locate(under.id)).toBeNull();
  });

  it("moves the ring as the sky turns, because the star does not wait", () => {
    // A one-shot placement is right for a moment and then quietly wrong, which is why the
    // adapter re-places the ring every frame rather than once.
    //
    // Two constraints pin the numbers here. The window has to fit inside QUAKE_LIFE_S, 360
    // seconds, or the light retires and this measures ageing rather than rotation. And the
    // point has to sit well off the zenith, because a star overhead barely moves across the
    // frame however fast the sky turns.
    const s = sky();
    const e = quake(T, { lat: OVERHEAD.lat, lon: OVERHEAD.lon + 40 });
    s.push([e]);
    s.update(T + 1000);
    const first = s.locate(e.id);
    expect(first).not.toBeNull();

    s.update(T + 300_000);
    const later = s.locate(e.id);
    // Asserted, not guarded. An `if (later)` here would let the whole test pass by returning
    // null, which is the exact failure it is supposed to catch.
    expect(later).not.toBeNull();
    expect(Math.hypot(later!.x - first!.x, later!.y - first!.y)).toBeGreaterThan(1);
  });
});
