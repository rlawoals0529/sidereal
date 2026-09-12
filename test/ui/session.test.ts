/**
 * The streak. Three of these are bugs that are invisible for most of a day, most of a week, or
 * most of a year respectively, which is why they are pinned rather than left to be noticed.
 */
import { describe, expect, it } from "vitest";
import {
  begin,
  dayKey,
  end,
  FOCUS_DAY_MS,
  idle,
  previousDay,
  streak,
  totalsByDay,
  type Session,
} from "../../src/ui/session.ts";

/** A session of `minutes` ending at local `hour` on a local date. */
const at = (y: number, m: number, d: number, hour: number, minutes: number): Session => {
  const start = new Date(y, m - 1, d, hour, 0, 0).getTime();
  return { start, end: start + minutes * 60_000 };
};

const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0).getTime();

describe("days are local, not UTC", () => {
  it("files a late-evening session under the day the person had it", () => {
    // `toISOString().slice(0,10)` is the version of this that looks right in London and is
    // wrong by a day for half of every day everywhere else.
    //
    // Both ends of the day are checked, because only one of them catches it in any given zone:
    // west of UTC the late-evening reading rolls forward, east of UTC the early-morning one
    // rolls back. A suite that pinned only the evening passes in Tokyo with the bug present.
    expect(dayKey(new Date(2026, 4, 12, 23, 30, 0).getTime())).toBe("2026-05-12");
    expect(dayKey(new Date(2026, 4, 12, 0, 30, 0).getTime())).toBe("2026-05-12");
  });

  it("steps back a calendar day, across a month boundary", () => {
    expect(previousDay("2026-05-01")).toBe("2026-04-30");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
  });
});

describe("a day qualifies on total time, not on having happened", () => {
  it("adds up several sessions in one day", () => {
    const totals = totalsByDay([at(2026, 5, 12, 9, 3), at(2026, 5, 12, 14, 4)]);
    expect(totals.get("2026-05-12")).toBe(7 * 60_000);
  });

  it("does not count a day under the threshold", () => {
    const sessions = [at(2026, 5, 12, 9, FOCUS_DAY_MS / 60_000 - 1)];
    expect(streak(sessions, noon(2026, 5, 12)).current).toBe(0);
  });

  it("counts a day that reaches it exactly", () => {
    const sessions = [at(2026, 5, 12, 9, FOCUS_DAY_MS / 60_000)];
    expect(streak(sessions, noon(2026, 5, 12)).current).toBe(1);
  });

  it("ignores a misclick too short to be a session", () => {
    const start = new Date(2026, 4, 12, 9, 0, 0).getTime();
    expect(totalsByDay([{ start, end: start + 200 }]).size).toBe(0);
  });
});

describe("the streak counts back from today", () => {
  const week: Session[] = [
    at(2026, 5, 9, 9, 30),
    at(2026, 5, 10, 9, 30),
    at(2026, 5, 11, 9, 30),
  ];

  it("does not break at midnight before you have sat down", () => {
    // The one number meant to bring somebody back must not tell them they have lost it every
    // morning. A run that reaches yesterday is still running.
    expect(streak(week, noon(2026, 5, 12)).current).toBe(3);
  });

  it("extends when today is done", () => {
    expect(streak([...week, at(2026, 5, 12, 9, 30)], noon(2026, 5, 12)).current).toBe(4);
  });

  it("ends once a whole empty day is behind you", () => {
    expect(streak(week, noon(2026, 5, 13)).current).toBe(0);
  });

  it("reports the longest run on record even after the current one has broken", () => {
    const result = streak(week, noon(2026, 5, 20));
    expect(result.current).toBe(0);
    expect(result.longest).toBe(3);
  });
});

describe("starting and ending", () => {
  it("does not restart a running session, which would discard the time on the clock", () => {
    const state = begin(idle(), 1000);
    expect(begin(state, 9999).startedAt).toBe(1000);
  });

  it("records a session and hands it back for the caller to persist", () => {
    const result = end(begin(idle(), 1000), 1000 + 600_000);
    expect(result.recorded).toEqual({ start: 1000, end: 601_000 });
    expect(result.state.startedAt).toBeNull();
  });

  it("throws away a session too short to mean anything", () => {
    const result = end(begin(idle(), 1000), 1200);
    expect(result.recorded).toBeNull();
    expect(result.state.sessions).toHaveLength(0);
  });

  it("ending when nothing is running is not an error", () => {
    expect(end(idle(), 5000).recorded).toBeNull();
  });
});
