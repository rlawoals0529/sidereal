/**
 * Every token pairing this interface paints, against all fifteen palettes.
 *
 * This is the fast half. It reads the generated palettes and checks the pairings declared in
 * `contrast.ts`, which is a claim about what `ui.css` does. `test/ui/contrast-sweep.mjs` is the
 * other half: it drives the real page in Chromium and reads computed styles, so it does not
 * take this file's word for anything.
 *
 * The last test is the positive control. A contrast check that has never gone red is a check
 * nobody has any reason to believe, so one pairing that MUST fail is measured here too.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHROME_PAIRS,
  MIN,
  parsePalettes,
  ratio,
  TOKENS_IN_USE,
  type Pair,
} from "../../src/ui/contrast.ts";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const palettes = parsePalettes(read("../../src/theme/palettes.css"));

const worstCase = (pair: Pair) =>
  palettes
    .map((p) => ({
      palette: p.id,
      value: ratio(p.tokens[pair.fg]!, p.tokens[pair.bg]!),
    }))
    .reduce((worst, row) => (row.value < worst.value ? row : worst));

describe("the palettes parsed", () => {
  it("found all fifteen, so a sweep cannot pass by measuring nothing", () => {
    expect(palettes).toHaveLength(15);
    expect(palettes.every((p) => p.tokens.bg && p.tokens.fg)).toBe(true);
  });
});

describe("every pairing in the chrome clears its floor on every palette", () => {
  // Checking all fifteen rather than the lightest and the darkest. Contrast is V-shaped in the
  // other colour's luminance, so the worst case sits where the curves cross, and on this token
  // set it is a light palette for text and a different light palette for boundaries.
  for (const pair of CHROME_PAIRS) {
    it(`--${pair.fg} on --${pair.bg} (${pair.role}): ${pair.where}`, () => {
      const worst = worstCase(pair);
      expect(
        worst.value,
        `--${pair.fg} on --${pair.bg} is ${worst.value.toFixed(2)}:1 on ${worst.palette}, needs ${MIN[pair.role]}`,
      ).toBeGreaterThanOrEqual(MIN[pair.role]);
    });
  }
});

describe("ui.css paints with nothing that has no measured pairing", () => {
  it("uses only tokens this file knows about", () => {
    // The hole this closes: a new rule reaching for --edge-strong, which is held to 3:1 against
    // --bg only and is 2.74 against the panel every control here actually sits on.
    const css = read("../../src/ui/ui.css");
    const used = new Set([...css.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((t) => !TOKENS_IN_USE.includes(t))).toEqual([]);
  });
});

describe("the check can go red", () => {
  it("fails the pairing this interface deliberately does not use", () => {
    const planted = worstCase({
      fg: "edge-strong",
      bg: "panel",
      role: "boundary",
      where: "positive control, never rendered",
    });
    expect(planted.value).toBeLessThan(MIN.boundary);
  });

  it("refuses a colour it cannot read rather than guessing at black", () => {
    expect(() => ratio("chartreuse", "#000000")).toThrow(/unreadable/);
  });
});
