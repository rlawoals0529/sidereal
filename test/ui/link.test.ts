/**
 * The socket. Everything here is a case you cannot reach by clicking: a malformed frame, a
 * message from a server newer than this page, and a reconnect.
 */
import { describe, expect, it } from "vitest";
import { backoffMs, createLink, parseFrame, type Socket, type SocketIO } from "../../src/ui/link.ts";
import type { Connection } from "../../src/ui/ports.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";

describe("parseFrame", () => {
  it("takes a frame it knows", () => {
    expect(parseFrame(`{"t":"leave","id":"a"}`)).toEqual({ t: "leave", id: "a" });
  });

  it("drops a frame from a server that has learned something this page has not", () => {
    // Dropping rather than throwing: a new message type must not take out every page that has
    // not been redeployed yet.
    expect(parseFrame(`{"t":"weather","mm":4}`)).toBeNull();
  });

  it("drops a frame that is not JSON, without tearing down a connection that is fine", () => {
    expect(parseFrame("<html>502</html>")).toBeNull();
    expect(parseFrame("null")).toBeNull();
  });
});

describe("backoff", () => {
  it("doubles and then stops, because this page is meant to be left open overnight", () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(40)).toBe(15_000);
  });
});

describe("reconnecting", () => {
  const harness = () => {
    const sent: string[] = [];
    const statuses: Connection[] = [];
    const messages: ServerMessage[] = [];
    let io: SocketIO | null = null;
    let opened = 0;
    const pending: (() => void)[] = [];

    const link = createLink(
      "ws://test/sky",
      {
        onMessage: (m) => messages.push(m),
        onStatus: (s) => statuses.push(s),
      },
      {
        open: (_url, handlers): Socket => {
          io = handlers;
          opened++;
          return { send: (t) => sent.push(t), close: () => handlers.onClose() };
        },
        schedule: (fn) => pending.push(fn),
      },
    );

    return {
      link,
      sent,
      statuses,
      messages,
      opens: () => opened,
      io: () => io!,
      flush: () => pending.splice(0).forEach((fn) => fn()),
    };
  };

  it("replays hello on a new socket, so your star keeps its colour to everybody else", () => {
    // `hello` carries the palette and is sent once per connection. After a drop the server has
    // never heard it, and nothing else on the wire can tell it.
    const h = harness();
    h.link.hello({ t: "hello", palette: "rain-lantern" });
    h.io().onOpen();
    expect(h.sent).toContain(`{"t":"hello","palette":"rain-lantern"}`);

    h.sent.length = 0;
    h.io().onClose();
    h.flush();
    h.io().onOpen();
    expect(h.sent[0]).toBe(`{"t":"hello","palette":"rain-lantern"}`);
    expect(h.opens()).toBe(2);
  });

  it("says offline the moment the socket goes, rather than staying green", () => {
    const h = harness();
    h.io().onOpen();
    h.io().onClose();
    expect(h.statuses).toEqual(["connecting", "live", "offline"]);
  });

  it("drops what it cannot send rather than queueing a stale look", () => {
    const h = harness();
    h.io().onOpen();
    h.io().onClose();
    h.link.send({ t: "look", az: 10, alt: 20 });
    h.flush();
    h.io().onOpen();
    expect(h.sent.filter((s) => s.includes("look"))).toEqual([]);
  });

  it("stops reconnecting once it has been closed on purpose", () => {
    const h = harness();
    h.io().onOpen();
    h.link.close();
    h.flush();
    expect(h.opens()).toBe(1);
  });
});
