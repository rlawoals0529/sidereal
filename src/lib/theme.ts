// Vendored from yozora/js/theme.ts. Refresh with `node scripts/vendor.mjs` there,
// never edit here.
/**
 * Choosing a palette at runtime, and the two things that go wrong when you do not.
 *
 * The palettes are rescoped to `[data-theme]` by `vendor.mjs --picker`, so switching is one
 * attribute write. Everything below exists because of what has to happen *alongside* that write.
 *
 * **`color-scheme` is not optional.** It tells the browser which way to paint the things the
 * page does not own: scrollbars, form controls, and the canvas behind the document. Set the
 * attribute without it and a light palette gets a dark scrollbar down its side, which no amount
 * of CSS on your own elements will fix, because none of those are your elements.
 *
 * **Storage throws, it does not merely return null.** In a private window, or with site data
 * blocked, touching `localStorage` raises. A theme is a convenience; failing to read one is not
 * a reason to fail to render, so every access is guarded.
 *
 * The host is injected rather than reached for. Not for purity: it means the decisions here are
 * testable in a plain node runner, so vendoring this does not oblige five projects to add jsdom
 * for one file. What a real browser does with the result is covered where it should be, in each
 * project's own browser suite.
 */

export type Theme = { id: string; label: string; accent: string; scheme: "light" | "dark" };

/**
 * The palette every page here opens on.
 *
 * A constant rather than a string each project types out, because the projects are read one
 * after another. A visitor moving between them should not get a different scheme each time -
 * that reads as unrelated pages rather than as one body of work - so this is the one part of
 * the look that is deliberately shared. Everything else about how a project looks is its own.
 *
 * It lives here because a string retyped in a dozen places is a convention, and a convention
 * is what a new project quietly breaks: two of them shipped on the wrong palette before this
 * existed, each one correct in isolation and wrong beside the others.
 */
export const DEFAULT_THEME = "twilight-comet";

/** The bits of the page this touches. Small on purpose: it is the whole surface to fake. */
export type ThemeHost = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  applyToDocument(id: string, scheme: "light" | "dark"): void;
};

/** The real one. Every call guarded, because all three of these can throw. */
export const browserHost: ThemeHost = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The page still works; the choice just will not survive a reload.
    }
  },
  applyToDocument(id, scheme) {
    const root = document.documentElement;
    root.dataset.theme = id;
    root.style.colorScheme = scheme;
  },
};

export type ThemeStore = {
  /** The palette to start on: the saved one if it is still real, otherwise the fallback. */
  initial(): string;
  /** Apply a palette and remember it. Returns what was actually applied. */
  apply(id: string): string;
};

export function createThemeStore(
  themes: readonly Theme[],
  fallback: string,
  key = "yozora:theme",
  host: ThemeHost = browserHost,
): ThemeStore {
  // Read once and narrowed here, so the rest of this closure has a Theme rather than a
  // Theme|undefined. Consumers compile with noUncheckedIndexedAccess, under which themes[0] is
  // possibly undefined however long the array is.
  const first = themes[0];
  if (!first) throw new Error("createThemeStore needs at least one theme");
  const known = (id: string | null): Theme | undefined => themes.find((t) => t.id === id);
  const base: Theme = known(fallback) ?? first;

  return {
    initial: () => known(host.get(key))?.id ?? base.id,
    apply(id) {
      const theme = known(id) ?? base;
      host.applyToDocument(theme.id, theme.scheme);
      host.set(key, theme.id);
      return theme.id;
    },
  };
}

/**
 * The palettes grouped for display, dark first.
 *
 * Dark first because every palette here began as a night theme and the light ones came after,
 * so that order matches what someone browsing them expects to find at the top.
 */
export function grouped(
  themes: readonly Theme[],
): { scheme: "dark" | "light"; label: string; themes: Theme[] }[] {
  return (
    [
      { scheme: "dark" as const, label: "Night" },
      { scheme: "light" as const, label: "Day" },
    ] as const
  )
    .map((g) => ({ ...g, themes: themes.filter((t) => t.scheme === g.scheme) }))
    .filter((g) => g.themes.length > 0);
}
