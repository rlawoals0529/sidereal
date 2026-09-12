/**
 * Tests for the sky's logic.
 *
 * These drive `SkyRoom` directly rather than a running Worker. That is a design decision
 * before it is a testing one, and the reasoning is in `room.ts`; the short version is that
 * the hibernation API rebuilds the object underneath you, so the room was always going to
 * have to be constructible from a list of sockets, and once it is, it is also trivially
 * testable.
 *
 * The practical reason for not reaching for `@cloudflare/vitest-pool-workers` on top of
 * that: it is a dependency, `package.json` is not this slice's to edit, and installing one
 * without declaring it would leave the suite green here and red for everyone who runs
 * `npm ci`. A test setup that only works on the machine that wrote it is worse than no test
 * setup, because it reports success.
 *
 * What this trades away is real: nothing here proves `acceptWebSocket` was called, that a
 * 101 carries the client half, or that an attachment really survives a hibernation. Those
 * are runtime obligations and they belong in a `wrangler dev` smoke test, not here. What
 * these do cover is every decision the server actually makes.
 */
import { describe, expect, it } from "vitest";
import type { SkyEvent } from "../../src/shared/event.ts";
import type { Presence, ServerMessage } from "../../src/shared/protocol.ts";
import { SkyRoom, type SkyClient } from "../../src/worker/room.ts";
import {
  MAX_EVENTS_PER_TICK,
  MAX_OCCUPANTS,
  QUEUE_CAP,
  TICK_MS,
} from "../../src/worker/limits.ts";

class FakeClient implements SkyClient {
  readonly sent: ServerMessage[] = [];
  closed: { code?: number | undefined; reason?: string | undefined } | null = null;

  send(data: string): void {
    if (this.closed) throw new Error("send on a closed socket");
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Every frame of one type, in order. */
  ofType<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }

  only<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> {
    const all = this.ofType(t);
    expect(all, `expected exactly one ${t} frame, got ${all.length}`).toHaveLength(1);
    return all[0] as Extract<ServerMessage, { t: T }>;
  }
}

function harness() {
  let now = 1_700_000_000_000;
  let scheduledFor: number | null = null;
  let scheduleCalls = 0;

  const room = new SkyRoom({
    now: () => now,
    scheduleFlush: (ms) => {
      scheduledFor = now + ms;
      scheduleCalls++;
    },
  });

  return {
    room,
    advance(ms: number) {
      now += ms;
    },
    get scheduleCalls() {
      return scheduleCalls;
    },
    get pending() {
      return scheduledFor !== null;
    },
    /** Run the flush the room asked for, the way the shell's timer would. */
    runFlush() {
      expect(scheduledFor, "no flush was scheduled").not.toBeNull();
      now = scheduledFor as number;
      scheduledFor = null;
      room.flush();
    },
  };
}

/** Attach a client and complete the handshake. */
function enter(room: SkyRoom, palette = "civil"): FakeClient {
  const client = new FakeClient();
  expect(room.attach(client)).toBe(true);
  room.handleMessage(client, JSON.stringify({ t: "hello", palette }));
  return client;
}

function skyEvent(id: string, overrides: Partial<SkyEvent> = {}): SkyEvent {
  return {
    id,
    kind: "edit",
    at: 1_700_000_000_000,
    lat: 51.5,
    lon: -0.12,
    placement: "regional",
    magnitude: 0.4,
    label: "Wikipedia edit",
    source: "wikimedia-eventstreams",
    ...overrides,
  };
}

describe("presence", () => {
  it("two clients see each other", () => {
    const { room } = harness();

    const a = enter(room, "civil");
    const welcomeA = a.only("welcome");
    expect(welcomeA.others).toEqual([]);

    const b = enter(room, "nautical");
    const welcomeB = b.only("welcome");

    // b learned about a from its welcome.
    expect(welcomeB.others.map((p: Presence) => p.id)).toEqual([welcomeA.you]);
    expect(welcomeB.others[0]?.palette).toBe("civil");

    // a learned about b from a join broadcast.
    const join = a.only("join");
    expect(join.who.id).toBe(welcomeB.you);
    expect(join.who.palette).toBe("nautical");

    // Nobody is told about themselves twice.
    expect(b.ofType("join")).toHaveLength(0);
    expect(welcomeA.you).not.toBe(welcomeB.you);
  });

  it("an occupant is invisible until it says hello", () => {
    const { room } = harness();
    const a = enter(room);

    const silent = new FakeClient();
    room.attach(silent);

    expect(a.ofType("join")).toHaveLength(0);

    const later = new FakeClient();
    room.attach(later);
    expect(later.only("welcome").others).toHaveLength(1);
  });

  it("leave is broadcast", () => {
    const { room } = harness();
    const a = enter(room);
    const b = enter(room);
    const idB = b.only("welcome").you;

    room.detach(b);

    const leave = a.only("leave");
    expect(leave.id).toBe(idB);
    // The one who left is not told about their own departure.
    expect(b.ofType("leave")).toHaveLength(0);
  });

  it("a socket that never said hello leaves without a leave frame", () => {
    const { room } = harness();
    const a = enter(room);
    const silent = new FakeClient();
    room.attach(silent);

    room.detach(silent);

    expect(a.ofType("leave")).toHaveLength(0);
  });

  it("assigns an id that is not derived from the connection", () => {
    const { room } = harness();
    const first = enter(room).only("welcome").you;
    const { room: room2 } = harness();
    const second = enter(room2).only("welcome").you;

    // Same position, same everything, different id. A counter or an index would fail here.
    expect(second).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses to grow past the occupancy cap", () => {
    const { room } = harness();
    for (let i = 0; i < MAX_OCCUPANTS; i++) expect(room.attach(new FakeClient())).toBe(true);

    expect(room.attach(new FakeClient())).toBe(false);
    expect(room.occupancy).toBe(MAX_OCCUPANTS);
  });

  it("focus is broadcast once, and a repeat is not", () => {
    const { room } = harness();
    const a = enter(room);
    const b = enter(room);

    room.handleMessage(b, JSON.stringify({ t: "focus", on: true }));
    room.handleMessage(b, JSON.stringify({ t: "focus", on: true }));

    expect(a.only("focus").on).toBe(true);
  });
});

describe("not trusting the client", () => {
  it("an invalid palette is rejected", () => {
    const { room } = harness();
    const observer = enter(room);

    const bad = new FakeClient();
    room.attach(bad);
    room.handleMessage(bad, JSON.stringify({ t: "hello", palette: "midnight" }));

    expect(bad.closed?.code).toBe(1008);
    expect(observer.ofType("join")).toHaveLength(0);
    expect(room.occupancy).toBe(1);

    // And it is gone from everyone else's view of the sky.
    const later = new FakeClient();
    room.attach(later);
    expect(later.only("welcome").others).toHaveLength(1);
  });

  it("rejects a palette that is not a string at all", () => {
    const { room } = harness();
    const bad = new FakeClient();
    room.attach(bad);
    room.handleMessage(bad, JSON.stringify({ t: "hello", palette: { toString: 1 } }));

    expect(bad.ofType("join")).toHaveLength(0);
    const later = new FakeClient();
    room.attach(later);
    expect(later.only("welcome").others).toHaveLength(0);
  });

  it("angles are clamped", () => {
    // A fresh room per case, so the move rate limit never has to be reasoned about here.
    const cases = [
      { az: 12, alt: 500, wantAz: 12, wantAlt: 90 },
      { az: 12, alt: -500, wantAz: 12, wantAlt: -90 },
      // Azimuth wraps rather than clamping: 725 degrees is a real direction and it is 5.
      // Clamping a cyclic quantity would swing the gaze most of the way round the sky.
      { az: 725, alt: 0, wantAz: 5, wantAlt: 0 },
      { az: -30, alt: 0, wantAz: 330, wantAlt: 0 },
      { az: 1e9, alt: 45, wantAz: 1e9 % 360, wantAlt: 45 },
    ];

    for (const { az, alt, wantAz, wantAlt } of cases) {
      const { room } = harness();
      const observer = enter(room);
      const mover = enter(room);

      room.handleMessage(mover, JSON.stringify({ t: "look", az, alt }));

      const move = observer.only("move");
      expect(move.az, `az ${az}`).toBe(wantAz);
      expect(move.alt, `alt ${alt}`).toBe(wantAlt);
    }
  });

  it("ignores a look whose angles are not finite", () => {
    const { room } = harness();
    const observer = enter(room);
    const mover = enter(room);

    // JSON has no NaN, so this is how one actually arrives: as a string, or as the null
    // that `JSON.stringify(NaN)` produces. Either way it must never reach the clamp.
    room.handleMessage(mover, '{"t":"look","az":null,"alt":null}');
    room.handleMessage(mover, '{"t":"look","az":"12","alt":"0"}');
    room.handleMessage(mover, '{"t":"look","az":1e999,"alt":0}');

    expect(observer.ofType("move")).toHaveLength(0);
  });

  it("rate limits move broadcasts without losing the latest angle", () => {
    const h = harness();
    const observer = enter(h.room);
    const mover = enter(h.room);

    for (let i = 0; i < 20; i++) {
      h.room.handleMessage(mover, JSON.stringify({ t: "look", az: i, alt: 0 }));
      h.advance(1);
    }

    expect(observer.ofType("move")).toHaveLength(1);

    h.advance(100);
    h.room.handleMessage(mover, JSON.stringify({ t: "look", az: 99, alt: 0 }));
    expect(observer.ofType("move").at(-1)?.az).toBe(99);
  });

  it("ignores an oversized frame without parsing it", () => {
    const { room } = harness();
    const observer = enter(room);
    const client = enter(room);

    const huge = JSON.stringify({ t: "focus", on: true, pad: "x".repeat(5000) });
    room.handleMessage(client, huge);

    expect(observer.ofType("focus")).toHaveLength(0);
  });

  it("ignores malformed frames instead of closing the socket", () => {
    const { room } = harness();
    const client = enter(room);

    room.handleMessage(client, "not json at all");
    room.handleMessage(client, "[]");
    room.handleMessage(client, JSON.stringify({ t: "teleport" }));

    expect(client.closed).toBeNull();
  });
});

describe("the event queue", () => {
  it("the event queue drops oldest and does not grow", () => {
    const h = harness();
    enter(h.room);

    const overflow = 50;
    const events = Array.from({ length: QUEUE_CAP + overflow }, (_, i) => skyEvent(`e${i}`));
    for (let i = 0; i < events.length; i += 256) {
      expect(h.room.ingest(events.slice(i, i + 256)).rejected).toBe(0);
    }

    const stats = h.room.stats();
    expect(stats.queued).toBe(QUEUE_CAP);
    expect(stats.dropped).toBe(overflow);

    // And draining it takes events away rather than leaving a copy behind.
    h.runFlush();
    expect(h.room.stats().queued).toBe(QUEUE_CAP - MAX_EVENTS_PER_TICK);
  });

  it("keeps the newest events, not the oldest", () => {
    const h = harness();
    const client = enter(h.room);

    for (let i = 0; i < QUEUE_CAP + 10; i++) h.room.ingest([skyEvent(`e${i}`)]);
    h.runFlush();

    const first = client.only("events").batch[0];
    expect(first?.id).toBe("e10");
  });

  it("stays at the cap no matter how long the pressure lasts", () => {
    const h = harness();
    enter(h.room);

    for (let round = 0; round < 20; round++) {
      h.room.ingest(Array.from({ length: 256 }, (_, i) => skyEvent(`r${round}-${i}`)));
      expect(h.room.stats().queued).toBeLessThanOrEqual(QUEUE_CAP);
    }
    expect(h.room.stats().queued).toBe(QUEUE_CAP);
  });

  it("coalesces a burst into one frame per tick", () => {
    const h = harness();
    const client = enter(h.room);

    h.room.ingest([skyEvent("a"), skyEvent("b")]);
    h.room.ingest([skyEvent("c")]);
    expect(h.scheduleCalls).toBe(1);

    h.runFlush();

    const frame = client.only("events");
    expect(frame.batch.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("caps how many events leave in one frame and carries the rest to the next", () => {
    const h = harness();
    const client = enter(h.room);

    h.room.ingest(Array.from({ length: 200 }, (_, i) => skyEvent(`e${i}`)));
    h.runFlush();
    expect(client.ofType("events")[0]?.batch).toHaveLength(MAX_EVENTS_PER_TICK);

    expect(h.pending).toBe(true);
    h.runFlush();
    expect(client.ofType("events")[1]?.batch).toHaveLength(MAX_EVENTS_PER_TICK);
  });

  it("does not queue anything for an empty sky", () => {
    const h = harness();
    const result = h.room.ingest([skyEvent("a"), skyEvent("b")]);

    expect(result.accepted).toBe(0);
    expect(h.room.stats().queued).toBe(0);
    expect(h.pending).toBe(false);
  });

  it("does not double-render a replayed batch", () => {
    const h = harness();
    const client = enter(h.room);

    h.room.ingest([skyEvent("same"), skyEvent("other")]);
    h.room.ingest([skyEvent("same")]);
    h.runFlush();

    expect(client.only("events").batch.map((e) => e.id)).toEqual(["same", "other"]);
    expect(h.room.stats().duplicates).toBe(1);
  });

  it("schedules the next tick one interval out", () => {
    const h = harness();
    enter(h.room);
    let asked: number | null = null;
    const probe = new SkyRoom({ scheduleFlush: (ms) => (asked = ms) });
    probe.attach(new FakeClient());
    probe.ingest([skyEvent("a")]);
    expect(asked).toBe(TICK_MS);
  });

  it("evicts a client whose socket has gone, and tells the rest", () => {
    const h = harness();
    const a = enter(h.room);
    const b = enter(h.room);
    const idB = b.only("welcome").you;

    b.closed = { code: 1006 }; // send now throws, as it does for a dead socket
    h.room.ingest([skyEvent("a")]);
    h.runFlush();

    expect(a.ofType("leave").at(-1)?.id).toBe(idB);
    expect(h.room.occupancy).toBe(1);
    expect(h.room.stats().sendFailures).toBe(1);
  });
});

describe("ingest validation", () => {
  it("rejects events the normalizers should never have produced", () => {
    const h = harness();
    enter(h.room);

    const result = h.room.ingest([
      skyEvent("ok"),
      { ...skyEvent("bad-kind"), kind: "comet" },
      { ...skyEvent("bad-lat"), lat: 1000 },
      { ...skyEvent("nan-lon"), lon: null },
      { ...skyEvent("no-id"), id: "" },
      { ...skyEvent("long-label"), label: "x".repeat(5000) },
      "not an object",
    ]);

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(6);
  });

  it("clamps magnitude rather than dropping the event", () => {
    const h = harness();
    const client = enter(h.room);
    h.room.ingest([skyEvent("hot", { magnitude: 4 }), skyEvent("cold", { magnitude: -2 })]);
    h.runFlush();

    expect(client.only("events").batch.map((e) => e.magnitude)).toEqual([1, 0]);
  });

  it("truncates an oversized batch before walking it", () => {
    const h = harness();
    enter(h.room);
    const result = h.room.ingest(Array.from({ length: 1000 }, (_, i) => skyEvent(`e${i}`)));

    expect(result.accepted).toBe(256);
    expect(result.rejected).toBe(744);
  });

  it("shrugs off a payload that is not an array", () => {
    const h = harness();
    enter(h.room);
    expect(h.room.ingest({ events: [] }).accepted).toBe(0);
    expect(h.room.ingest(null).accepted).toBe(0);
  });
});

describe("surviving a hibernation", () => {
  it("rebuilds presence from what rode on the sockets", () => {
    const h = harness();
    const a = new FakeClient();
    const attachment = {
      id: "aaaaaaaaaaaaaaaa",
      palette: "night",
      az: 10,
      alt: 20,
      focused: true,
      since: 1_699_999_000_000,
      joined: true,
    };

    h.room.rehydrate([[a, attachment]]);
    expect(h.room.occupancy).toBe(1);

    const b = new FakeClient();
    h.room.attach(b);
    const others = b.only("welcome").others;
    expect(others).toEqual([
      { id: "aaaaaaaaaaaaaaaa", palette: "night", az: 10, alt: 20, focused: true, since: 1_699_999_000_000 },
    ]);
  });

  it("closes a socket whose attachment it cannot read, instead of throwing", () => {
    const h = harness();
    const broken = new FakeClient();

    expect(() => h.room.rehydrate([[broken, { id: 7 }], [new FakeClient(), null]])).not.toThrow();
    expect(broken.closed?.code).toBe(1012);
    expect(h.room.occupancy).toBe(0);
  });
});
