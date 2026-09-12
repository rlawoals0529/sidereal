/**
 * The ten seconds. Three facts, each of which the reader can catch changing while they look.
 *
 * The problem: somebody opens a dark page with lights moving on it and has to work out, without
 * being told, that this is real, that it is live, and that other people are here. A modal gets
 * dismissed, a tour gets skipped, and a paragraph gets read by nobody at all - and none of the
 * three would be evidence even if they were read, because a page can claim anything.
 *
 * The answer here is to claim nothing and instead put three counters on screen that a stranger
 * can verify in about two seconds each, without clicking:
 *
 * 1. **A clock with seconds on it.** It advances. That settles "live" on its own, and it is not
 *    an ordinary clock: it is sidereal, four minutes a day off the one on their wall, which is
 *    the first hint that this page is reading from the world rather than from a stylesheet.
 * 2. **A count of people, including them.** It moves when somebody arrives. That settles "other
 *    people are here", and it is a number rather than a sentence because a number that changes
 *    is evidence and a sentence is a claim.
 * 3. **One line naming the newest light**, with what it was, which feed said so, how long ago,
 *    and whether its position was measured. Read one of those and "real" is settled: nobody
 *    fabricates "M4.1, 61 km NNE of Petropavlovsk, USGS". Watch it change as a meteor crosses
 *    and the lights on the canvas are explained too, without a word about what they are.
 *
 * The rate figure is fourth and does the work of a paragraph: "412 events in the last 10
 * seconds" says the scale of what is on screen, and pairs the movement with a number so the
 * movement reads as throughput rather than as animation.
 *
 * What this file protects is that none of those may be printed when they are not known. A count
 * held over from a dead socket is worse than no count: it is the page telling a stranger it is
 * live while it is not, which is the one thing the whole project cannot afford.
 */
import type { Connection } from "./ports.ts";
import type { Evidence } from "./evidence.ts";
import { headline } from "./evidence.ts";
import { RATE_WINDOW_MS } from "./sky-state.ts";
import { siderealClock } from "./time.ts";

export type Masthead = {
  connection: Connection;
  /** What the connection means, in words, only when it is not simply working. */
  status: string | null;
  /** `null` whenever the count is not known, so a view cannot render a stale number. */
  people: number | null;
  peopleText: string;
  rateText: string;
  siderealText: string;
  /** The newest light, or `null` before one has landed. Never a placeholder. */
  latest: Evidence | null;
  latestText: string;
};

const peopleText = (people: number | null): string => {
  if (people === null) return "";
  if (people <= 1) return "just you here";
  return `${people} people here`;
};

/**
 * The rate line, and the four states it has.
 *
 * A live sky with nothing in the window is not the same as a sky we cannot hear, and neither is
 * the same as one we have not reached yet. Collapsing them to "0 events" makes a broken socket
 * look like a quiet night.
 */
function rateText(connection: Connection, rate: number): string {
  if (connection === "offline") return "not connected, nothing here is live";
  if (connection === "connecting") return "connecting";
  const seconds = RATE_WINDOW_MS / 1000;
  if (rate === 0) return `no events in the last ${seconds} seconds`;
  if (rate === 1) return `1 event in the last ${seconds} seconds`;
  return `${rate.toLocaleString("en-US")} events in the last ${seconds} seconds`;
}

export function buildMasthead(input: {
  connection: Connection;
  people: number | null;
  rate: number;
  latest: Evidence | null;
  /** Server time, so the clock and the relative times agree with each other. */
  serverNow: number;
}): Masthead {
  const live = input.connection === "live";
  // People are only known while connected. The moment the socket drops, the honest answer is
  // that we do not know who is here, and `null` is how that reaches the view unambiguously.
  const people = live ? input.people : null;

  return {
    connection: input.connection,
    status: live ? null : input.connection === "connecting" ? "Connecting" : "Offline",
    people,
    peopleText: peopleText(people),
    rateText: rateText(input.connection, input.rate),
    siderealText: siderealClock(input.serverNow),
    latest: live ? input.latest : null,
    latestText: live
      ? input.latest
        ? headline(input.latest)
        : "waiting for the first event"
      : "the last thing seen is not shown while offline, because it is no longer now",
  };
}
