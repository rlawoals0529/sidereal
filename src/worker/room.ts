/**
 * The sky's logic, with no Cloudflare in it.
 *
 * The Durable Object in `sky-do.ts` is a shell: it accepts sockets, hands bytes to this
 * class, and owns one timer. Everything that decides anything lives here.
 *
 * That split is here for a design reason before it is here for a testing reason. The
 * hibernation API has an awkward property - the object is destroyed and reconstructed
 * underneath you while the sockets stay open - and the only safe way to live with that is
 * for the room's entire state to be either (a) derivable from the live sockets or (b)
 * something we are happy to lose. Writing the room as a class that can be *constructed from
 * a list of sockets* forces that question to be answered for every field, instead of it
 * being answered by accident the first time a deploy evicts the object in production.
 *
 * Presence is (a): it rides on the socket via `serializeAttachment`. The event queue is (b):
 * a meteor that was queued before a hibernation is by definition stale, and `limits.ts`
 * already says a stale meteor gets dropped. So losing the queue is not a bug to work
 * around, it is the policy arriving early.
 *
 * The testing benefit falls out of that: the room is deterministic given an injected clock,
 * so "the queue drops oldest under pressure" is a direct assertion rather than something
 * inferred from timing under a running worker.
 */
import type { SkyEvent } from "../shared/event.ts";
import type { Presence, ServerMessage } from "../shared/protocol.ts";
import { isPalette } from "./palettes.ts";
import { clampAlt, parseClientMessage, validateIngest, wrapAz } from "./validate.ts";
import {
  HELLO_DEADLINE_MS,
  LOOK_MIN_INTERVAL_MS,
  MAX_CLIENT_FRAME_BYTES,
  MAX_EVENTS_PER_TICK,
  MAX_OCCUPANTS,
  QUEUE_CAP,
  TICK_MS,
} from "./limits.ts";

/**
 * What the room needs from a connection.
 *
 * A Cloudflare `WebSocket` satisfies this structurally, so the Durable Object passes its
 * sockets straight in with no adapter. That matters more than it looks: an adapter object
 * created per call would give a different identity every time `webSocketMessage` fired, and
 * the room keys occupants by identity. A wrapper here would have been a use-after-hibernate
 * bug wearing a nice interface.
 */
export interface SkyClient {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Presence, plus the bookkeeping only the server needs. */
type Occupant = Presence & {
  /** False between the socket opening and `hello` arriving. Nobody else can see them yet. */
  joined: boolean;
  /** When the socket attached, used only for the handshake deadline. */
  attachedAt: number;
  /** When this occupant's gaze was last broadcast, for the rate limit. */
  lastMoveAt: number;
};

/** What rides on the socket across a hibernation. Kept flat and small on purpose: the
 *  attachment has a 16 KB ceiling and nothing here needs to approach it. */
export type Attachment = Pick<
  Occupant,
  "id" | "palette" | "az" | "alt" | "focused" | "since" | "joined"
>;

export type RoomOptions = {
  /** Injected so tests do not have to wait for real time to pass. */
  now?: () => number;
  /**
   * Ask the shell to call `flush()` in `ms`. Called only when a flush is not already
   * pending, so the shell never has to de-duplicate timers.
   *
   * This is a callback rather than the room owning a `setInterval` because a pending timer
   * is precisely what stops a Durable Object hibernating. An interval would mean the sky
   * never sleeps even when empty, which would cost the whole free-plan duration budget to
   * broadcast nothing to nobody.
   */
  scheduleFlush: (ms: number) => void;
};

export type RoomStats = {
  occupants: number;
  joined: number;
  queued: number;
  /** Events discarded because the queue was full. Never silent: see `sky-do.ts` /stats. */
  dropped: number;
  /** Ingested events whose id was already queued. A replayed batch is not an error. */
  duplicates: number;
  /** Ingested payloads that failed validation. */
  rejected: number;
  /** Presence or event frames the runtime refused. Each one costs a socket. */
  sendFailures: number;
};

export class SkyRoom {
  readonly #now: () => number;
  readonly #scheduleFlush: (ms: number) => void;

  /** Insertion-ordered, which is what makes `others` stable across reconnects. */
  readonly #clients = new Map<SkyClient, Occupant>();

  /**
   * The world-event queue, oldest first.
   *
   * A plain array with `shift()` rather than a ring buffer. `shift()` is O(n) and n is
   * capped at 512, so the cost is a memmove of half a kilobyte of pointers a few times a
   * second - genuinely nothing next to the JSON encode that follows it, and a ring buffer
   * would have been three more places for an off-by-one to hide.
   */
  #queue: SkyEvent[] = [];

  /**
   * Ids currently in `#queue`, so a replayed batch cannot double-render - `event.ts`
   * promises stable source ids exactly so this is possible.
   *
   * It tracks the queue and nothing more. The obvious version of this is a Set of every id
   * ever seen, and that is an unbounded allocation driven by an external feed, which is the
   * one thing `limits.ts` says we never do. Bounded by QUEUE_CAP by construction, because
   * every add and every removal here is paired with one on the queue.
   */
  readonly #queuedIds = new Set<string>();

  #flushPending = false;
  #dropped = 0;
  #duplicates = 0;
  #rejected = 0;
  #sendFailures = 0;

  constructor(options: RoomOptions) {
    this.#now = options.now ?? Date.now;
    this.#scheduleFlush = options.scheduleFlush;
  }

  get occupancy(): number {
    return this.#clients.size;
  }

  /** True while anyone at all is watching, which is the only time the sky costs anything. */
  get occupied(): boolean {
    return this.#clients.size > 0;
  }

  stats(): RoomStats {
    let joined = 0;
    for (const o of this.#clients.values()) if (o.joined) joined++;
    return {
      occupants: this.#clients.size,
      joined,
      queued: this.#queue.length,
      dropped: this.#dropped,
      duplicates: this.#duplicates,
      rejected: this.#rejected,
      sendFailures: this.#sendFailures,
    };
  }

  /**
   * Rebuild the room from sockets that outlived the previous instance.
   *
   * An attachment whose shape we do not recognise closes the socket with 1012 rather than
   * throwing. The throw would happen in the constructor, which means it would happen again
   * on the client's automatic reconnect, which means one bad deploy would brick the sky
   * permanently rather than for one visitor for one round trip.
   */
  rehydrate(entries: Iterable<readonly [SkyClient, unknown]>): void {
    const now = this.#now();
    for (const [client, raw] of entries) {
      const attachment = readAttachment(raw);
      if (!attachment) {
        this.#closeQuietly(client, 1012, "restart");
        continue;
      }
      this.#clients.set(client, {
        ...attachment,
        attachedAt: now,
        lastMoveAt: 0,
      });
    }
  }

  /**
   * A socket has opened. Assigns an id and sends `welcome`.
   *
   * Returns false if the room is full, in which case the caller must refuse the upgrade -
   * the room has not registered the socket and will never hear about it again.
   */
  attach(client: SkyClient): boolean {
    this.#sweepUnannounced();
    if (this.#clients.size >= MAX_OCCUPANTS) return false;

    const now = this.#now();
    const occupant: Occupant = {
      id: this.#mintId(),
      // Carrying a placeholder palette until `hello` is what lets `others` stay a list of
      // real `Presence` values with no optional fields in it. An unannounced occupant is
      // filtered out by `joined`, so this value is never seen by anyone.
      palette: "",
      az: 0,
      alt: 0,
      focused: false,
      since: now,
      joined: false,
      attachedAt: now,
      lastMoveAt: 0,
    };
    this.#clients.set(client, occupant);

    this.#send(client, {
      t: "welcome",
      you: occupant.id,
      others: this.#others(client),
      serverNow: now,
    });
    return true;
  }

  /** A socket has closed, for any reason. Idempotent, because `webSocketClose` and
   *  `webSocketError` can both fire for one socket and the second must be a no-op. */
  detach(client: SkyClient): void {
    const occupant = this.#clients.get(client);
    if (!occupant) return;
    this.#clients.delete(client);
    if (occupant.joined) this.#broadcast({ t: "leave", id: occupant.id }, client);
  }

  /** One frame from a client. Returns the attachment to persist, or null if nothing about
   *  this occupant's durable state changed - the shell only pays for a write when there is
   *  something to write. */
  handleMessage(client: SkyClient, raw: string): Attachment | null {
    // Length first, before the parse. A megabyte of JSON costs a megabyte of parsing to
    // discover it was a megabyte of JSON.
    if (raw.length > MAX_CLIENT_FRAME_BYTES) return null;

    const occupant = this.#clients.get(client);
    if (!occupant) return null;

    const message = parseClientMessage(raw);
    if (!message) return null;

    switch (message.t) {
      case "hello":
        return this.#onHello(client, occupant, message.palette);
      case "look":
        return this.#onLook(client, occupant, message.az, message.alt);
      case "focus":
        return this.#onFocus(client, occupant, message.on);
    }
  }

  #onHello(client: SkyClient, occupant: Occupant, palette: string): Attachment | null {
    // A second hello is ignored rather than treated as a palette change. The protocol has
    // no repalette message, and if it did, replaying `join` would be a broadcast amplifier
    // a client could pull on demand.
    if (occupant.joined) return null;

    if (!isPalette(palette)) {
      // Loud, not silent. A client speaking a palette we do not have is a client built
      // against a different allowlist, and letting it sit in the room invisible forever is
      // a worse outcome than telling it so.
      this.detach(client);
      this.#closeQuietly(client, 1008, "palette");
      return null;
    }

    occupant.palette = palette;
    occupant.joined = true;
    this.#broadcast({ t: "join", who: toPresence(occupant) }, client);
    return toAttachment(occupant);
  }

  #onLook(client: SkyClient, occupant: Occupant, az: number, alt: number): Attachment | null {
    // Finiteness before clamping, always. See `validate.ts`.
    if (!Number.isFinite(az) || !Number.isFinite(alt)) return null;

    occupant.az = wrapAz(az);
    occupant.alt = clampAlt(alt);
    if (!occupant.joined) return null;

    const now = this.#now();
    if (now - occupant.lastMoveAt < LOOK_MIN_INTERVAL_MS) {
      // Rate limited. The angles are already stored, so the next accepted look carries the
      // newer value and nothing is lost. Deliberately not persisted either: paying a
      // storage write for a frame nobody is being sent would make the cheap path the
      // expensive one.
      return null;
    }
    occupant.lastMoveAt = now;
    this.#broadcast({ t: "move", id: occupant.id, az: occupant.az, alt: occupant.alt }, client);
    return toAttachment(occupant);
  }

  #onFocus(client: SkyClient, occupant: Occupant, on: boolean): Attachment | null {
    if (!occupant.joined) return null;
    // Unchanged means no broadcast. Otherwise `focus:true` repeated is another free way to
    // make the server do N sends per message.
    if (occupant.focused === on) return null;
    occupant.focused = on;
    this.#broadcast({ t: "focus", id: occupant.id, on }, client);
    return toAttachment(occupant);
  }

  /**
   * Take world events from a feed.
   *
   * Nothing is queued for an empty sky. Not an optimisation - there is no such thing as a
   * meteor that was missed while nobody was looking, and holding a backlog for a room with
   * no one in it is how a service that should cost nothing when idle ends up costing
   * something when idle.
   */
  ingest(payload: unknown): { accepted: number; dropped: number; rejected: number } {
    const { events, rejected, truncated } = validateIngest(payload);
    this.#rejected += rejected + truncated;

    if (!this.occupied) {
      return { accepted: 0, dropped: events.length, rejected: rejected + truncated };
    }

    let accepted = 0;
    let dropped = 0;
    for (const event of events) {
      if (this.#queuedIds.has(event.id)) {
        this.#duplicates++;
        continue;
      }
      this.#queue.push(event);
      this.#queuedIds.add(event.id);
      accepted++;

      // Drop oldest, one per push, so the queue can never be over the cap even for an
      // instant. Trimming after the loop instead would let a 10,000-event batch exist in
      // memory in full before being cut down, which is the allocation this cap exists to
      // stop.
      if (this.#queue.length > QUEUE_CAP) {
        const evicted = this.#queue.shift();
        if (evicted) this.#queuedIds.delete(evicted.id);
        this.#dropped++;
        dropped++;
      }
    }

    if (this.#queue.length > 0) this.#requestFlush();
    return { accepted, dropped, rejected: rejected + truncated };
  }

  /**
   * Send one tick of the world.
   *
   * Called by the shell's timer. Encodes the frame once and sends the same string to every
   * socket: the per-tick cost is one JSON encode plus N writes, not N encodes. At 25 events
   * and 200 occupants that is the difference between one encode and two hundred, which is
   * the actual hot loop in this whole service.
   */
  flush(): void {
    this.#flushPending = false;

    const take = Math.min(this.#queue.length, MAX_EVENTS_PER_TICK);
    const batch = this.#queue.splice(0, take);
    for (const event of batch) this.#queuedIds.delete(event.id);

    if (this.occupied) {
      const frame = JSON.stringify({ t: "events", batch, serverNow: this.#now() });
      for (const client of [...this.#clients.keys()]) this.#sendFrame(client, frame);
    }

    // Anything left over rides the next tick. This is what turns a once-a-minute cron sip
    // into something that looks continuous instead of a wall of light followed by silence.
    if (this.#queue.length > 0) this.#requestFlush();
  }

  #requestFlush(): void {
    if (this.#flushPending) return;
    this.#flushPending = true;
    this.#scheduleFlush(TICK_MS);
  }

  #others(except: SkyClient): Presence[] {
    const others: Presence[] = [];
    for (const [client, occupant] of this.#clients) {
      if (client === except || !occupant.joined) continue;
      others.push(toPresence(occupant));
    }
    return others;
  }

  /** Presence deltas go to every attached socket, including ones that have not said hello
   *  yet: they were handed `others` in their `welcome` and that list has to stay true, or
   *  a visitor who joined during someone else's handshake is invisible to them forever. */
  #broadcast(message: ServerMessage, except: SkyClient): void {
    const frame = JSON.stringify(message);
    for (const client of [...this.#clients.keys()]) {
      if (client === except) continue;
      this.#sendFrame(client, frame);
    }
  }

  #send(client: SkyClient, message: ServerMessage): void {
    this.#sendFrame(client, JSON.stringify(message));
  }

  /**
   * The only place a send happens.
   *
   * A throw here means the socket is already gone - the runtime gives no send-queue depth
   * (see `limits.ts`), so a failed write is the only backpressure signal that exists at
   * all, and the honest reading of it is "this connection is over" rather than "slow down".
   * Evicting on the spot also stops a dead socket being retried on every subsequent tick
   * forever.
   */
  #sendFrame(client: SkyClient, frame: string): void {
    try {
      client.send(frame);
    } catch {
      this.#sendFailures++;
      this.detach(client);
    }
  }

  #closeQuietly(client: SkyClient, code: number, reason: string): void {
    try {
      client.close(code, reason);
    } catch {
      // Already closed. Nothing to do and nothing worth saying.
    }
  }

  /** Reclaim sockets that opened and never introduced themselves. Run on attach, because
   *  that is the moment their squatting would cost a real visitor a slot. */
  #sweepUnannounced(): void {
    if (this.#clients.size < MAX_OCCUPANTS) return;
    const cutoff = this.#now() - HELLO_DEADLINE_MS;
    for (const [client, occupant] of [...this.#clients]) {
      if (!occupant.joined && occupant.attachedAt < cutoff) {
        this.#clients.delete(client);
        this.#closeQuietly(client, 1008, "no hello");
      }
    }
  }

  /**
   * An id with nothing of the connection in it.
   *
   * `protocol.ts` is explicit that this must not be derived from the connection, and the
   * reason is worth keeping in front of whoever changes this next: anything stable about
   * the socket - an index, a hash of the IP, a counter - makes two visits by the same
   * person linkable by anyone else in the room. There is no account here and there is
   * nothing to link, and that is a property to keep rather than an accident to preserve.
   *
   * 64 bits from the CSPRNG. The collision check is cheap and the room is small, but an id
   * collision would merge two people into one light, so it is checked rather than assumed.
   */
  #mintId(): string {
    const taken = new Set<string>();
    for (const o of this.#clients.values()) taken.add(o.id);
    for (let attempt = 0; attempt < 8; attempt++) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      let id = "";
      for (const b of bytes) id += b.toString(16).padStart(2, "0");
      if (!taken.has(id)) return id;
    }
    // Eight collisions on 64 bits does not happen; if it somehow does, a duplicate id is a
    // worse outcome than a loud one.
    throw new Error("could not mint a unique occupant id");
  }
}

function toPresence(occupant: Occupant): Presence {
  return {
    id: occupant.id,
    palette: occupant.palette,
    az: occupant.az,
    alt: occupant.alt,
    focused: occupant.focused,
    since: occupant.since,
  };
}

function toAttachment(occupant: Occupant): Attachment {
  return {
    id: occupant.id,
    palette: occupant.palette,
    az: occupant.az,
    alt: occupant.alt,
    focused: occupant.focused,
    since: occupant.since,
    joined: occupant.joined,
  };
}

/** Validate an attachment the same way a client frame is validated. It was written by a
 *  previous version of this code, which is to say by software we no longer have. */
function readAttachment(raw: unknown): Attachment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a["id"] !== "string" || a["id"].length === 0) return null;
  if (typeof a["palette"] !== "string") return null;
  if (typeof a["az"] !== "number" || !Number.isFinite(a["az"])) return null;
  if (typeof a["alt"] !== "number" || !Number.isFinite(a["alt"])) return null;
  if (typeof a["focused"] !== "boolean") return null;
  if (typeof a["since"] !== "number" || !Number.isFinite(a["since"])) return null;
  if (typeof a["joined"] !== "boolean") return null;
  return {
    id: a["id"],
    palette: a["palette"],
    az: wrapAz(a["az"]),
    alt: clampAlt(a["alt"]),
    focused: a["focused"],
    since: a["since"],
    joined: a["joined"],
  };
}
