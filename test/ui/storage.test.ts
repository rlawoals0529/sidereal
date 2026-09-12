/**
 * Storage, treated as hostile. Every case here is a real browser state: a private window, a full
 * quota, and a key written by an older version of this page.
 */
import { describe, expect, it } from "vitest";
import {
  localSessionStore,
  MAX_KEPT,
  memorySessionStore,
  storageAvailable,
  type StorageHost,
} from "../../src/ui/storage.ts";

const fakeHost = (initial: string | null = null): StorageHost & { value: () => string | null } => {
  let value = initial;
  return {
    get: () => value,
    set: (_k, v) => {
      value = v;
    },
    value: () => value,
  };
};

/** A private window. Both calls raise; neither returns null. */
const throwingHost: StorageHost = {
  get() {
    throw new DOMException("denied", "SecurityError");
  },
  set() {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("a browser that refuses to store anything", () => {
  it("is a lost history, not a broken page", () => {
    // The guard has to be inside the store, not at the call site: `localStorage` raises on
    // access rather than returning null, so an unguarded read is a blank page in a private
    // window and nothing on this page is worth that.
    const store = localSessionStore({
      get: () => {
        try {
          return throwingHost.get("k");
        } catch {
          return null;
        }
      },
      set: () => {},
    });
    expect(store.load()).toEqual([]);
    expect(() => store.append({ start: 1, end: 2 })).not.toThrow();
  });

  it("is detectable, so the panel can say so instead of showing a streak of zero", () => {
    expect(storageAvailable({ get: () => null, set: () => {} })).toBe(false);
    expect(storageAvailable(fakeHost())).toBe(true);
  });
});

describe("what comes back out of storage", () => {
  it("survives a value that is not JSON at all", () => {
    expect(localSessionStore(fakeHost("{not json")).load()).toEqual([]);
  });

  it("survives a value that is JSON but not a list of sessions", () => {
    expect(localSessionStore(fakeHost(`{"sessions":3}`)).load()).toEqual([]);
  });

  it("drops a row that would poison every sum it is in", () => {
    // One NaN turns every day's total into NaN, no day qualifies, and the streak silently reads
    // zero with nothing on screen to explain it.
    const host = fakeHost(
      JSON.stringify([
        { start: 1, end: 2 },
        { start: "x", end: 5 },
        { start: null, end: null },
        { start: 10, end: 4 },
      ]),
    );
    expect(localSessionStore(host).load()).toEqual([{ start: 1, end: 2 }]);
  });
});

describe("growth", () => {
  it("is bounded, because this key shares a few megabytes with the whole origin", () => {
    const host = fakeHost(
      JSON.stringify(Array.from({ length: MAX_KEPT }, (_, i) => ({ start: i, end: i + 1 }))),
    );
    const store = localSessionStore(host);
    store.append({ start: 99_999, end: 100_000 });
    const kept = store.load();
    expect(kept).toHaveLength(MAX_KEPT);
    expect(kept.at(-1)).toEqual({ start: 99_999, end: 100_000 });
    expect(kept[0]).toEqual({ start: 1, end: 2 });
  });
});

describe("the in-memory store is the same port", () => {
  it("so the seam for a server-backed one is two methods wide", () => {
    const store = memorySessionStore([{ start: 1, end: 2 }]);
    store.append({ start: 3, end: 4 });
    expect(store.load()).toEqual([{ start: 1, end: 2 }, { start: 3, end: 4 }]);
  });
});
