# Dependencies this slice needs

`package.json` is not this slice's to edit, so what it would have added is written down
here instead. Nothing in `src/worker/` imports anything outside the repo today, so the
worker builds and the tests run with the tree exactly as it is.

## Required to deploy

| Package | Version used | Why |
|---|---|---|
| `wrangler` | 4.131.1 | Build, `wrangler dev`, `wrangler deploy`, `wrangler secret`. Run via `npx` today, so it is not installed. |

Verified with `npx wrangler@4.131.1 deploy --dry-run`, which builds the worker and resolves
the bindings without publishing anything.

## Worth adding, not required

| Package | Why | What it replaces |
|---|---|---|
| `@cloudflare/workers-types` | The real runtime types. | `src/worker/cf.d.ts`, which is a hand-written declaration of exactly the platform API this slice uses. Delete that file and add `"@cloudflare/workers-types"` to `compilerOptions.types` in `tsconfig.json` in the same change, or the globals will be declared twice. |
| `@cloudflare/vitest-pool-workers` | Runs tests inside `workerd`, so the hibernation path itself becomes testable rather than only the logic on top of it. | Nothing. It would sit alongside `test/worker/room.test.ts`, not replace it. It needs its own vitest config and a `defineWorkersConfig` pool entry, and it pulls `wrangler` in as a real dependency. |

The current suite deliberately does not use the pool. The reasoning is at the top of
`test/worker/room.test.ts`; briefly, a test dependency installed but not declared would be
green here and red on a clean `npm ci`, and a suite that only passes on the machine that
wrote it is worse than no suite because it reports success.

What the pool would add, and what is therefore untested right now: that `acceptWebSocket`
is reached on the upgrade path, that a 101 carries the client half of the pair, that an
attachment genuinely survives an eviction, and that the alarm fires. Those are runtime
obligations rather than decisions, and they belong in a `wrangler dev` smoke test.

## Configuration

`INGEST_TOKEN` is a **secret**, not a var. There is no `vars` block in `wrangler.jsonc`
because a var is committed here in plaintext.

```
npx wrangler secret put INGEST_TOKEN          # deployed
echo 'INGEST_TOKEN = "local-dev-token"' > .dev.vars   # local, gitignored
```

Auth fails closed: with no token configured, `/ingest` and `/stats` return 401 for
everything. A missing secret must not mean "no authentication required".
