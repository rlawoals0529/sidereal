/**
 * Palette picking, over the vendored yozora store.
 *
 * `DEFAULT_THEME` is imported rather than typed out. The constant exists precisely because the
 * string was being retyped per project and two of them shipped on the wrong palette, each one
 * correct in isolation and wrong beside the others.
 *
 * The manifest is read as text and parsed here rather than imported as JSON, because this repo
 * typechecks without `resolveJsonModule` and a build that only works in one of its two toolchains
 * is a trap for whoever runs the other one.
 */
import rawManifest from "../theme/palettes.json?raw";
import {
  createThemeStore,
  DEFAULT_THEME,
  grouped,
  type Theme,
  type ThemeHost,
} from "../lib/theme.ts";

export { DEFAULT_THEME };

/** The manifest, treated as untrusted the way anything that arrives as text should be. */
export function parseManifest(text: string): Theme[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("palettes.json is not an array");
  return rows.filter((r): r is Theme => {
    if (typeof r !== "object" || r === null) return false;
    const t = r as Record<string, unknown>;
    return (
      typeof t.id === "string" &&
      typeof t.label === "string" &&
      typeof t.accent === "string" &&
      (t.scheme === "light" || t.scheme === "dark")
    );
  });
}

export const THEMES: readonly Theme[] = parseManifest(rawManifest);

export type PalettePicker = {
  themes: readonly Theme[];
  groups: ReturnType<typeof grouped>;
  current(): string;
  /**
   * Apply and remember. Called as focus moves through the group, so arrowing the list is a
   * preview rather than a survey: you see each palette on the real page before choosing it.
   */
  select(id: string): string;
  /** Snapshot what to put back if this is abandoned. Taken when the group is REACHED. */
  mark(): void;
  /** Escape. Puts back the palette that was on the page when the group was reached. */
  restore(): string;
};

export function createPalettePicker(host?: ThemeHost): PalettePicker {
  const store = host
    ? createThemeStore(THEMES, DEFAULT_THEME, "sidereal:theme", host)
    : createThemeStore(THEMES, DEFAULT_THEME, "sidereal:theme");
  let applied = store.apply(store.initial());
  let marked = applied;

  return {
    themes: THEMES,
    groups: grouped(THEMES),
    current: () => applied,
    select(id) {
      applied = store.apply(id);
      return applied;
    },
    mark() {
      marked = applied;
    },
    restore() {
      applied = store.apply(marked);
      return applied;
    },
  };
}
