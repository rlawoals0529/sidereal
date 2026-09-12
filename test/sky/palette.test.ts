/**
 * Colour comes off the page, and this checks it against the real page.
 *
 * The interesting case is not a hand-written token string, it is the fifteen palettes that
 * actually ship. `getComputedStyle` hands a custom property back as its literal text, so this
 * renderer has to parse whatever the generator emitted, and the generator emits two different
 * syntaxes in the same file. Parsing them in a unit test with strings somebody typed here
 * would prove nothing about that, so the vendored stylesheet is read and every palette in it
 * is put through the real parser.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { luminance, parseColour, readPalette, type PaletteSource } from "../../src/sky/palette.ts";
import { DEFAULT_THEME } from "../../src/lib/theme.ts";

const CSS = readFileSync(fileURLToPath(new URL("../../src/theme/palettes.css", import.meta.url)), "utf8");

/** The tokens `readPalette` asks for. Every palette has to answer all of them. */
const NEEDED = ["--bg", "--fg", "--dim", "--accent", "--accent-2", "--edge", "--edge-strong"];

function palettesFromCss(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const block of CSS.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
    const tokens = new Map<string, string>();
    for (const decl of block[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(decl[1]!, decl[2]!.trim());
    }
    out.set(block[1]!, tokens);
  }
  return out;
}

function sourceFor(id: string, tokens: Map<string, string>): PaletteSource {
  return { read: (t) => tokens.get(t) ?? "", themeId: () => id };
}

describe("parsing a token", () => {
  it("reads hex in every length CSS allows", () => {
    expect(parseColour("#8b7cf6")).toEqual([0x8b / 255, 0x7c / 255, 0xf6 / 255]);
    expect(parseColour("#abc")).toEqual([0xaa / 255, 0xbb / 255, 0xcc / 255]);
    expect(parseColour("#8b7cf6ff")![0]).toBeCloseTo(0x8b / 255, 9);
    expect(parseColour("#abcd")![2]).toBeCloseTo(0xcc / 255, 9);
  });

  it("reads the space-separated hsl the generator emits for the greys", () => {
    // The exact --bg of twilight-comet, which is the default palette.
    const c = parseColour("hsl(247 24.4% 6.5%)")!;
    expect(c[0]).toBeCloseTo(0.052841, 6);
    expect(c[1]).toBeCloseTo(0.049140, 6);
    expect(c[2]).toBeCloseTo(0.080860, 6);
  });

  it("reads the older comma syntax and the newer slash alpha too", () => {
    expect(parseColour("hsl(247, 24.4%, 6.5%)")![0]).toBeCloseTo(0.052841, 6);
    expect(parseColour("rgb(139 124 246 / 0.4)")![0]).toBeCloseTo(139 / 255, 6);
    expect(parseColour("rgba(139, 124, 246, 0.4)")![1]).toBeCloseTo(124 / 255, 6);
    expect(parseColour("color(srgb 0.2 0.4 0.6)")).toEqual([0.2, 0.4, 0.6]);
  });

  it("wraps hue rather than clamping it", () => {
    expect(parseColour("hsl(370 50% 50%)")).toEqual(parseColour("hsl(10 50% 50%)"));
    expect(parseColour("hsl(-20 50% 50%)")).toEqual(parseColour("hsl(340 50% 50%)"));
  });

  it("returns null on anything it does not recognise, rather than a plausible grey", () => {
    // Substituting a default is how a half-loaded palette comes out looking deliberate.
    for (const bad of ["", "   ", "rebeccapurple", "#12", "var(--accent)", "lab(50% 40 59)"]) {
      expect(parseColour(bad), bad).toBeNull();
    }
  });
});

describe("against the palettes that actually ship", () => {
  const palettes = palettesFromCss();

  it("found all fifteen of them, so a broken parse cannot pass this file", () => {
    expect(palettes.size).toBe(15);
    expect(palettes.has(DEFAULT_THEME)).toBe(true);
  });

  it.each([...palettes.keys()])("%s: every token this renderer reads parses", (id) => {
    const tokens = palettes.get(id)!;
    for (const name of NEEDED) {
      const raw = tokens.get(name);
      expect(raw, `${id} has no ${name}`).toBeTypeOf("string");
      expect(parseColour(raw!), `${id} ${name} = ${raw}`).not.toBeNull();
    }
  });

  it.each([...palettes.keys()])("%s: the scheme measured off the ground matches the declared one", (id) => {
    const tokens = palettes.get(id)!;
    const declared = /color-scheme:\s*light/.test(CSS.split(`[data-theme="${id}"]`)[1]!.split("}")[0]!)
      ? "light"
      : "dark";
    // Measured from --bg rather than read from color-scheme, because it is the ground the
    // blend mode has to be right for. They should never disagree, and this is where we find
    // out if they do.
    expect(readPalette(sourceFor(id, tokens)).scheme).toBe(declared);
  });

  it("gives the default palette the colours the brief expects", () => {
    const p = readPalette(sourceFor(DEFAULT_THEME, palettes.get(DEFAULT_THEME)!));
    expect(p.id).toBe("twilight-comet");
    expect(p.scheme).toBe("dark");
    // The aurora draws in --accent-2, which on this palette is the teal. Separate hue from
    // the ISS, which draws in --accent, and that separation is the whole reason for using two.
    expect(p.aurora).not.toEqual(p.orbit);
    expect(luminance(p.bg)).toBeLessThan(0.02);
    expect(luminance(p.you)).toBeGreaterThan(0.8);
  });

  it("falls back rather than throwing when a token is missing entirely", () => {
    const bare: PaletteSource = { read: (t) => (t === "--bg" ? "#000000" : ""), themeId: () => "x" };
    const p = readPalette(bare);
    expect(p.bg).toEqual([0, 0, 0]);
    expect(p.meteor).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("nothing in this renderer names a colour", () => {
  it("has no hex literal anywhere under src/sky", () => {
    // The rule is that colour comes from the cascade. One hardcoded hex is how a palette
    // stops being switchable, and it is invisible in review because it looks like a colour.
    const root = fileURLToPath(new URL("../../src/sky", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) offenders.push(`${entry.name}: ${m[0]}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
