/**
 * The keyboard list. The two tests that matter here are the freeze and the cursor identity,
 * because both are about a list that changes while somebody is reading it, and neither is
 * reachable by clicking around: you have to be holding an arrow key at the moment a tick lands.
 */
import { describe, expect, it } from "vitest";
import type { SkyEvent } from "../../src/shared/event.ts";
import { RETENTION } from "../../src/ui/ports.ts";
import {
  cursorEvent,
  emptyRegister,
  freeze,
  heldCount,
  ingest,
  move,
  moveTo,
  setFilter,
  thaw,
  visible,
} from "../../src/ui/register.ts";

const NOW = 1_700_000_000_000;

const event = (id: string, secondsAgo: number, kind: SkyEvent["kind"] = "edit"): SkyEvent => ({
  id,
  kind,
  at: NOW - secondsAgo * 1000,
  lat: 0,
  lon: 0,
  placement: "regional",
  magnitude: 0.5,
  label: `event ${id}`,
  source: "test",
});

describe("ingest", () => {
  it("keeps the newest first", () => {
    const state = ingest(emptyRegister(), [event("a", 30), event("b", 5), event("c", 60)], NOW);
    expect(visible(state).map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("does not double-render a replayed batch", () => {
    // `SkyEvent.id` exists for exactly this. A replay that appended would push the reader's
    // cursor down the list for no reason at all.
    let state = ingest(emptyRegister(), [event("a", 10), event("b", 5)], NOW);
    state = ingest(state, [event("a", 10), event("b", 5)], NOW);
    expect(visible(state)).toHaveLength(2);
  });

  it("drops what the sky has already retired, by age and then by count", () => {
    // Mixed kinds on purpose. Every event being an edit would hit the per-kind quota first and
    // this would be testing that instead, which is a different guard with its own test below.
    const old = event("old", RETENTION.ttlMs / 1000 + 60);
    const kinds = ["edit", "quake"] as const;
    const many = Array.from({ length: RETENTION.capacity + 20 }, (_, i) =>
      event(`n${i}`, i, kinds[i % kinds.length]),
    );
    const state = ingest(emptyRegister(), [old, ...many], NOW);
    expect(visible(state)).toHaveLength(RETENTION.capacity);
    expect(visible(state).some((e) => e.id === "old")).toBe(false);
  });

  it("does not let one loud feed take the whole list", () => {
    // One aurora refresh is hundreds of cells at once. Without a per-kind quota it filled the
    // register and pushed every earthquake and edit off the end, so the page looked like a
    // single broken feed repeating itself.
    const aurora = Array.from({ length: 300 }, (_, i) => event(`a${i}`, i, "aurora"));
    // Older than every aurora cell but still inside the retention window, so this measures the
    // quota rather than accidentally measuring the age filter.
    const quakes = Array.from({ length: 5 }, (_, i) => event(`q${i}`, 250 + i, "quake"));
    const state = ingest(emptyRegister(), [...aurora, ...quakes], NOW);

    const shown = visible(state);
    const auroraShown = shown.filter((e) => e.kind === "aurora").length;
    expect(auroraShown).toBeLessThanOrEqual(10);
    // The point of the quota: the quiet feed survives even though it arrived last and oldest.
    expect(shown.filter((e) => e.kind === "quake")).toHaveLength(5);
  });

  it("keeps the most recent of a kind, not the first to arrive", () => {
    const older = Array.from({ length: 20 }, (_, i) => event(`old${i}`, 200 + i, "aurora"));
    const newer = Array.from({ length: 20 }, (_, i) => event(`new${i}`, i, "aurora"));
    const shown = visible(ingest(emptyRegister(), [...older, ...newer], NOW));
    expect(shown.every((e) => e.id.startsWith("new"))).toBe(true);
  });
});

describe("the list freezes while focus is inside it", () => {
  // "newer" is 20 seconds old and "older" is 30, so the list reads newer then older.
  const seed = () => ingest(emptyRegister(), [event("older", 30), event("newer", 20)], NOW);

  it("holds arrivals instead of reordering under the cursor", () => {
    let state = move(seed(), 1); // cursor down from "newer" onto "older"
    state = freeze(state);
    state = ingest(state, [event("arrival", 1)], NOW);

    expect(visible(state).map((e) => e.id)).toEqual(["newer", "older"]);
    expect(cursorEvent(state)?.id).toBe("older");
    expect(heldCount(state)).toBe(1);
  });

  it("lands the held arrivals when focus leaves, keeping the cursor on its own event", () => {
    let state = move(seed(), 1);
    state = freeze(state);
    state = ingest(state, [event("arrival", 1)], NOW);
    state = thaw(state, NOW);

    expect(visible(state).map((e) => e.id)).toEqual(["arrival", "newer", "older"]);
    expect(cursorEvent(state)?.id).toBe("older");
    expect(heldCount(state)).toBe(0);
  });
});

describe("the cursor is an id, not an index", () => {
  it("stays on the same event when newer ones arrive above it", () => {
    let state = ingest(emptyRegister(), [event("older", 30), event("newer", 20)], NOW);
    state = move(state, 1);
    expect(cursorEvent(state)?.id).toBe("older");
    state = ingest(state, [event("c", 1), event("d", 2)], NOW);
    expect(cursorEvent(state)?.id).toBe("older");
  });

  it("moves to the head when its event ages out from under it", () => {
    let state = ingest(emptyRegister(), [event("older", 30), event("newer", 20)], NOW);
    state = move(state, 1);
    // Far enough on that both of those are past the retention window, so the cursor's own
    // event is gone and staying put would mean pointing at nothing.
    const later = NOW + RETENTION.ttlMs + 60_000;
    state = ingest(state, [{ ...event("fresh", 0), at: later }], later);
    expect(cursorEvent(state)?.id).toBe("fresh");
  });
});

describe("moving", () => {
  it("clamps at both ends rather than wrapping", () => {
    // Wrapping in a time-ordered list reads as the list having reset itself.
    let state = ingest(emptyRegister(), [event("a", 30), event("b", 20), event("c", 10)], NOW);
    // Newest first, so "c" is the head and "a" is the tail.
    expect(cursorEvent(move(state, -5))?.id).toBe("c");
    state = moveTo(state, "last");
    expect(cursorEvent(state)?.id).toBe("a");
    expect(cursorEvent(move(state, 5))?.id).toBe("a");
  });
});

describe("filtering", () => {
  it("shows one feed and puts the cursor back on something visible", () => {
    // Two edits, so the leading row is an edit under either ordering and this test stays about
    // the cursor following the filter rather than about which kind leads.
    let state = ingest(
      emptyRegister(),
      [event("a", 10, "edit"), event("b", 20, "edit"), event("q", 30, "quake")],
      NOW,
    );
    state = setFilter(state, "edit");
    expect(cursorEvent(state)?.id).toBe("a");
    state = setFilter(state, "quake");
    expect(visible(state).map((e) => e.id)).toEqual(["q"]);
    expect(cursorEvent(state)?.id).toBe("q");
  });

  it("leads with the rarer feed rather than simply the newest thing", () => {
    // Pure recency put an aurora refresh at the top of the list permanently, because dozens of
    // cells land in the same second. The quake here is the oldest event and still leads.
    const aurora = Array.from({ length: 20 }, (_, i) => event(`a${i}`, i, "aurora"));
    const state = ingest(emptyRegister(), [...aurora, event("q", 200, "quake")], NOW);
    expect(visible(state)[0]?.id).toBe("q");
  });
});

describe("one object, one row", () => {
  it("keeps a single station rather than one row per position fix", () => {
    // The ISS reports every few seconds and each fix is a new event, so the list filled with
    // rows that all said the same thing. A position is a state, not an event: the row is where
    // it is now, and the older fixes are the trail behind it on the canvas.
    const fixes = Array.from({ length: 12 }, (_, i) => event(`iss${i}`, i * 5, "orbit"));
    const shown = visible(ingest(emptyRegister(), fixes, NOW));
    expect(shown.filter((e) => e.kind === "orbit")).toHaveLength(1);
    expect(shown.find((e) => e.kind === "orbit")?.id).toBe("iss0");
  });
});
