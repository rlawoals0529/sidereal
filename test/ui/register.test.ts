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
    const old = event("old", RETENTION.ttlMs / 1000 + 60);
    const many = Array.from({ length: RETENTION.capacity + 20 }, (_, i) => event(`n${i}`, i));
    const state = ingest(emptyRegister(), [old, ...many], NOW);
    expect(visible(state)).toHaveLength(RETENTION.capacity);
    expect(visible(state).some((e) => e.id === "old")).toBe(false);
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
    let state = ingest(emptyRegister(), [event("a", 10, "edit"), event("q", 20, "quake")], NOW);
    expect(cursorEvent(state)?.id).toBe("a");
    state = setFilter(state, "quake");
    expect(visible(state).map((e) => e.id)).toEqual(["q"]);
    expect(cursorEvent(state)?.id).toBe("q");
  });
});
