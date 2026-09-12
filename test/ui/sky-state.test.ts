/**
 * The count in the masthead is one of the three things a stranger reads in ten seconds, so every
 * way it can be wrong by one is pinned here.
 */
import { describe, expect, it } from "vitest";
import type { Presence, ServerMessage } from "../../src/shared/protocol.ts";
import type { SkyEvent } from "../../src/shared/event.ts";
import {
  eventRate,
  initialSky,
  peopleCount,
  RATE_WINDOW_MS,
  reduceSky,
  withConnection,
} from "../../src/ui/sky-state.ts";

const NOW = 1_700_000_000_000;

const person = (id: string): Presence => ({
  id,
  palette: "twilight-comet",
  az: 0,
  alt: 0,
  focused: false,
  since: NOW,
});

const event = (id: string, at = NOW): SkyEvent => ({
  id,
  kind: "edit",
  at,
  lat: 0,
  lon: 0,
  placement: "regional",
  magnitude: 0.4,
  label: id,
  source: "test",
});

const welcome: ServerMessage = {
  t: "welcome",
  you: "me",
  others: [person("a"), person("b")],
  serverNow: NOW,
};

describe("the people count", () => {
  it("includes you, because the wire only carries the others", () => {
    // "2 people here" in a room of three reads as a count of strangers, which is a different
    // and much less interesting claim than the one the page is making.
    const state = reduceSky(initialSky(), welcome, NOW);
    expect(peopleCount(state)).toBe(3);
  });

  it("is one before anybody else arrives", () => {
    const state = reduceSky(initialSky(), { ...welcome, others: [] }, NOW);
    expect(peopleCount(state)).toBe(1);
  });

  it("does not count you twice if the server echoes your own join", () => {
    let state = reduceSky(initialSky(), welcome, NOW);
    state = reduceSky(state, { t: "join", who: person("me") }, NOW);
    expect(peopleCount(state)).toBe(3);
  });

  it("does not go down for somebody who was never here", () => {
    let state = reduceSky(initialSky(), welcome, NOW);
    state = reduceSky(state, { t: "leave", id: "ghost" }, NOW);
    expect(peopleCount(state)).toBe(3);
    expect(state.presenceEpoch).toBe(1);
  });

  it("does not invent a person out of a move for an unknown id", () => {
    let state = reduceSky(initialSky(), welcome, NOW);
    state = reduceSky(state, { t: "move", id: "ghost", az: 10, alt: 5 }, NOW);
    expect(peopleCount(state)).toBe(3);
  });
});

describe("welcome replaces rather than merges", () => {
  it("so a reconnect does not leave the ghosts of everyone who left while we were away", () => {
    let state = reduceSky(initialSky(), welcome, NOW);
    state = reduceSky(state, { t: "welcome", you: "me", others: [person("c")], serverNow: NOW }, NOW);
    expect(peopleCount(state)).toBe(2);
    expect([...state.others.keys()]).toEqual(["c"]);
  });
});

describe("events", () => {
  it("keeps the newest as the one the masthead names", () => {
    const state = reduceSky(
      initialSky(),
      { t: "events", batch: [event("old", NOW - 5000), event("new", NOW)], serverNow: NOW },
      NOW,
    );
    expect(state.latest?.id).toBe("new");
  });

  it("does not clear the named light on an empty tick, which is only a heartbeat", () => {
    let state = reduceSky(initialSky(), { t: "events", batch: [event("a")], serverNow: NOW }, NOW);
    state = reduceSky(state, { t: "events", batch: [], serverNow: NOW + 1000 }, NOW + 1000);
    expect(state.latest?.id).toBe("a");
  });

  it("ages the rate window out rather than counting forever", () => {
    const state = reduceSky(
      initialSky(),
      { t: "events", batch: [event("a"), event("b")], serverNow: NOW },
      NOW,
    );
    expect(eventRate(state, NOW)).toBe(2);
    expect(eventRate(state, NOW + RATE_WINDOW_MS + 1)).toBe(0);
  });

  it("carries the server's clock so relative times are not read off a skewed laptop", () => {
    const state = reduceSky(initialSky(), { ...welcome, serverNow: NOW + 40_000 }, NOW);
    expect(state.skew).toBe(40_000);
  });
});

describe("connection", () => {
  it("changes only when it actually changed, so a render is not forced per heartbeat", () => {
    const state = reduceSky(initialSky(), welcome, NOW);
    expect(withConnection(state, "live")).toBe(state);
    expect(withConnection(state, "offline").connection).toBe("offline");
  });
});
