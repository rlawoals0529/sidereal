/**
 * Where the focus history lives, and the seam for where it will live later.
 *
 * `localStorage` for now, behind a two-method port. When there is a server-backed version, it
 * implements `SessionStore` and `main.ts` changes one line; nothing in `session.ts` or the
 * panels knows which one it got. The port is two methods rather than five because that is all
 * a remote one could implement cheaply: `load` once at boot, `append` on each completed
 * session, and no read-modify-write in between.
 *
 * **Every access throws.** In a private window, or with site data blocked, touching
 * `localStorage` raises rather than returning null - including the getter itself, before any
 * method is called on it. A streak is a convenience; failing to read one is not a reason to
 * fail to render a page, and it is emphatically not a reason to refuse to start a session. A
 * throw here costs the history, not the ritual.
 */
import type { Session } from "./session.ts";

export type StorageHost = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

/** The real one. Both calls guarded, including the property access that reaches the object. */
export const browserStorage: StorageHost = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Quota, or a private window. The session still ran; it just will not be counted.
    }
  },
};

export type SessionStore = {
  load(): Session[];
  append(session: Session): void;
};

export const SESSIONS_KEY = "sidereal:sessions";

/**
 * How many completed sessions are kept.
 *
 * Bounded because this file grows forever otherwise, and `localStorage` is a few megabytes
 * shared with everything else on the origin. A year of four sessions a day is under this, and
 * the longest streak is computed from what is kept, so the number is a statement about how far
 * back the record goes rather than an implementation detail.
 */
export const MAX_KEPT = 1500;

/**
 * A stored session, after the storage has been treated as hostile.
 *
 * It has been through JSON, a browser that may have been updated, and possibly a different
 * version of this page. Anything that is not two finite numbers in the right order is dropped,
 * because one bad row must not be able to take out the streak: `NaN` propagating through a sum
 * turns every day's total into `NaN`, every day stops qualifying, and the streak silently reads
 * zero with nothing on screen to explain why.
 */
function valid(row: unknown): row is Session {
  if (typeof row !== "object" || row === null) return false;
  const { start, end } = row as Record<string, unknown>;
  return (
    typeof start === "number" && Number.isFinite(start) &&
    typeof end === "number" && Number.isFinite(end) &&
    end >= start
  );
}

export function localSessionStore(
  host: StorageHost = browserStorage,
  key: string = SESSIONS_KEY,
): SessionStore {
  const read = (): Session[] => {
    const raw = host.get(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(valid).map((s) => ({ start: s.start, end: s.end }));
    } catch {
      // Corrupt, or written by something else on this origin. An empty history is a recoverable
      // state; a thrown parse error at boot is a blank page.
      return [];
    }
  };

  return {
    load: read,
    append(session) {
      const kept = [...read(), session].slice(-MAX_KEPT);
      host.set(key, JSON.stringify(kept));
    },
  };
}

/** An in-memory store, for a browser that refuses to persist and for the tests. Same port. */
export function memorySessionStore(seed: readonly Session[] = []): SessionStore {
  const rows = [...seed];
  return {
    load: () => [...rows],
    append: (s) => {
      rows.push(s);
      if (rows.length > MAX_KEPT) rows.splice(0, rows.length - MAX_KEPT);
    },
  };
}
