# Sidereal security baseline

Sidereal is a public realtime Cloudflare Worker with a public same-origin WebSocket room and two authenticated internal routes (`/ingest`, `/stats`). It has no user accounts, password database, paid AI endpoint, file uploads, or per-user private records, so auth/RLS/CSRF/upload controls that depend on those features are not applicable today.

## Worker boundary

- `/ingest` and `/stats` fail closed unless `INGEST_TOKEN` is configured and the correct Bearer token is supplied. The token belongs in Wrangler/Cloudflare secrets and `.dev.vars`, never in `vars` or source.
- Bearer-token comparison is constant-time.
- Browser WebSocket upgrades to `/sky` must be same-origin. Native/CLI clients that do not send `Origin` remain supported.
- Route methods are explicit; authenticated ingest is POST-only and request size is bounded.
- Client WebSocket frames, event batches, room occupancy, queue size, event rate, and presence broadcasts are bounded by the protocol/limits layer.
- No wildcard CORS is enabled.

## Browser and transport boundary

Static assets use a Cloudflare Workers `_headers` policy with CSP, clickjacking prevention, MIME-sniffing protection, permissions policy, referrer policy, cross-origin isolation headers, and HSTS. Worker-generated HTTP responses receive matching defensive headers where applicable.

Cloudflare serves production over HTTPS. Keep HTTPS redirect/HSTS behavior enabled at the account/zone layer as well.

## Secrets and logs

- `.env*`, `.dev.vars`, private-key/certificate formats, Wrangler state, logs, dependencies, and build output are ignored by git.
- Logs must not include Authorization headers, the ingest token, browser messages, or raw request bodies. Errors should be reduced to safe type/message information.
- Any real token that reaches GitHub or a public log must be revoked/rotated immediately; removing the latest copy is not enough if history retains it.

## Dependencies and deployment

CI installs from the lockfile, audits dependencies for high/critical vulnerabilities, typechecks, tests, builds, performs a Wrangler dry-run, runs browser accessibility/contrast checks, and deploys only after both gates pass. Dependabot monitors npm and GitHub Actions dependencies.

Cloudflare usage alerts/billing limits, edge rate limiting, API token scope/rotation, and account-level secret management are deployment controls outside this repository.

## Future features

Before adding accounts, databases, uploads, webhooks, or AI:

- add server-side auth/authorization on every private route and object-ownership tests;
- use parameterized queries and RLS where the chosen database supports it;
- add CSRF protection for cookie-authenticated mutations;
- keep storage private and validate uploads by size/type/content;
- verify webhook signatures;
- add provider-specific AI rate/spend limits and prompt-injection/tool allowlists.
