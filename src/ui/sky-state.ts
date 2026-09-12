/**
 * What the sky contains, folded from the wire.
 *
 * One reducer, one copy of the truth. The alternative - each panel listening to the socket and
 * keeping the part it cares about - is how a presence count and a presence list end up
 * disagreeing about whether somebody left, and the count is the load-bearing number on this
 * page.
 *
 * Pure, and it takes the receive time as an argument rather than calling `Date.now()`, so every
 * case below is testable without a browser and without waiting.
 */
import type { SkyEvent } from "../shared/event.ts";
import type { Presence, ServerMessage } from "../shared/protocol.ts";
import type { Connection } from "./ports.ts";
import { clockSkew } from "./time.ts";

export type SkyState = {
  connection: Connection;
  /** Your own id, once the server has assigned one. `null` before `welcome`. */
  you: string | null;
  /** Everyone ELSE. You are not in here; `peopleCount` adds you. */
  others: ReadonlyMap<string, Presence>;
  /** Add to this browser's clock to get the sky's. See `time.ts`. */
  skew: number;
  /** Arrival times of recent events, for the rate readout. Trimmed, never unbounded. */
  arrivals: readonly number[];
  /** The most recent event, which is what the masthead names. `null` until one lands. */
  latest: SkyEvent | null;
  /** Bumped when somebody joins or leaves, so the announcer can speak only on a real change. */
  presenceEpoch: number;
};

/** The window the "events in the last N seconds" figure is measured over. */
export const RATE_WINDOW_MS = 10_000;

export const initialSky = (): SkyState => ({
  connection: "connecting",
  you: null,
  others: new Map(),
  skew: 0,
  arrivals: [],
  latest: null,
  presenceEpoch: 0,
});

/**
 * The count the masthead prints, and it includes you.
 *
 * `welcome` carries `others`, so the obvious reading of the wire is one short. A sky with one
 * other person in it saying "1 person here" is wrong in the direction that matters: it makes a
 * visitor think they are looking at a count of strangers rather than of everyone present.
 */
export const peopleCount = (state: SkyState): number => state.others.size + (state.you ? 1 : 0);

export function reduceSky(state: SkyState, message: ServerMessage, receivedAt: number): SkyState {
  switch (message.t) {
    case "welcome": {
      // `welcome` is the only message carrying whole state, so this REPLACES rather than
      // merges. A reconnect after a dropped socket is exactly when a merge would leave the
      // ghosts of everyone who left while we were away.
      const others = new Map(message.others.map((p) => [p.id, p]));
      return {
        ...state,
        connection: "live",
        you: message.you,
        others,
        skew: clockSkew(message.serverNow, receivedAt),
        presenceEpoch: state.presenceEpoch + 1,
      };
    }
    case "join": {
      // Your own id can come back on a join if the server echoes; counting it would double you.
      if (message.who.id === state.you) return state;
      const others = new Map(state.others);
      others.set(message.who.id, message.who);
      return { ...state, others, presenceEpoch: state.presenceEpoch + 1 };
    }
    case "leave": {
      if (!state.others.has(message.id)) return state;
      const others = new Map(state.others);
      others.delete(message.id);
      return { ...state, others, presenceEpoch: state.presenceEpoch + 1 };
    }
    case "move": {
      const who = state.others.get(message.id);
      // A move for somebody we have never heard of would otherwise materialise a person with
      // no palette and no arrival time, and the count would go up without anyone joining.
      if (!who) return state;
      const others = new Map(state.others);
      others.set(message.id, { ...who, az: message.az, alt: message.alt });
      return { ...state, others };
    }
    case "focus": {
      const who = state.others.get(message.id);
      if (!who) return state;
      const others = new Map(state.others);
      others.set(message.id, { ...who, focused: message.on });
      // Not a presence change: nobody arrived or left, and announcing it would read out the
      // whole room every time anyone settled down to work.
      return { ...state, others };
    }
    case "events": {
      const skew = clockSkew(message.serverNow, receivedAt);
      const now = message.serverNow;
      const arrivals = [...state.arrivals, ...message.batch.map(() => now)].filter(
        (t) => now - t <= RATE_WINDOW_MS,
      );
      // An empty tick is still a heartbeat, so it refreshes skew and ages the window out. What
      // it must not do is clear `latest`: the last real event stays named until another lands.
      const newest = message.batch.reduce<SkyEvent | null>(
        (best, e) => (!best || e.at > best.at ? e : best),
        null,
      );
      return { ...state, connection: "live", skew, arrivals, latest: newest ?? state.latest };
    }
  }
}

/** Connection changes come from the transport, not the wire, so they have their own door. */
export const withConnection = (state: SkyState, connection: Connection): SkyState =>
  state.connection === connection ? state : { ...state, connection };

/** Events received in the rate window, as of `serverNow`. Ages the list at read time so a
 *  quiet sky reports zero rather than whatever the last tick left behind. */
export const eventRate = (state: SkyState, serverNow: number): number =>
  state.arrivals.filter((t) => serverNow - t <= RATE_WINDOW_MS).length;
