/**
 * The colour pairings this interface actually uses, and the arithmetic to check them.
 *
 * Two different checks guard the palettes, and neither one covers the other:
 *
 * - **This one, in the unit suite.** It asserts that every token pairing named below clears its
 *   WCAG floor on all fifteen palettes. It is fast, it runs in CI with no browser, and it is
 *   what stops somebody choosing `--dim` for a border in a review.
 * - **The Playwright sweep**, `test/ui/contrast-sweep.mjs`, which drives the real page and reads
 *   COMPUTED styles, compositing the whole ancestor stack. That is the one that catches a
 *   pairing this list does not know about, because it does not take anybody's word for what is
 *   painted on what.
 *
 * Run them both. This list is a claim about the CSS; the sweep is a measurement of it.
 *
 * **All fifteen, every time.** Contrast is V-shaped in the other colour's luminance, so the
 * worst palette is not the darkest or the lightest one: it sits wherever the two curves cross,
 * and on this token set the worst text case is a LIGHT palette and the worst boundary case is a
 * different light palette again. Checking the extremes and reasoning about the middle gives a
 * clean run and a page that fails in the middle.
 */

export type Role = "text" | "boundary";

/**
 * 4.5:1 for text, 3:1 for the boundary of a control.
 *
 * No large-text exemption is claimed anywhere on this page. The exemption is real, but it makes
 * a pass conditional on a font size nobody rechecks after a redesign, and everything here
 * clears the stricter number anyway.
 */
export const MIN: Record<Role, number> = { text: 4.5, boundary: 3 };

export type Pair = {
  /** Token painting the ink or the line. */
  fg: string;
  /** Token painting what it sits on. */
  bg: string;
  role: Role;
  /** Which element, so a failure names something you can go and look at. */
  where: string;
};

/**
 * Every foreground-on-background pairing in `ui.css`, by hand, because CSS cannot be asked.
 *
 * Two deliberate absences, both found by measuring rather than by taste:
 *
 * **`--dim` is never used on `--raised`.** It measures 4.50:1 there on wisteria-alley, which
 * passes with roughly zero headroom: any opacity, any blend, any future nudge to the palette
 * and it is under. Dim text sits on `--panel` (worst 5.08) or `--bg` (worst 4.80) instead.
 *
 * **An accent FILL is never also the edge.** `--accent` against `--panel` is 2.23:1 on
 * moonlit-skyline, so a filled button outlined in its own fill colour has no perceivable
 * boundary there. The fill stays `--accent`, which is the colour the palette is recognised by;
 * the edge is `--accent-text`, the same hue taken far enough to be read.
 *
 * **`--edge-strong` is never used as a control boundary.** yozora holds it to 3:1 against
 * `--bg`, and it hits that exactly (3.00 on plushie-pink), but against `--panel` it is 2.74 and
 * against `--raised` 2.40. Since every control here sits on a panel, the boundary token for a
 * control is `--dim`, which clears 3:1 against all three surfaces with room to spare. `--edge`
 * stays where it belongs: separators, which are decoration and are exempt.
 */
export const CHROME_PAIRS: readonly Pair[] = [
  { fg: "fg", bg: "panel", role: "text", where: "panel body text, register entry label" },
  { fg: "dim", bg: "panel", role: "text", where: "panel labels, units, timestamps" },
  { fg: "accent-text", bg: "panel", role: "text", where: "source name in the now line" },
  { fg: "ok", bg: "panel", role: "text", where: "measured-position marker" },
  { fg: "warn", bg: "panel", role: "text", where: "regional-placement marker" },
  { fg: "err", bg: "panel", role: "text", where: "offline status" },
  { fg: "fg", bg: "bg", role: "text", where: "skip link on the page ground" },
  { fg: "dim", bg: "bg", role: "text", where: "footer note" },
  { fg: "accent-text", bg: "bg", role: "text", where: "skip link when focused" },
  { fg: "fg", bg: "raised", role: "text", where: "filter chip label, secondary button" },
  { fg: "on-accent", bg: "accent", role: "text", where: "the focus session button label" },
  { fg: "dim", bg: "panel", role: "boundary", where: "control border against the panel" },
  { fg: "dim", bg: "raised", role: "boundary", where: "control border against its own fill" },
  { fg: "dim", bg: "bg", role: "boundary", where: "control border against the page" },
  { fg: "accent-text", bg: "panel", role: "boundary", where: "focus ring on a panel" },
  { fg: "accent-text", bg: "bg", role: "boundary", where: "focus ring on the page" },
  { fg: "accent-text", bg: "raised", role: "boundary", where: "chosen palette option edge" },
];

/** Every palette token this interface is allowed to paint with. Anything in `ui.css` outside
 *  this set has no measured pairing, which is the state this file exists to prevent. */
export const TOKENS_IN_USE: readonly string[] = [
  ...new Set(CHROME_PAIRS.flatMap((p) => [p.fg, p.bg])),
  // Structural, never painted as ink or as a line: a radius and a decorative separator.
  "radius",
  "edge",
];

export type Palette = { id: string; tokens: Record<string, string> };

/** Pull `[data-theme="id"] { --token: value; }` blocks out of the vendored stylesheet. There is
 *  no CSSOM in a node runner, and a regex over a generated file is honest about being one. */
export function parsePalettes(css: string): Palette[] {
  return [...css.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)].map(([, id, body]) => {
    const tokens: Record<string, string> = {};
    for (const [, key, value] of (body ?? "").matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
      tokens[key!] = value!.trim();
    }
    return { id: id!, tokens };
  });
}

/** Both notations the generated palettes use: hex, and the `hsl(h s% l%)` the grounds are in. */
export function toRgb(value: string): [number, number, number] {
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const parts = hex.length === 3
      ? [...hex].map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  const m = value.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/);
  // A colour this cannot read is a hole in the check, not a row to skip: an unreadable value
  // that returned black would have made every dark palette pass for the wrong reason.
  if (!m) throw new Error(`unreadable colour: ${value}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m2 = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][
    Math.floor(h / 60) % 6
  ]!;
  return [
    Math.round((seg[0]! + m2) * 255),
    Math.round((seg[1]! + m2) * 255),
    Math.round((seg[2]! + m2) * 255),
  ];
}

const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
