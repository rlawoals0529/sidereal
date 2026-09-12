/**
 * Colour, taken from the page rather than decided here.
 *
 * Nothing in this directory contains a hex literal for something it draws. The palette is
 * read off the cascade at init and again whenever `data-theme` changes, so switching palette
 * repaints the sky without a reload and a palette added to yozora later works here without
 * anyone editing this file.
 *
 * Two things about the tokens that cost time to find out:
 *
 * **`getComputedStyle` does not resolve a custom property.** Ask for `--bg` and you get the
 * literal token text back, `hsl(247 24.4% 6.5%)`, not `rgb(...)`. The palettes mix
 * space-separated `hsl()` for the three greys and hex for everything else, so both forms
 * have to parse. `rgb()` and `color(srgb ...)` are handled too, because a future palette
 * generator could emit either and finding out through a black sky is a poor way to find out.
 *
 * **`--dim` has no headroom.** It sits near the contrast floor on several palettes already,
 * so nothing here mixes it toward `--bg` to soften something. Where a thing needs to be
 * fainter it gets less alpha against the ground, which is a different operation: the token
 * keeps its value and the light is simply dimmer, the way a dimmer star is.
 *
 * Which token each kind draws in, and why it is that one:
 *
 * | kind    | token           | because |
 * |---------|-----------------|---------|
 * | edit    | `--dim`, `--fg` | the shimmer, a hundred a second. Neutral, and hot at the head only for a big edit, so the sky does not turn into a colour wheel. |
 * | quake   | `--edge-strong` | the token for a boundary that has to be seen, and a wavefront is exactly that. Low in the palette without being a warning colour, which an earthquake is not. |
 * | orbit   | `--accent`      | the one deliberate human object up there gets the palette's own colour. |
 * | aurora  | `--accent-2`    | the second hue, so the band is distinguishable from the ISS without inventing a green. |
 * | visitor | their accent    | a visitor is drawn in the palette they are sitting in, which is real metadata they sent. Falls back to `--accent-2`. |
 * | you     | `--fg`          | the brightest thing in the sky is yours. |
 * | chrome  | `--edge`        | the token for a boundary that does not have to be seen. |
 * | star    | `--fg`          | see below. |
 *
 * **`star` is the one token that is only half of the answer.** A star's hue is a measurement,
 * taken from its colour index, and no palette gets to overrule it. But most stars have no
 * visible hue at all: colour vision is a cone response and cones need more light than a fifth
 * magnitude star delivers, so a real sky is a field of white points with a handful of coloured
 * ones in it. This token is that white, and the catalogue decides which stars escape it.
 *
 * `--fg` and not `--dim`, because a star at the naked-eye limit is already drawn at a
 * twentieth of full brightness and dimming its colour on top of that would put it under the
 * ground. Faintness is expressed in alpha, which is the rule this file opens with. Sharing a
 * token with `you` costs nothing: yours is drawn at 0.95 alpha and three degrees across, and a
 * star at the same token is a two-pixel point.
 */

export type RGB = readonly [number, number, number];

/** The bits of the page this reads. Small on purpose: it is the whole surface to fake. */
export type PaletteSource = {
  /** The raw token text for a custom property name, or "" if it is not set. */
  read(token: string): string;
  /** The value of `data-theme` on the root, or null. */
  themeId(): string | null;
};

export type SkyPalette = {
  id: string;
  scheme: "light" | "dark";
  bg: RGB;
  meteor: RGB;
  meteorHot: RGB;
  quake: RGB;
  orbit: RGB;
  aurora: RGB;
  visitor: RGB;
  you: RGB;
  chrome: RGB;
  /** The colourless end of a star, which is most of them. See the table above. */
  star: RGB;
};

const FALLBACK: RGB = [0.5, 0.5, 0.5];

/**
 * Parse one token's text to linear channel values in 0..1.
 *
 * Returns null rather than a default on anything unrecognised, so a caller can decide
 * whether a missing token is worth complaining about. Silently substituting grey is how a
 * palette that half loaded looks deliberate.
 */
export function parseColour(text: string): RGB | null {
  const s = text.trim().toLowerCase();
  if (s === "") return null;

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const wide = hex.length >= 6;
    const step = wide ? 2 : 1;
    if (hex.length !== 3 && hex.length !== 4 && hex.length !== 6 && hex.length !== 8) return null;
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      const part = hex.slice(i * step, i * step + step);
      const v = parseInt(wide ? part : part + part, 16);
      if (Number.isNaN(v)) return null;
      out.push(v / 255);
    }
    return [out[0]!, out[1]!, out[2]!];
  }

  const fn = /^(hsla?|rgba?|color)\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  // Commas, spaces and the slash before alpha are all legal separators in modern CSS colour
  // syntax and the palettes use two of the three. Splitting on all of them costs nothing and
  // means the parser does not care which generation of syntax a palette was written in.
  const parts = fn[2]!.split(/[\s,/]+/).filter((p) => p.length > 0);

  if (fn[1] === "color") {
    if (parts[0] !== "srgb") return null;
    const n = parts.slice(1, 4).map(Number);
    if (n.length < 3 || n.some(Number.isNaN)) return null;
    return [n[0]!, n[1]!, n[2]!];
  }

  if (fn[1]!.startsWith("rgb")) {
    const n = parts.slice(0, 3).map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) * 2.55 : Number(p)));
    if (n.length < 3 || n.some(Number.isNaN)) return null;
    return [n[0]! / 255, n[1]! / 255, n[2]! / 255];
  }

  const h = Number(parts[0]!.replace("deg", ""));
  const sat = Number(String(parts[1]).replace("%", "")) / 100;
  const light = Number(String(parts[2]).replace("%", "")) / 100;
  if ([h, sat, light].some(Number.isNaN)) return null;
  return hslToRgb(h, sat, light);
}

/** CSS Color 4's own formulation, which avoids the wrapping bugs the older one invites. */
function hslToRgb(hDeg: number, s: number, l: number): RGB {
  const h = ((hDeg % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Relative luminance, WCAG's coefficients. Used only to decide light ground from dark. */
export function luminance(c: RGB): number {
  const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

export type PaletteOptions = {
  /** Maps a visitor's palette id to their accent, so they show up in their own colour. */
  resolveAccent?: (paletteId: string) => string | null;
};

export function readPalette(src: PaletteSource): SkyPalette {
  const tok = (name: string, fallback: RGB = FALLBACK): RGB => parseColour(src.read(name)) ?? fallback;
  const bg = tok("--bg", [0.04, 0.04, 0.06]);
  return {
    id: src.themeId() ?? "",
    // Derived from the ground rather than read from `color-scheme`, because it is the ground
    // the blend mode has to be right for, and a palette could in principle declare one and
    // paint the other. The measurement outranks the label.
    scheme: luminance(bg) > 0.18 ? "light" : "dark",
    bg,
    meteor: tok("--dim"),
    meteorHot: tok("--fg"),
    quake: tok("--edge-strong", tok("--edge")),
    orbit: tok("--accent"),
    aurora: tok("--accent-2", tok("--accent")),
    visitor: tok("--accent-2", tok("--accent")),
    you: tok("--fg"),
    chrome: tok("--edge"),
    star: tok("--fg"),
  };
}

/** The real source. Everything here can throw in a document that is being torn down. */
export function documentSource(root: HTMLElement): PaletteSource {
  return {
    read(token) {
      try {
        return getComputedStyle(root).getPropertyValue(token);
      } catch {
        return "";
      }
    },
    themeId() {
      try {
        return root.getAttribute("data-theme");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Call `onChange` whenever the palette actually changes.
 *
 * Watches the attribute rather than polling, and re-reads rather than trusting the attribute
 * value, because a page can also swap the stylesheet under a stable `data-theme`. Returns the
 * teardown; a sky that is destroyed while an observer is live keeps the whole document alive.
 */
export function watchPalette(
  root: HTMLElement,
  src: PaletteSource,
  onChange: (p: SkyPalette) => void,
): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const obs = new MutationObserver(() => onChange(readPalette(src)));
  obs.observe(root, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  return () => obs.disconnect();
}
