import { describe, expect, it } from "vitest";
import { listIntent, paletteIntent, wrap } from "../../src/ui/keys.ts";

describe("the register takes both axes", () => {
  it("moves on either pair, because the list is vertical on a desktop and horizontal on a phone", () => {
    expect(listIntent("ArrowDown")).toEqual({ t: "move", by: 1 });
    expect(listIntent("ArrowRight")).toEqual({ t: "move", by: 1 });
    expect(listIntent("ArrowUp")).toEqual({ t: "move", by: -1 });
    expect(listIntent("ArrowLeft")).toEqual({ t: "move", by: -1 });
    expect(listIntent("PageDown")).toEqual({ t: "move", by: 10 });
    expect(listIntent("Home")).toEqual({ t: "edge", to: "first" });
    expect(listIntent("End")).toEqual({ t: "edge", to: "last" });
  });

  it("leaves every other key to the browser", () => {
    // Swallowing Tab or Enter here is how a list becomes a trap you cannot leave.
    for (const key of ["Tab", "Enter", " ", "a", "Escape"]) {
      expect(listIntent(key)).toEqual({ t: "none" });
    }
  });
});

describe("the palette group is a radio group", () => {
  it("abandons on Escape, which the register has no equivalent of", () => {
    expect(paletteIntent("Escape")).toEqual({ t: "cancel" });
  });

  it("wraps, because a closed set of alternatives has no first or last", () => {
    expect(wrap(0, -1, 15)).toBe(14);
    expect(wrap(14, 1, 15)).toBe(0);
    expect(wrap(3, 2, 15)).toBe(5);
  });
});
