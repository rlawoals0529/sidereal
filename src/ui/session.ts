/**
 * The focus ritual, and the arithmetic behind the streak.
 *
 * A session is a span of wall-clock time you declared. Everything else here is derived from the
 * list of them, which is the reason the persistence layer only has to store spans: a streak
 * recomputed from history cannot drift out of step with the history, whereas a stored counter
 * has to be corrected every time a session is added, removed or replayed from another device.
 */

export type Session = { start: number; end: number };

/**
 * Focus time in one local day that keeps the streak alive.
 *
 * Five minutes, and it is stated on screen for the same reason it exists: a streak with no
 * floor is kept by opening the tab and closing it, which is a number that measures nothing. A
 * threshold that is never shown is worse than no threshold, because the day a streak breaks
 * unexpectedly the page has no answer for why.
 */
export const FOCUS_DAY_MS = 5 * 60_000;

/** Below this a session is a misclick. Recorded sessions are the raw material for the streak,
 *  so letting a 200ms one in means a day can qualify on noise. */
export const MIN_SESSION_MS = 1_000;

/**
 * The day a moment belongs to, in the viewer's own time zone.
 *
 * Built from the local getters rather than from `toISOString().slice(0, 10)`, which is UTC. The
 * UTC version is the classic version of this bug and it is invisible for most of the day: for
 * somebody in UTC+9, a session at 21:00 on Tuesday is filed under Wednesday, so a solid week of
 * evening sessions reads as a streak that breaks every Monday and nobody can reproduce it.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day before a day key, stepped as a local calendar date so DST changes do not skip one. */
export function previousDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 1);
  return dayKey(date.getTime());
}

/** Total focused milliseconds per local day. A session spanning midnight counts on the day it
 *  started, which is the day the person would say they did it. */
export function totalsByDay(sessions: readonly Session[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    const ms = s.end - s.start;
    if (ms < MIN_SESSION_MS) continue;
    const key = dayKey(s.start);
    totals.set(key, (totals.get(key) ?? 0) + ms);
  }
  return totals;
}

export type Streak = { current: number; longest: number; todayMs: number };

/**
 * The streak, counted back from today.
 *
 * **Today not qualifying does not break it.** A streak that resets at midnight and is only
 * restored once you have sat down means the page tells you that you have lost something every
 * morning, which is precisely backwards for the one number meant to bring somebody back. So a
 * run that reaches yesterday is still running; it ends when a day with nothing in it is behind
 * you, not when today is not finished yet.
 */
export function streak(sessions: readonly Session[], now: number): Streak {
  const totals = totalsByDay(sessions);
  const qualifies = (key: string) => (totals.get(key) ?? 0) >= FOCUS_DAY_MS;

  const today = dayKey(now);
  let cursor = qualifies(today) ? today : previousDay(today);
  let current = 0;
  while (qualifies(cursor)) {
    current++;
    cursor = previousDay(cursor);
  }

  // Longest runs over the qualifying days on record, oldest first, stepping by calendar date so
  // a gap of one day ends a run and a gap of none extends it.
  const days = [...totals.keys()].filter(qualifies).sort();
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of days) {
    run = previous !== null && previousDay(day) === previous ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  return { current, longest: Math.max(longest, current), todayMs: totals.get(today) ?? 0 };
}

export type FocusState = {
  /** When the running session started, or `null` when idle. */
  startedAt: number | null;
  sessions: readonly Session[];
};

export const idle = (sessions: readonly Session[] = []): FocusState => ({
  startedAt: null,
  sessions,
});

/** Starting twice is a no-op rather than a restart: a double press must not silently discard
 *  the twenty minutes already on the clock. */
export const begin = (state: FocusState, now: number): FocusState =>
  state.startedAt !== null ? state : { ...state, startedAt: now };

export type EndResult = { state: FocusState; recorded: Session | null };

/**
 * Ending a session records it, unless it was too short to mean anything.
 *
 * Returns what was recorded rather than mutating a store, so the caller decides what to persist
 * and the reducer stays testable without one.
 */
export function end(state: FocusState, now: number): EndResult {
  if (state.startedAt === null) return { state, recorded: null };
  const session: Session = { start: state.startedAt, end: Math.max(now, state.startedAt) };
  if (session.end - session.start < MIN_SESSION_MS) {
    return { state: { ...state, startedAt: null }, recorded: null };
  }
  return {
    state: { startedAt: null, sessions: [...state.sessions, session] },
    recorded: session,
  };
}

export const elapsed = (state: FocusState, now: number): number =>
  state.startedAt === null ? 0 : Math.max(0, now - state.startedAt);
