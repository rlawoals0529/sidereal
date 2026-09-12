/**
 * When the polled feeds run, and the one decision behind it.
 *
 * This slice owns the *clock*. The feeds slice owns the fetching and the normalizing, and
 * hands back `SkyEvent[]`. The seam between them is `PolledFeed` and the array at the
 * bottom of this file.
 *
 * ============================================================================
 * Wikipedia: a cron-driven sip, not a long-lived stream held open by the object
 * ============================================================================
 *
 * A Durable Object *can* hold a long-lived outbound connection. Wikimedia EventStreams is
 * SSE, so the obvious design is: open the stream once, read it forever, push each edit into
 * the room. It is the lowest-latency design and it is the wrong one here, for a reason that
 * is specific to this platform and to this product.
 *
 * A Durable Object cannot hibernate while it has work in flight, and an open response
 * stream is work in flight. (The same limitation is explicit for outbound WebSockets -
 * `acceptWebSocket` handles incoming sockets only, cloudflare/workerd#4864 - and an SSE
 * read loop pins the object exactly the same way.) A pinned object is billed for wall-clock
 * time at 128 MB whether or not anything is happening: 86,400 s x 0.125 GB = 10,800 GB-s a
 * day, against a Workers Free allowance of 13,000 GB-s a day. Eighty-three per cent of the
 * daily budget, spent on holding a socket, before one visitor has connected. Hibernation is
 * the entire reason this runs on Durable Objects rather than a small always-on box, and a
 * held stream throws it away.
 *
 * "Hold it only while someone is watching" does not rescue it either, because the product
 * is a sky you leave open all day. Occupied-all-day is the *normal* case here, not the
 * edge, and it is exactly when hibernation has to keep working.
 *
 * ## What happens when the stream drops
 *
 * This is the half that decides it, more than the cost.
 *
 * Wikimedia's stream drops. It rebalances, it disconnects long-lived readers, it times out
 * behind proxies. A held stream fails *silently* when that happens: the async iterator
 * simply ends, nothing throws, and the sky just stops producing meteors. Nobody gets an
 * error. The recovery is a watchdog timer that notices the absence of events and reopens -
 * and a watchdog timer is a pending timer, which is the thing that was pinning the object
 * in the first place. The fix and the disease are the same mechanism.
 *
 * A cron-driven sip has the opposite failure shape. Each run is independent and holds no
 * state between runs. A run that fails loses one window of edits and nothing else; the next
 * run is already scheduled by the platform and needs no knowledge that the last one died.
 * There is nothing to repair, because there was nothing to keep.
 *
 * ## What we give up, honestly
 *
 * Sampling, not consumption. A periodic sip reads a window of the firehose, not all of it,
 * so most edits never become meteors. That is a real loss and it is also the right
 * behaviour: at ~100 edits a second nobody can perceive 100 meteors a second - the sky
 * would be a smear - and `limits.ts` caps the frame rate anyway, so the events would be
 * dropped one layer later regardless. Better to drop them before paying to transport them.
 *
 * Crucially this does not touch the one rule. We draw fewer lights than there were events.
 * We never draw a light there was no event for.
 *
 * We also deliberately do not resume from `Last-Event-ID`. Resuming would hand us the
 * backlog since the last run, which is sixty seconds of firehose, which is six thousand
 * events we would immediately drop. A fresh window each time is both cheaper and more
 * honest about what the sky is showing: now, not a replay of the last minute.
 *
 * =========================================
 * Two clocks, because neither one is enough
 * =========================================
 *
 * **The alarm** is the poll clock. It fires every `POLL_ALARM_MS` while the room is
 * occupied, can go far below a minute, and knows the room's state so it can stop entirely
 * when the last visitor leaves. What it cannot do is restart itself: an alarm that is never
 * re-armed - a deploy mid-handler, an eviction between fires, a bug - is simply gone, and
 * the sky goes dark with no error anywhere.
 *
 * **The cron** is the watchdog. Once a minute it checks whether the sky is occupied and
 * whether the alarm chain is still alive, and re-arms it if it is not. It is the only thing
 * in the system that can restart the schedule from nothing, which is what makes the alarm
 * safe to rely on. One minute is cron's floor and it is also the right number: sixty
 * seconds is the longest a broken sky should stay broken.
 */
import type { SkyEvent } from "../shared/event.ts";

/**
 * One polled source.
 *
 * `poll` is given the current time and returns normalized events. It must not throw for a
 * routine upstream failure - a 503 from USGS is a Tuesday, not an exception - but the
 * scheduler catches anyway, because one feed being down must never stop the others running.
 */
export type PolledFeed = {
  /** Stable key. Used for the due-time bookkeeping, so renaming one re-polls it once. */
  readonly id: string;
  /** Desired gap between polls, in ms. Rounded up to the alarm period in practice. */
  readonly everyMs: number;
  poll(now: number): Promise<SkyEvent[]>;
};

/**
 * Where the pollers get registered. This is the only file in `src/worker/` that has to
 * change to put a feed on the clock.
 *
 * Empty is a working state, not a stub. An empty registry makes the alarm a no-op costing
 * one storage write per fire, and `/ingest` still works, so a feeds slice that would
 * rather run its own schedule somewhere else can ignore this array entirely. Both paths
 * land in the same `SkyRoom.ingest`, which is where all the validation is.
 *
 * It is left empty deliberately rather than wired to `src/feeds/` as that slice lands.
 * Wiring is a cross-slice decision and belongs in a change that can be reviewed as one,
 * not a speculative import added by whichever slice finished second. What the wiring looks
 * like against the surface `src/feeds/index.ts` actually exposes:
 *
 *     import { fetchQuakes, normalizeQuakeEvents } from "../feeds/index.ts";
 *
 *     const quakes: PolledFeed = {
 *       id: "quake",
 *       everyMs: 60_000,
 *       poll: async () => normalizeQuakeEvents(await fetchQuakes()),
 *     };
 *
 * The ISS and the aurora are the same shape with different cadences. Wikipedia is the one
 * that is not, and `streamWikiChunks(signal)` is already the right shape for it: open the
 * stream, read whole lines until a short deadline, abort the signal, hand what arrived to
 * `normalizeWikiEvents`. A sip with a deadline and an abort, not a connection that is kept.
 * The reasoning for that is at the top of this file.
 */
export const POLLED_FEEDS: PolledFeed[] = [];

export type DueState = Record<string, number>;

/**
 * Run every feed that is due, and return the events plus the updated due-times.
 *
 * `Promise.allSettled`, not `Promise.all`: these are four independent sources and one of
 * them being down is the expected state of the world, not a reason to lose the other three.
 *
 * A feed that throws keeps its old due-time, so it is retried on the next alarm rather than
 * being marked as having run. Marking a failed poll as done is how a dead feed becomes a
 * feed that looks alive and produces nothing.
 */
export async function runDueFeeds(
  feeds: readonly PolledFeed[],
  lastRun: DueState,
  now: number,
): Promise<{ events: SkyEvent[]; lastRun: DueState; failures: string[] }> {
  const due = feeds.filter((feed) => now - (lastRun[feed.id] ?? 0) >= feed.everyMs);
  if (due.length === 0) return { events: [], lastRun, failures: [] };

  const settled = await Promise.allSettled(due.map((feed) => feed.poll(now)));

  const events: SkyEvent[] = [];
  const failures: string[] = [];
  const nextRun: DueState = { ...lastRun };
  for (let i = 0; i < settled.length; i++) {
    const feed = due[i];
    const result = settled[i];
    if (!feed || !result) continue;
    if (result.status === "fulfilled") {
      events.push(...result.value);
      nextRun[feed.id] = now;
    } else {
      failures.push(feed.id);
    }
  }
  return { events, lastRun: nextRun, failures };
}
