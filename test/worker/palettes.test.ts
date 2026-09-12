/**
 * The allowlist against the design system it is supposed to allow.
 *
 * This file exists because of a bug that every other test in the repo was blind to. The worker
 * carried a hand-written list of four palette names that the design system had never heard of.
 * Both sides of the socket agreed in the unit tests, because the tests used the invented names
 * too, so 380 tests passed while the real server closed every real browser with 1008 the
 * instant it said which palette it was in. Including the default one the page ships with.
 *
 * The lesson is not "add a test for palettes". It is that a test written from the same
 * assumption as the code cannot find a wrong assumption, and the only fix is to check the code
 * against something that was not written for it. Here that is the vendored manifest.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE, PALETTES, isPalette } from "../../src/worker/palettes.ts";
import manifest from "../../src/theme/palettes.json";
import { DEFAULT_THEME } from "../../src/lib/theme.ts";

const ids = (manifest as { id: string }[]).map((row) => row.id);

describe("the allowlist and the design system", () => {
  it("allows exactly the palettes that exist, no more and no fewer", () => {
    // Both directions matter. Extra names would be a palette nobody can pick, and missing ones
    // are the hang-up-the-socket bug.
    expect([...PALETTES].sort()).toEqual([...ids].sort());
  });

  it("allows the palette every page in this portfolio opens on", () => {
    // The one that was broken. A default the server refuses means nobody gets in at all.
    expect(isPalette(DEFAULT_THEME)).toBe(true);
    expect(DEFAULT_PALETTE).toBe(DEFAULT_THEME);
  });

  it("allows every palette by its real id, one at a time", () => {
    for (const id of ids) expect(isPalette(id), id).toBe(true);
  });

  it("has enough palettes to be the real set rather than a stub", () => {
    // A guard against the failure this file was written for coming back as an empty list or a
    // placeholder. If yozora ever genuinely ships fewer than ten, this is the right place to
    // find out on purpose.
    expect(PALETTES.length).toBeGreaterThanOrEqual(10);
  });
});

describe("isPalette", () => {
  it("refuses a name that is not a palette", () => {
    expect(isPalette("civil")).toBe(false);
    expect(isPalette("")).toBe(false);
    expect(isPalette("twilight-comet ")).toBe(false);
  });

  it("refuses anything that is not a string, without touching the set", () => {
    for (const value of [null, undefined, 7, {}, [], { toString: () => "twilight-comet" }]) {
      expect(isPalette(value)).toBe(false);
    }
  });

  it("refuses an overlong string before it ever reaches the set", () => {
    expect(isPalette("x".repeat(33))).toBe(false);
  });
});
