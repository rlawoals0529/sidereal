/**
 * The poll clock, which is mostly about what happens when a source is down.
 *
 * Four independent sources means one of them being unreachable is the expected state of the
 * world rather than an incident, so the behaviour worth pinning is not the happy path. It is
 * that a failing feed keeps the other three running, and that it is retried rather than
 * recorded as having run. A dead feed marked done is a feed that looks alive and produces
 * nothing, which is the one failure nobody would notice.
 */
import { describe, expect, it, vi } from "vitest";
import { POLLED_FEEDS, runDueFeeds, type PolledFeed } from "../../src/worker/feeds.ts";
import type { SkyEvent } from "../../src/shared/event.ts";

const T = Date.UTC(2024, 5, 15, 3, 0, 0);

function event(id: string): SkyEvent {
  return {
    id,
    kind: "quake",
    at: T,
    lat: 0,
    lon: 0,
    placement: "measured",
    magnitude: 0.5,
    label: id,
    source: "test",
  };
}

/** A feed that answers with one event named after it, so results are traceable to a source. */
function ok(id: string, everyMs: number): PolledFeed {
  return { id, everyMs, poll: async () => [event(id)] };
}

function broken(id: string, everyMs: number): PolledFeed {
  return {
    id,
    everyMs,
    poll: async () => {
      throw new Error(`${id} is down`);
    },
  };
}

describe("the registry", () => {
  it("has all four sources on it", () => {
    expect(POLLED_FEEDS.map((f) => f.id).sort()).toEqual(["aurora", "iss", "quake", "wiki"]);
  });

  it("polls nothing faster than its source publishes", () => {
    // Each of these is set by the upstream cadence. Polling faster spends a request to receive
    // the same bytes again, and these are four services nobody is paying us to run.
    const every = Object.fromEntries(POLLED_FEEDS.map((f) => [f.id, f.everyMs]));
    expect(every.quake).toBeGreaterThanOrEqual(60_000);
    expect(every.aurora).toBeGreaterThanOrEqual(300_000);
    expect(every.wiki).toBeGreaterThanOrEqual(5_000);
    expect(every.iss).toBeGreaterThanOrEqual(5_000);
  });
});

describe("runDueFeeds", () => {
  it("runs nothing when nothing is due, and does not touch the bookkeeping", async () => {
    const poll = vi.fn(async () => [event("a")]);
    const out = await runDueFeeds([{ id: "a", everyMs: 60_000, poll }], { a: T }, T + 1000);
    expect(poll).not.toHaveBeenCalled();
    expect(out.events).toEqual([]);
  });

  it("runs a feed whose gap has elapsed", async () => {
    const out = await runDueFeeds([ok("a", 60_000)], { a: T }, T + 60_000);
    expect(out.events.map((e) => e.id)).toEqual(["a"]);
    expect(out.lastRun.a).toBe(T + 60_000);
  });

  it("keeps the other three when one is down", async () => {
    // Promise.allSettled rather than Promise.all, and this is the test that says why.
    const out = await runDueFeeds([ok("a", 0), broken("b", 0), ok("c", 0), ok("d", 0)], {}, T);
    expect(out.events.map((e) => e.id).sort()).toEqual(["a", "c", "d"]);
    expect(out.failures).toEqual(["b"]);
  });

  it("retries a failed feed rather than recording it as having run", async () => {
    // The failure that would otherwise be invisible. If a broken feed had its due-time
    // advanced, it would be skipped for a full period and look exactly like a quiet source.
    const feeds = [broken("b", 60_000)];
    const first = await runDueFeeds(feeds, {}, T);
    expect(first.lastRun.b).toBeUndefined();

    const second = await runDueFeeds(feeds, first.lastRun, T + 1);
    expect(second.failures).toEqual(["b"]);
  });

  it("does not let a feed that recovered stay marked as failed", async () => {
    const out = await runDueFeeds([ok("b", 60_000)], {}, T);
    expect(out.failures).toEqual([]);
    expect(out.lastRun.b).toBe(T);
  });
});
