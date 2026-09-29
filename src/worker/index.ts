/**
 * The Worker. Routing, authentication, and the cron trigger. No sky logic.
 *
 * Everything that knows anything about the sky is behind `env.SKY`. This file's whole job
 * is to decide which requests are allowed to reach it.
 */
import { Sky, type Env } from "./sky-do.ts";

export { Sky };

const SKY_NAME = "sidereal";
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;

    if (url.pathname === "/health") {
      response = new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
      return secure(response);
    }

    if (url.pathname === "/sky") {
      // Browser WebSocket handshakes include Origin. Reject cross-site upgrades so another
      // website cannot silently consume room capacity or drive presence on a visitor's behalf.
      if (!sameOriginRequest(request, url)) {
        return secure(new Response("cross-site websocket denied", { status: 403 }));
      }
      // A 101 response carries Cloudflare's WebSocket handle outside the standard Response
      // type. Do not reconstruct it just to add HTTP headers; the origin check is the relevant
      // browser boundary for this path.
      return sky(env).fetch(rewrite(request, "/sky"));
    }

    if (url.pathname === "/ingest") {
      if (!authorized(request, env)) {
        return secure(new Response(null, { status: 401 }));
      }
      if (request.method !== "POST") {
        return secure(new Response("method not allowed", { status: 405, headers: { Allow: "POST" } }));
      }
      response = await sky(env).fetch(rewrite(request, "/ingest"));
      return secure(response);
    }

    if (url.pathname === "/stats") {
      if (!authorized(request, env)) return secure(new Response(null, { status: 401 }));
      if (request.method !== "GET") {
        return secure(new Response("method not allowed", { status: 405, headers: { Allow: "GET" } }));
      }
      response = await sky(env).fetch(rewrite(request, "/stats"));
      return secure(response);
    }

    return secure(new Response("not found", { status: 404 }));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sky(env)
        .fetch("https://sidereal.internal/tick")
        .then(() => undefined)
        .catch((error: unknown) => {
          // Keep logs useful without serializing request data, tokens, or response bodies.
          console.error("sidereal: watchdog tick failed", error instanceof Error ? error.message : "unknown error");
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

function sameOriginRequest(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // Non-browser clients do not necessarily send Origin.
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
