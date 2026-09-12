/**
 * Every bound the sky enforces, in one file, each with the reason it exists.
 *
 * This file is the backpressure policy. It is written down here rather than spread across
 * the call sites because the failure mode being defended against is a *combination*: N
 * clients times M events times one frame each. Any single number looks harmless on its
 * own, and the product is what falls over.
 *
 * ## The thing this platform does not give you
 *
 * workerd does not implement `WebSocket.bufferedAmount` (cloudflare/workerd#988). There is
 * no send queue depth to read, no drain event, no way at all to ask "is this client
 * keeping up". Any design here that claims to detect a slow client is guessing.
 *
 * So the policy is **bound the source, not the sink**. The server never decides how much
 * to send based on how a client is coping, because it cannot know. It decides based on
 * limits it fixed in advance. A slow client's kernel buffer then fills at a rate we chose,
 * and the runtime closes it for us and calls `webSocketClose`. The one thing we must never
 * do is let a client's behaviour, or a feed's, make the server allocate.
 */

/**
 * How often a batch of world events leaves the server, in milliseconds.
 *
 * 250 ms, for three reasons that happen to agree.
 *
 * Perception: the client animates a meteor over roughly a second, so the only question is
 * whether a light appears late enough to feel disconnected from its own arrival. 250 ms is
 * comfortably under that. A 16 ms frame would be indistinguishable to a viewer and sixteen
 * times the wake-ups.
 *
 * Framing: the Wikipedia feed alone runs around 100 events a second globally. At 250 ms
 * that is ~25 events sharing one frame's envelope, so framing is a few percent of the
 * payload. Per-event framing would make it most of it, which is the whole reason
 * `protocol.ts` says events arrive batched.
 *
 * Cost: outgoing WebSocket messages are not billed as requests, so tick rate does not cost
 * requests. What it costs is *duration*, because a Durable Object with a pending timer
 * cannot hibernate. That is why the flush timer is armed only when something is queued and
 * is never a repeating interval. See `room.ts`.
 */
export const TICK_MS = 250;

/**
 * How many world events may sit queued before the oldest start being dropped.
 *
 * 512 at ~100 events/sec is about five seconds of backlog. Past five seconds a meteor is a
 * claim about a "now" that has gone, and the sky's one rule is that every light traces to
 * something that happened; a light five seconds adrift is still true, but it is no longer
 * the truth the viewer is being shown. So dropping the oldest is not merely the cheap
 * choice, it is the correct one. Dropping the newest instead would park the sky permanently
 * behind reality and it would never catch up.
 */
export const QUEUE_CAP = 512;

/**
 * How many events may leave in a single frame, regardless of queue depth.
 *
 * This is what makes the per-tick cost O(clients x 64) instead of O(clients x backlog).
 * 64 at 4 Hz drains 256 events/sec, comfortably above the ~100/sec the feeds produce, so a
 * steady stream never backs up and a burst - the once-a-minute cron sip, say - is spread
 * over the next few ticks instead of arriving as one wall of light. One mechanism, two
 * jobs: it is the backpressure valve and it is also what makes a minute-granular poll look
 * continuous.
 */
export const MAX_EVENTS_PER_TICK = 64;

/**
 * How many sockets one sky will hold.
 *
 * The platform's own ceiling is 32,768 per Durable Object, which is not a useful bound for
 * us: presence is broadcast to everyone, so a join storm is O(N^2) messages, and at 32k
 * that number is not a number anyone wants. 200 keeps the worst case computable and is far
 * beyond what a portfolio sky will ever hold. Past it the upgrade is refused with 503 and
 * a Retry-After, which is a real answer. Silently accepting and then degrading for everyone
 * already in the room is not.
 */
export const MAX_OCCUPANTS = 200;

/** Longest a client frame may be. Anything larger is ignored unparsed; the largest legal
 *  `ClientMessage` is a hello of a few dozen bytes. */
export const MAX_CLIENT_FRAME_BYTES = 1024;

/**
 * Shortest gap between two `move` broadcasts from the same occupant.
 *
 * Gaze is the one client message that arrives at animation rate, and every one of them is
 * amplified to N sockets. Without this, one client sending `look` at 60 Hz makes the server
 * do 60 x N sends a second on its say-so, which is the definition of letting the client
 * decide how much work we do. Excess looks still update the stored angles, they just do not
 * get their own broadcast: gaze is a continuous signal where only the latest value means
 * anything, so an intermediate frame is worth nothing and nothing is lost by dropping it.
 */
export const LOOK_MIN_INTERVAL_MS = 50;

/**
 * How long a socket may stay connected without saying `hello`.
 *
 * A connection that never introduces itself is invisible to everyone else but still holds
 * an occupancy slot, which is a cheap way to fill the room without ever appearing in it.
 * Swept on the next attach, which is exactly when it matters: the moment a real visitor is
 * about to be refused.
 */
export const HELLO_DEADLINE_MS = 10_000;

/** Largest ingest batch accepted in one request. A feed that has more than this to say has
 *  gone wrong, and an unbounded array is an unbounded allocation. */
export const MAX_INGEST_BATCH = 256;

/** Field caps on ingested events. `label` and `source` are strings from the open internet
 *  by way of a normalizer; they are the allocation vector on the ingest path. */
export const MAX_LABEL_CHARS = 200;
export const MAX_SOURCE_CHARS = 64;
export const MAX_ID_CHARS = 128;

/**
 * How often the poll alarm fires while the room is occupied.
 *
 * The alarm is a clock, not a schedule: it wakes every 5 s and each registered feed decides
 * whether it is due. 5 s is well under the fastest useful cadence and costs one storage
 * write per fire - about 17k writes a day if someone watches the sky for twenty-four hours
 * straight, against a free-plan allowance of 100k. It is not armed at all when the room is
 * empty.
 */
export const POLL_ALARM_MS = 5_000;

/**
 * The auto-response pair, installed once per Durable Object.
 *
 * `setWebSocketAutoResponse` is answered by the runtime without waking the object, so a
 * client can hold a connection open through a proxy that kills idle sockets and cost us
 * nothing at all. It is the one keepalive that does not defeat hibernation, and hibernation
 * while somebody sits there with the tab open all day is the entire reason this runs on
 * Durable Objects. It is deliberately not part of `ClientMessage`: a client that never
 * sends it is fine, it just does not get the free keepalive.
 */
export const PING = "ping";
export const PONG = "pong";
