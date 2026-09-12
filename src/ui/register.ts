/**
 * The register: every light currently in the sky, as a list you can reach with a keyboard.
 *
 * A canvas has no children, so nothing inside it can be focused, and "hover a star" is not an
 * instruction you can give somebody without a mouse. The register is the parallel structure
 * that makes the sky operable: one real button per light, the same evidence on focus as on
 * hover, and `highlight()` back into the renderer so the star you are on is ringed while you
 * arrow down the list.
 *
 * Two behaviours here are the difference between a list and a usable one, and both are about
 * a list that CHANGES while somebody is reading it:
 *
 * **It freezes while focus is inside.** A hundred edits a second means the entry under the
 * cursor is a different entry by the time the key repeats. Arrivals queue instead, and land
 * when focus leaves. Without this the list is not merely annoying, it is unusable: every press
 * selects something the user never saw.
 *
 * **The cursor is an id, not an index.** Index 3 is a different event after one tick. Holding
 * the id means the selection survives everything except the event itself ageing out, which is
 * the one case where moving is correct.
 */
import type { EventKind, SkyEvent } from "../shared/event.ts";
import { RETENTION } from "./ports.ts";

export type Filter = "all" | EventKind;

export type Register = {
  /** Newest first, already trimmed to `RETENTION`. What the sky is holding. */
  items: readonly SkyEvent[];
  /** Arrived while focus was inside. Not visible yet, and not lost. */
  pending: readonly SkyEvent[];
  frozen: boolean;
  filter: Filter;
  cursorId: string | null;
};

export const emptyRegister = (): Register => ({
  items: [],
  pending: [],
  frozen: false,
  filter: "all",
  cursorId: null,
});

/**
 * Newest first, deduplicated by id, aged out, then capped.
 *
 * First occurrence of an id wins. `SkyEvent.id` exists so that "a replayed batch cannot
 * double-render" (shared/event.ts), and last-wins would mean a replay quietly reorders the list
 * under anyone reading it even when nothing about the event changed.
 */
/**
 * How many of one kind may hold the register at once.
 *
 * The list is sorted by time and capped, so without this the loudest feed simply wins. It did:
 * one aurora refresh is hundreds of cells arriving together, and the register became page after
 * page of "Aurora, 1% chance of visibility" with the earthquakes and edits pushed off the end.
 * A reader could not tell the feed was working, let alone what had happened.
 *
 * A quota rather than a filter, because the aurora is not noise. It is a field rather than a
 * stream of separate events, so a handful of cells represents it honestly and the rest belong
 * on the canvas as a band. The Aurora tab still has real content; it just cannot take the room.
 */
/**
 * What leads the list, and why it is not simply what arrived last.
 *
 * Sorting purely by time sounds neutral and is not. One aurora refresh is dozens of cells
 * landing in the same second, so the top of the list was permanently aurora and an earthquake
 * four minutes old sat below ten rows of "Aurora, 6% chance of visibility". The reader saw the
 * least informative thing the sky had, ranked first, forever.
 *
 * So the list leads with what is rare. A quake is a handful an hour, the station passes on a
 * schedule, edits run to a few a second, and aurora cells arrive in dozens at a time: that
 * ordering is roughly the inverse of how often each feed speaks, which is a fair proxy for how
 * much a given row tells you. Within a kind it is still newest first.
 *
 * This is ranking, not filtering. Nothing is hidden, every kind keeps its own tab, and the
 * quota above already decides how many of each are held. This only decides reading order.
 */
const LEADS: Record<EventKind, number> = {
  quake: 0,
  orbit: 1,
  edit: 2,
  aurora: 3,
};

const PER_KIND_CAP: Record<EventKind, number> = {
  aurora: 10,
  edit: 40,
  quake: 40,
  /**
   * One, because there is one space station.
   *
   * Every poll produces a fresh fix, so a quota of six filled the list with six rows saying
   * "International Space Station, 423 km up" at five second intervals. A position is a state
   * rather than an event: the useful row is where it is now, and the older fixes are the trail
   * behind it on the canvas, which is where a track belongs.
   */
  orbit: 1,
};

function settle(events: readonly SkyEvent[], now: number): SkyEvent[] {
  const seen = new Set<string>();
  const kept: SkyEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    kept.push(e);
  }
  kept.sort((a, b) => LEADS[a.kind] - LEADS[b.kind] || b.at - a.at);
  const fresh = kept.filter((e) => now - e.at <= RETENTION.ttlMs);

  // Applied after the sort, so each kind keeps its most recent rather than whichever happened
  // to arrive first.
  const room: Record<string, number> = { ...PER_KIND_CAP };
  const out: SkyEvent[] = [];
  for (const e of fresh) {
    const left = room[e.kind] ?? 0;
    if (left <= 0) continue;
    room[e.kind] = left - 1;
    out.push(e);
    if (out.length >= RETENTION.capacity) break;
  }
  return out;
}

/** One tick of the world. `now` is server time, because `at` is world time (see time.ts). */
export function ingest(state: Register, batch: readonly SkyEvent[], now: number): Register {
  if (batch.length === 0) return state;
  if (state.frozen) return { ...state, pending: [...batch, ...state.pending] };
  return repoint({ ...state, items: settle([...batch, ...state.items], now) });
}

/** Focus entered the list. Everything arriving from here is held. */
export const freeze = (state: Register): Register =>
  state.frozen ? state : { ...state, frozen: true };

/** Focus left. Held arrivals land now, and the cursor moves only if its event is gone. */
export function thaw(state: Register, now: number): Register {
  if (!state.frozen) return state;
  const items = state.pending.length > 0
    ? settle([...state.pending, ...state.items], now)
    : state.items;
  return repoint({ ...state, items, pending: [], frozen: false });
}

export const setFilter = (state: Register, filter: Filter): Register =>
  repoint({ ...state, filter });

/** What the list actually renders: the retained events this filter admits. */
export const visible = (state: Register): readonly SkyEvent[] =>
  state.filter === "all" ? state.items : state.items.filter((e) => e.kind === state.filter);

export const cursorIndex = (state: Register): number =>
  state.cursorId === null ? -1 : visible(state).findIndex((e) => e.id === state.cursorId);

export const cursorEvent = (state: Register): SkyEvent | null =>
  visible(state).find((e) => e.id === state.cursorId) ?? null;

/**
 * Put the cursor back on something real.
 *
 * Called after anything that can remove the cursor's event: an age-out, a filter change, a
 * flush. It moves to the head rather than to the nearest survivor, because "nearest" in a list
 * sorted by time means "the next-oldest thing", and after a flush that is an event further from
 * where the reader was looking than the newest one is.
 */
function repoint(state: Register): Register {
  const list = visible(state);
  if (state.cursorId !== null && list.some((e) => e.id === state.cursorId)) return state;
  return { ...state, cursorId: list[0]?.id ?? null };
}

/**
 * Move the cursor by `by` entries, clamped at both ends.
 *
 * Clamped, not wrapping. A radio group wraps because it is a closed set of choices you are
 * comparing; this is a time-ordered list whose ends mean something, and arriving at the oldest
 * light and being thrown to the newest reads as the list having reset itself.
 */
export function move(state: Register, by: number): Register {
  const list = visible(state);
  if (list.length === 0) return state;
  const from = cursorIndex(state);
  const to = Math.min(list.length - 1, Math.max(0, (from < 0 ? 0 : from) + by));
  return { ...state, cursorId: list[to]!.id };
}

export function moveTo(state: Register, to: "first" | "last"): Register {
  const list = visible(state);
  if (list.length === 0) return state;
  return { ...state, cursorId: (to === "first" ? list[0] : list[list.length - 1])!.id };
}

export const select = (state: Register, id: string): Register =>
  visible(state).some((e) => e.id === id) ? { ...state, cursorId: id } : state;

/** How many arrivals the freeze is holding back, for the "N new" affordance on the list. */
export const heldCount = (state: Register): number => state.pending.length;
