/**
 * The project's one rule, as a test that fails.
 *
 * "Every light traces to a real event" is worth nothing as a sentence in a readme. What makes
 * it real is that each of the ways it can be broken is planted here, by reaching past the API
 * exactly as a future bug would, and the audit is required to catch it. A guard nobody has
 * watched fire is a guard nobody knows works.
 *
 * The five plants, in the order the audit's rules are numbered:
 *
 * 1. a drawn slot with nothing recorded against it
 * 2. a drawn slot pointing at a record that has been forgotten
 * 3. a draw call from a program that is not a registered layer, which is what a decorative
 *    glow pass would look like
 * 4. a chrome element that is not on the frozen declared list
 * 5. a layer drawn further than it was filled, so stale instance data reaches the screen
 */
import { describe, expect, it } from "vitest";
import { Renderer } from "../../src/sky/renderer.ts";
import { CHROME, assertEveryLightIsEarned } from "../../src/sky/provenance.ts";
import { STAR_COUNT } from "../../src/sky/stars.ts";
import { Scene, sceneOptions } from "../../src/sky/scene.ts";
import { stubGl } from "./gl-stub.ts";
import { TWILIGHT, aurora, edit, orbit, presence, quake } from "./fixtures.ts";

const T = Date.UTC(2024, 5, 15, 3, 17, 42);

/** A sky with one of everything in it, rendered once. */
function populated() {
  const scene = new Scene(sceneOptions({ palette: TWILIGHT, epochMs: T }));
  scene.resize(900, 900, 2);
  const { gl, log } = stubGl();
  const renderer = new Renderer(gl, scene);

  scene.push([
    ...Array.from({ length: 240 }, (_, i) => edit(T - i * 8)),
    quake(T - 40_000),
    quake(T - 200_000),
    ...Array.from({ length: 120 }, (_, i) => orbit(T - (120 - i) * 1000, 40 - i * 0.1, i * 2 - 120)),
    ...Array.from({ length: 400 }, (_, i) => aurora(T, 62 + (i % 20) * 0.8, -180 + i, 0.2 + (i % 7) / 10)),
  ]);
  scene.upsertVisitor(presence("you", { focused: true }), true);
  scene.upsertVisitor(presence("someone-else", { az: 300, alt: 25 }));

  scene.update(T);
  renderer.render();
  return { scene, renderer, log };
}

describe("every light is earned", () => {
  it("a fully populated sky has no unbacked drawables at all", () => {
    const { scene, renderer } = populated();
    const a = scene.runAudit(renderer.draws());
    expect(a.violations).toEqual([]);
    // And it actually drew something, so the clean result is not the clean result of nothing.
    expect(a.backed).toBeGreaterThan(700);
    expect(renderer.draws().length).toBeGreaterThan(3);
  });

  it("a drawable with no backing event fails the audit", () => {
    const { scene, renderer } = populated();
    // Plant it the way the bug would arrive: a layer filled a slot and did not record what it
    // was drawn from. `keys` is private to TypeScript, which is a compile-time opinion and not
    // a runtime one, so this is exactly what a real mistake would leave behind.
    const slot = [...scene.meteors.liveSlots()][7]!;
    (scene.meteors as unknown as { keys: (string | null)[] }).keys[slot] = null;

    const a = scene.runAudit(renderer.draws());
    expect(a.violations).toHaveLength(1);
    expect(a.violations[0]).toMatchObject({ where: "meteors", slot, why: "drawn slot has no backing record" });
    expect(() => assertEveryLightIsEarned(a)).toThrowError(/no backing record/);
  });

  it("a drawable whose record has been forgotten fails too", () => {
    const { scene, renderer } = populated();
    const slot = [...scene.quakes.liveSlots()][0]!;
    const key = scene.quakes.slotBacking(slot)!;
    scene.ledger.forget(key);

    const a = scene.runAudit(renderer.draws());
    expect(a.violations).toHaveLength(1);
    expect(a.violations[0]!.why).toContain("not in the ledger");
  });

  it("a draw call from a program that is not a layer fails, which is what a glow pass is", () => {
    const { scene, renderer } = populated();
    // This is the one that matters. The first two rules only ever look at buffers they were
    // told about; a new program painting a wash over the top would satisfy both of them and
    // be entirely invisible. It is caught here because the renderer has to declare its draws.
    const a = scene.runAudit([...renderer.draws(), { source: "layer:ambient-glow", instances: 900 }]);
    expect(a.violations).toEqual([
      { where: "layer:ambient-glow", slot: null, why: "draw call from a source that is not a registered layer" },
    ]);
  });

  it("a chrome element that is not on the declared list fails", () => {
    const { scene, renderer } = populated();
    const a = scene.runAudit([...renderer.draws(), { source: "chrome:nebula", instances: 1 }]);
    expect(a.violations[0]!.why).toBe("chrome element is not on the declared list");
  });

  it("drawing further than a layer was filled fails, because stale slots are not lights", () => {
    const { scene, renderer } = populated();
    const live = [...scene.discs.liveSlots()].length;
    const a = scene.runAudit(
      renderer.draws().map((d) => (d.source === "layer:discs" ? { ...d, instances: live + 12 } : d)),
    );
    expect(a.violations[0]!.why).toBe(`drew ${live + 12} instances but only ${live} slots are live`);
  });

  it("names every violation rather than stopping at the first", () => {
    const { scene, renderer } = populated();
    const slot = [...scene.meteors.liveSlots()][3]!;
    (scene.meteors as unknown as { keys: (string | null)[] }).keys[slot] = null;
    const a = scene.runAudit([...renderer.draws(), { source: "layer:ambient-glow", instances: 1 }]);
    expect(a.violations).toHaveLength(2);
    expect(() => assertEveryLightIsEarned(a)).toThrowError(/2 unbacked drawable/);
  });

  it("declares exactly one thing on screen that is not a light", () => {
    // Pinned deliberately. This is the list a decorative wash would have to be added to, and
    // changing it has to be a change somebody made on purpose to a test.
    expect([...CHROME]).toEqual(["horizon"]);
    const { scene, renderer } = populated();
    expect(scene.runAudit(renderer.draws()).chrome).toEqual(["horizon"]);
  });

  it("accounts for every draw the renderer really issued, not a list the test wrote", () => {
    const { scene, renderer } = populated();
    const known = new Set([
      ...scene.auditableLayers().map((l) => `layer:${l.name}`),
      ...CHROME.map((c) => `chrome:${c}`),
    ]);
    for (const d of renderer.draws()) expect(known.has(d.source)).toBe(true);
  });

  it("retiring a light forgets its record, so the ledger does not grow without bound", () => {
    const scene = new Scene(sceneOptions({ palette: TWILIGHT, epochMs: T }));
    scene.resize(900, 900, 1);
    scene.push(Array.from({ length: 500 }, (_, i) => edit(T - i * 4)));
    const afterPush = scene.ledger.size;
    // The catalogue is admitted at construction and never retires, so it is the floor here.
    expect(afterPush).toBe(STAR_COUNT + 500);
    // Ten seconds on, every one of them has outlived a 2.2 second meteor.
    scene.update(T + 10_000);
    expect(scene.ledger.size).toBe(STAR_COUNT);
    expect([...scene.meteors.liveSlots()]).toEqual([]);
  });
});
