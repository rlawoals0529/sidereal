/**
 * The socket, and what it does when there is not one.
 *
 * Everything here is about the gap between "the page is open" and "the page is connected",
 * because this thing is meant to be left open for hours and a laptop lid closes. The rule the
 * rest of the interface depends on: while the socket is down, this reports `offline` and stops
 * talking, and it never replays a stale frame to make the page look busier than it is.
 *
 * The socket is opened through an injected factory rather than with `new WebSocket` inline, so
 * reconnection, backoff and frame validation are testable in a plain node runner. That is not
 * ceremony: the interesting cases here are a malformed frame and a server that has learned a
 * message this page has not, and neither is reachable by clicking.
 */
import type { ServerMessage, ClientMessage } from "../shared/protocol.ts";
import type { Connection, LinkHandlers, SkyLink } from "./ports.ts";

export type Socket = { send(text: string): void; close(): void };

export type SocketIO = {
  onOpen(): void;
  onText(text: string): void;
  onClose(): void;
};

export type SocketFactory = (url: string, io: SocketIO) => Socket;

/** Every tag `ServerMessage` has. A frame with any other tag is from a newer server. */
const SERVER_TAGS = new Set(["welcome", "join", "leave", "move", "focus", "events"]);

/**
 * A frame, or nothing.
 *
 * Unknown tags are DROPPED rather than thrown on, so a server that adds a message type does not
 * take out every page that has not been redeployed yet. Malformed JSON is dropped for the same
 * reason: one bad frame is not a reason to tear down a connection that is otherwise fine.
 */
export function parseFrame(text: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const tag = (value as { t?: unknown }).t;
    if (typeof tag !== "string" || !SERVER_TAGS.has(tag)) return null;
    return value as ServerMessage;
  } catch {
    return null;
  }
}

/**
 * Reconnect delay, in ms, doubling from half a second and capped at fifteen.
 *
 * Capped because the page is meant to be left open: an uncapped exponential means the tab you
 * left running overnight is an hour into a backoff by morning and will not notice the network
 * came back. Fifteen seconds is short enough to recover unattended and long enough not to
 * hammer a server that is actually down.
 */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** Math.max(0, attempt));
}

export type LinkOptions = {
  open?: SocketFactory;
  /** Injected so the tests do not wait in real time. */
  schedule?: (fn: () => void, ms: number) => void;
};

const browserSocket: SocketFactory = (url, io) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => io.onOpen());
  ws.addEventListener("message", (e) => io.onText(String(e.data)));
  ws.addEventListener("close", () => io.onClose());
  // An error is always followed by a close, so handling both would report the drop twice.
  ws.addEventListener("error", () => {});
  return { send: (text) => ws.send(text), close: () => ws.close() };
};

export function createLink(
  url: string,
  handlers: LinkHandlers,
  { open = browserSocket, schedule = (fn, ms) => setTimeout(fn, ms) }: LinkOptions = {},
): SkyLink & { hello(message: ClientMessage): void } {
  let socket: Socket | null = null;
  let attempt = 0;
  let closed = false;
  /**
   * The one message that must survive a reconnect.
   *
   * `hello` carries the palette and is sent once per connection, so after a drop the server has
   * never heard it. Holding the latest one and replaying it on open is what keeps your star the
   * right colour to everybody else after the lid opens again.
   */
  let greeting: ClientMessage | null = null;

  const status = (s: Connection) => handlers.onStatus(s);

  const connect = () => {
    if (closed) return;
    status(attempt === 0 ? "connecting" : "connecting");
    socket = open(url, {
      onOpen() {
        attempt = 0;
        if (greeting) socket?.send(JSON.stringify(greeting));
        status("live");
      },
      onText(text) {
        const frame = parseFrame(text);
        if (frame) handlers.onMessage(frame);
      },
      onClose() {
        socket = null;
        if (closed) return;
        status("offline");
        schedule(connect, backoffMs(attempt++));
      },
    });
  };

  connect();

  return {
    send(message) {
      if (message.t === "hello") greeting = message;
      // Dropped rather than queued while offline. A `look` sent from four minutes ago is worse
      // than no `look`, and `hello` is replayed on open anyway.
      socket?.send(JSON.stringify(message));
    },
    hello(message) {
      greeting = message;
      socket?.send(JSON.stringify(message));
    },
    close() {
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}
