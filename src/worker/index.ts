/**
 * The Worker. Routing, authentication, and the cron trigger. No sky logic.
 *
 * Everything that knows anything about the sky is behind `env.SKY`. This file's whole job
 * is to decide which requests are allowed to reach it.
 */
import { Sky, type Env } from "./sky-do.ts";

export { Sky };

const SKY_NAME = "sidereal";
const MAX_INGEST_REQUEST_BYTES = 256 * 1024;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return secured(methodNotAllowed("GET, HEAD"));
      return secured(new Response(request.method === "HEAD" ? null : "ok", { headers: { "content-type": "text/plain; charset=utf-8" } }));
    }

    if (url.pathname === "/sky") {
      if (request.method !== "GET") return secured(methodNotAllowed("GET"));
      if (!sameOriginWebSocketRequest(request)) return secured(new Response(null, { status: 403 }));
      // Do not clone/wrap a successful 101 response: the Workers WebSocket handle is a
      // non-standard Response field and must be returned intact.
      return sky(env).fetch(rewrite(request, "/sky"));
    }

    if (url.pathname === "/ingest") {
      if (request.method !== "POST") return secured(methodNotAllowed("POST"));
      if (!authorized(request, env)) return secured(new Response(null, { status: 401 }));
      const contentLength = request.headers.get("Content-Length");
      if (contentLength !== null) {
        const bytes = Number(contentLength);
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_INGEST_REQUEST_BYTES) {
          return secured(new Response("payload too large", { status: 413 }));
        }
      }
      return secured(await sky(env).fetch(rewrite(request, "/ingest")));
    }

    if (url.pathname === "/stats") {
      if (request.method !== "GET" && request.method !== "HEAD") return secured(methodNotAllowed("GET, HEAD"));
      if (!authorized(request, env)) return secured(new Response(null, { status: 401 }));
      const response = await sky(env).fetch(rewrite(request, "/stats"));
      if (request.method === "HEAD") return secured(new Response(null, response));
      return secured(response);
    }

    return secured(new Response("not found", { status: 404 }));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sky(env)
        .fetch("https://sidereal.internal/tick")
        .then(() => undefined)
        .catch((error: unknown) => {
          // Do not serialize request data or secrets into the log. A stable class/message is
          // enough to identify a failed watchdog without dumping arbitrary objects.
          const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
          console.error("sidereal: watchdog tick failed", message);
        }),
    );
  },
};

function sky(env: Env): DurableObjectStub {
  return env.SKY.get(env.SKY.idFromName(SKY_NAME));
}

function rewrite(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url, request);
}

/** Reject cross-site browser WebSocket upgrades while preserving CLI/native clients that do
 * not send Origin. This is the enforcement counterpart to the same-origin deployment design. */
function sameOriginWebSocketRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const target = new URL(request.url);
    return source.protocol === target.protocol && source.host === target.host;
  } catch {
    return false;
  }
}

function authorized(request: Request, env: Env): boolean {
  const expected = env.INGEST_TOKEN;
  if (!expected) return false;

  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;

  return timingSafeEqual(header.slice("Bearer ".length), expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function methodNotAllowed(allow: string): Response {
  return new Response("method not allowed", { status: 405, headers: { Allow: allow } });
}

function secured(response: Response): Response {
  const next = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) next.headers.set(name, value);
  return next;
}
