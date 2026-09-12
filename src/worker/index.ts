/**
 * The Worker. Routing, authentication, and the cron trigger. No sky logic.
 *
 * Everything that knows anything about the sky is behind `env.SKY`. This file's whole job
 * is to decide which requests are allowed to reach it.
 */
import { Sky, type Env } from "./sky-do.ts";

export { Sky };

/**
 * One sky, so one name, so one instance.
 *
 * `idFromName` with a constant is what makes every visitor land in the same object. It is
 * also the thing to look at first if this ever needs to scale: a single Durable Object is a
 * single point of serialisation, and the platform's own ceiling is 32,768 sockets on it.
 * Sharding would be the usual answer and it is not available to us, because "everyone is in
 * the same sky" is the product rather than an implementation detail. So the cap in
 * `limits.ts` is a real cap and the room refuses past it, rather than a number we plan to
 * grow out of.
 */
const SKY_NAME = "sidereal";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/sky") {
      return sky(env).fetch(rewrite(request, "/sky"));
    }

    if (url.pathname === "/ingest") {
      if (!authorized(request, env)) {
        // No body and no hint. A 401 that explains which half was wrong is a 401 that helps
        // whoever is guessing.
        return new Response(null, { status: 401 });
      }
      return sky(env).fetch(rewrite(request, "/ingest"));
    }

    if (url.pathname === "/stats") {
      if (!authorized(request, env)) return new Response(null, { status: 401 });
      return sky(env).fetch(rewrite(request, "/stats"));
    }

    // Everything else is the UI slice's, once it adds an assets binding. Until then a 404
    // here is the honest answer rather than a redirect to something that does not exist.
    return new Response("not found", { status: 404 });
  },

  /**
   * The watchdog, once a minute. See the two-clocks note in `feeds.ts`.
   *
   * It pokes the object and lets the object decide. Doing the occupancy check out here
   * would mean this file knowing what "occupied" means, and it would be a second place that
   * has to agree with the room about when feeds should run.
   *
   * Waking a hibernating object once a minute to be told "nobody is here" costs a few
   * milliseconds of duration, about 1,440 times a day. That is the price of the sky being
   * able to recover from a dropped alarm within sixty seconds, and it is cheap.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sky(env)
        .fetch("https://sidereal.internal/tick")
        .then(() => undefined)
        .catch((error: unknown) => {
          // Swallowed on purpose: a failed watchdog run must not fail the cron invocation,
          // because a failing cron is a cron the platform starts backing off. Logged, so a
          // watchdog that is failing every minute is visible rather than merely quiet.
          console.error("sidereal: watchdog tick failed", error);
        }),
    );
  },
};

function sky(env: Env): DurableObjectStub {
  return env.SKY.get(env.SKY.idFromName(SKY_NAME));
}

/** Durable Object stubs are addressed by URL, so the path has to be restated. Keeping the
 *  original request means method, headers and body ride along unchanged. */
function rewrite(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url, request);
}

/**
 * Bearer auth for the internal routes.
 *
 * Fails closed when `INGEST_TOKEN` is unset. The tempting alternative - no token
 * configured means no auth required - turns a forgotten secret in a fresh environment into
 * a world-writable sky, and it does it silently, which is the worst combination. A
 * misconfigured deploy that ingests nothing is a bug someone notices in a minute.
 *
 * The comparison is constant-time. The timing signal on a short token compared with `===`
 * is small and it is not zero, and there is no reason to leave it there when the fix is
 * eight lines.
 */
function authorized(request: Request, env: Env): boolean {
  const expected = env.INGEST_TOKEN;
  if (!expected) return false;

  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;

  return timingSafeEqual(header.slice("Bearer ".length), expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  // Length is compared first and does leak, which is unavoidable and harmless: the length
  // of a random token is not the secret part of it.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
