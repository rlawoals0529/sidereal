/**
 * The Durable Object. A shell around `SkyRoom`, and deliberately nothing more.
 *
 * Everything here is either a runtime obligation or a trap the hibernation API sets. The
 * traps are worth reading before changing anything in this file, because each of them
 * produces a bug that cannot be reproduced locally and shows up as "the sky went quiet".
 *
 * **Trap 1: the constructor runs again, mid-life.** When a hibernating object receives a
 * message, the runtime rebuilds it from scratch and *then* calls the handler. Every field
 * initialised here has already been thrown away once by the time a visitor's second message
 * arrives. So the constructor rebuilds the room from `getWebSockets()` rather than starting
 * empty, and it does it synchronously, because `webSocketMessage` can be the very next
 * thing that runs.
 *
 * **Trap 2: in-memory state is gone, socket attachments are not.** Presence rides on the
 * socket via `serializeAttachment`. A `Map` on this class does not survive. The room is
 * built so that this question has an answer for every field it has; see its header.
 *
 * **Trap 3: a pending timer is what stops hibernation.** The flush timer is armed only when
 * there is something queued and is never a repeating interval. An empty sky holds no timer,
 * so it sleeps, which is the entire reason for choosing this platform.
 *
 * **Trap 4: `setWebSocketAutoResponse` is persisted state.** Calling it unconditionally in
 * a constructor that runs on every wake is a storage write on every wake. It is read first.
 */
import { SkyRoom, type Attachment, type SkyClient } from "./room.ts";
import { POLLED_FEEDS, runDueFeeds, type DueState } from "./feeds.ts";
import { PING, PONG, POLL_ALARM_MS } from "./limits.ts";

export type Env = {
  SKY: DurableObjectNamespace;
  /** Shared secret for the ingest route. A secret, never a var: see DEPS.md. */
  INGEST_TOKEN?: string;
};

const DUE_STATE_KEY = "feeds:lastRun";

export class Sky {
  readonly #state: DurableObjectState;
  readonly #room: SkyRoom;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState, _env: Env) {
    this.#state = state;
    this.#room = new SkyRoom({ scheduleFlush: (ms) => this.#armFlush(ms) });

    // Trap 1 and 2. Sockets that outlived the previous instance, with their presence.
    this.#room.rehydrate(
      state.getWebSockets().map((ws) => [ws as SkyClient, ws.deserializeAttachment()] as const),
    );

    // Trap 4.
    if (!state.getWebSocketAutoResponse()) {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/sky":
        return this.#upgrade(request);
      case "/ingest":
        return this.#ingest(request);
      case "/stats":
        // Drops, duplicates and send failures are counted and readable. A bounded queue
        // that discards work silently is indistinguishable from one that is working.
        return json(this.#room.stats());
      case "/tick":
        // The cron's watchdog poke. Re-arms the poll alarm if the sky is occupied and the
        // chain has broken. See the two-clocks note in `feeds.ts`.
        return json({ rearmed: await this.#ensureAlarm() });
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async #upgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accepted before `attach`, because `attach` sends `welcome` and a socket the runtime
    // has not been told about cannot be written to.
    this.#state.acceptWebSocket(server);

    if (!this.#room.attach(server as SkyClient)) {
      // Room full. Closed rather than left hanging, and with a policy code so the client
      // can tell "full" from "broken" and back off instead of hammering the reconnect.
      server.close(1013, "sky full");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Someone is watching now, so the feeds should be running.
    await this.#ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  async #ingest(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    return json(this.#room.ingest(payload));
  }

  // -- hibernation handlers ------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Binary is not part of the protocol. Decoding it to find out what it says is work a
    // client would be choosing for us.
    if (typeof message !== "string") return;

    const attachment = this.#room.handleMessage(ws as SkyClient, message);
    // Written only when something durable actually changed, which is why `handleMessage`
    // returns null for a rate-limited look rather than the unchanged presence.
    if (attachment) persist(ws, attachment);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#room.detach(ws as SkyClient);
    // The runtime does not close the server half for us on a client-initiated close.
    // 1005 and 1006 are "no status" codes that `close()` refuses, so they are translated.
    const safe = code === 1005 || code === 1006 || code < 1000 ? 1000 : code;
    try {
      ws.close(safe, reason);
    } catch {
      // Already gone.
    }
    await this.#onMaybeEmpty();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    // `detach` is idempotent, which it has to be: a broken socket can raise this and then
    // still deliver a close.
    this.#room.detach(ws as SkyClient);
    await this.#onMaybeEmpty();
  }

  // -- the two clocks ------------------------------------------------------------------

  /**
   * The poll clock. Fires while the room is occupied and stops when it empties.
   *
   * Re-armed at the *end*, after the polls, so a slow poll cannot overlap itself. Arming
   * first would let a feed that takes longer than the period stack invocations, which is
   * the classic way a polling loop turns into a fork bomb against someone else's API.
   */
  async alarm(): Promise<void> {
    if (!this.#room.occupied) return; // Not re-armed. Nobody is watching.

    const now = Date.now();
    const lastRun = (await this.#state.storage.get<DueState>(DUE_STATE_KEY)) ?? {};
    const result = await runDueFeeds(POLLED_FEEDS, lastRun, now);

    if (result.events.length > 0) this.#room.ingest(result.events);
    if (result.failures.length > 0) {
      console.warn(`sidereal: feed poll failed: ${result.failures.join(", ")}`);
    }
    if (result.lastRun !== lastRun) await this.#state.storage.put(DUE_STATE_KEY, result.lastRun);

    await this.#state.storage.setAlarm(Date.now() + POLL_ALARM_MS);
  }

  /** Returns true if it had to put the alarm back, which is the only interesting outcome. */
  async #ensureAlarm(): Promise<boolean> {
    if (!this.#room.occupied) return false;
    if ((await this.#state.storage.getAlarm()) !== null) return false;
    await this.#state.storage.setAlarm(Date.now() + POLL_ALARM_MS);
    return true;
  }

  /** Last one out turns off the lights: no alarm, no timer, nothing pending, so the object
   *  hibernates and then evicts and the idle sky costs nothing. */
  async #onMaybeEmpty(): Promise<void> {
    if (this.#room.occupied) return;
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#state.storage.deleteAlarm();
  }

  #armFlush(ms: number): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#room.flush();
    }, ms);
  }
}

function persist(ws: WebSocket, attachment: Attachment): void {
  try {
    ws.serializeAttachment(attachment);
  } catch {
    // A socket that cannot hold its attachment is a socket that will come back from the
    // next hibernation without presence, and the room closes those with 1012 so the client
    // reconnects. Not worth taking the connection down for right now.
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
