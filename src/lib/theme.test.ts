// Vendored from yozora/js/theme.test.ts. Refresh with `node scripts/vendor.mjs` there,
// never edit here.
import { describe, expect, it } from "vitest";
import { createThemeStore, DEFAULT_THEME, grouped, type Theme, type ThemeHost } from "./theme";

const THEMES: Theme[] = [
  { id: "rain-lantern", label: "Rain Lantern", accent: "#ff7a4d", scheme: "dark" },
  { id: "sakura-lake", label: "Sakura Lake", accent: "#e0932c", scheme: "light" },
];

/** A host that records instead of touching a page, so these run without a DOM. */
function fakeHost(initial: string | null = null) {
  const applied: { id: string; scheme: string }[] = [];
  let stored = initial;
  const host: ThemeHost = {
    get: () => stored,
    set: (_k, v) => {
      stored = v;
    },
    applyToDocument: (id, scheme) => applied.push({ id, scheme }),
  };
  return { host, applied, read: () => stored };
}

describe("createThemeStore", () => {
  it("applies the scheme alongside the palette, not instead of it", () => {
    const { host, applied } = fakeHost();
    createThemeStore(THEMES, "rain-lantern", "k", host).apply("sakura-lake");
    // Without the scheme the browser goes on painting scrollbars for the other one.
    expect(applied).toEqual([{ id: "sakura-lake", scheme: "light" }]);
  });

  it("remembers the choice", () => {
    const { host, read } = fakeHost();
    createThemeStore(THEMES, "rain-lantern", "k", host).apply("sakura-lake");
    expect(read()).toBe("sakura-lake");
    expect(createThemeStore(THEMES, "rain-lantern", "k", host).initial()).toBe("sakura-lake");
  });

  it("ignores a stored palette that no longer exists", () => {
    const { host } = fakeHost("a-palette-that-was-deleted");
    expect(createThemeStore(THEMES, "rain-lantern", "k", host).initial()).toBe("rain-lantern");
  });

  it("falls back to the first theme when the named fallback is not real either", () => {
    const { host } = fakeHost();
    expect(createThemeStore(THEMES, "not-a-palette", "k", host).initial()).toBe("rain-lantern");
  });

  it("applies a palette that does not exist as the fallback rather than nothing", () => {
    const { host, applied } = fakeHost();
    const store = createThemeStore(THEMES, "rain-lantern", "k", host);
    expect(store.apply("nonsense")).toBe("rain-lantern");
    expect(applied.at(-1)).toEqual({ id: "rain-lantern", scheme: "dark" });
  });

  it("refuses an empty theme list rather than rendering an unthemed page", () => {
    expect(() => createThemeStore([], "x")).toThrow();
  });
});

/*
 * browserHost's try/catch is deliberately NOT tested here. Proving it needs a real localStorage
 * that throws, which a fake cannot be without the test becoming a test of the fake. An earlier
 * version of this file tried, and quietly replaced the throwing `get` with a safe one, so it
 * asserted nothing at all. That belongs in a browser suite, against a context with site data
 * blocked.
 */

describe("grouped", () => {
  it("puts night first and drops a group with nothing in it", () => {
    expect(grouped(THEMES).map((g) => g.scheme)).toEqual(["dark", "light"]);
    const light = THEMES.find((x) => x.scheme === "light")!;
    expect(grouped([light]).map((g) => g.scheme)).toEqual(["light"]);
  });
});

describe("the default palette", () => {
  /*
   * Pinned here and nowhere else, because this file is vendored into a dozen projects.
   *
   * An earlier version of this also read the palette list off disk to prove the default names
   * a palette that exists. That check is worth having and this is the wrong place for it: it
   * needs node:fs, which three consumers do not have in their tsconfig types, and it has to
   * guess which layout it landed in. It lives in js/palettes.test.ts, which is not vendored,
   * where the palettes actually are.
   */
  it("is twilight-comet, which every page in the set opens on", () => {
    /*
     * Pinned, because the whole point of the constant is that nobody retypes it. A test that
     * only checked "some palette is the default" would pass while a project quietly opened on
     * a different one, which is the exact failure this constant was added to stop.
     */
    expect(DEFAULT_THEME).toBe("twilight-comet");
  });

});
