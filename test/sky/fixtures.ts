/** Events that look like what the four normalizers actually produce. */
import type { SkyEvent } from "../../src/shared/event.ts";
import type { Presence } from "../../src/shared/protocol.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPalette, type SkyPalette } from "../../src/sky/palette.ts";
import { DEFAULT_THEME } from "../../src/lib/theme.ts";

let n = 0;

export function edit(at: number, over: Partial<SkyEvent> = {}): SkyEvent {
  return {
    id: `rev-${n++}`,
    kind: "edit",
    at,
    lat: 51.5,
    lon: -0.12,
    // Wikipedia edits have no location. The normalizer places them by the wiki's region and
    // says so, and that word is what the panel prints.
    placement: "regional",
    magnitude: 0.4,
    label: "en.wikipedia: Sidereal time",
    source: "Wikimedia EventStreams",
    ...over,
  };
}

export function quake(at: number, over: Partial<SkyEvent> = {}): SkyEvent {
  return {
    id: `us7000-${n++}`,
    kind: "quake",
    at,
    lat: 38.3,
    lon: 142.4,
    placement: "measured",
    magnitude: 0.62,
    label: "M 5.1, 68 km ESE of Ishinomaki",
    source: "USGS",
    ...over,
  };
}

export function orbit(at: number, lat: number, lon: number): SkyEvent {
  return {
    id: `iss-${at}`,
    kind: "orbit",
    at,
    lat,
    lon,
    placement: "measured",
    magnitude: 1,
    label: "ISS (ZARYA)",
    source: "Open Notify",
  };
}

export function aurora(at: number, lat: number, lon: number, p: number): SkyEvent {
  return {
    id: `ovation-${at}-${lat}-${lon}`,
    kind: "aurora",
    at,
    lat,
    lon,
    placement: "measured",
    magnitude: p,
    label: `aurora probability ${Math.round(p * 100)}%`,
    source: "NOAA SWPC OVATION",
  };
}

export function presence(id: string, over: Partial<Presence> = {}): Presence {
  return {
    id,
    palette: "twilight-comet",
    az: 120,
    alt: 40,
    focused: false,
    since: Date.UTC(2024, 5, 15, 3, 0, 0),
    ...over,
  };
}

/**
 * The default palette, read off the stylesheet that ships rather than transcribed.
 *
 * Transcribing it is how a fixture ends up asserting against a colour the product does not
 * have, which is what happened on the first pass: the hsl conversion was done by hand and
 * came out two percent light.
 */
export function paletteFromCss(id = DEFAULT_THEME): SkyPalette {
  const css = readFileSync(fileURLToPath(new URL("../../src/theme/palettes.css", import.meta.url)), "utf8");
  const block = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no palette named ${id} in palettes.css`);
  const tokens = new Map<string, string>();
  for (const decl of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(decl[1]!, decl[2]!.trim());
  }
  return readPalette({ read: (t) => tokens.get(t) ?? "", themeId: () => id });
}

export const TWILIGHT: SkyPalette = paletteFromCss();
