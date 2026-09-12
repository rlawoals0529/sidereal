# src/ui dependencies

**Runtime: none.** Nothing in this directory adds a package to `package.json`. The interface is
plain TypeScript against the DOM, styled with the vendored yozora tokens.

That is a choice rather than an accident. What a framework would buy here is reconciliation, and
there are five panels whose updates are each one text node or one attribute. What it would cost
is the thing this page is: a tab somebody leaves open for eight hours beside a WebGL canvas that
already owns the frame budget.

## What it uses that it did not write

| Path | What for |
| --- | --- |
| `src/lib/theme.ts` | `DEFAULT_THEME` and `createThemeStore`, for the palette picker |
| `src/theme/palettes.css` | all fifteen palettes, scoped to `[data-theme]` |
| `src/theme/palettes.json` | the manifest the picker renders from, read as text |
| `src/theme/base.css`, `type.css` | structure and the type pairing |
| `src/shared/event.ts`, `protocol.ts` | the wire and the event shape |
| `e2e/contrast-probe.ts` | the contrast sweep reads computed styles with this |

All of those are vendored or shared and are **never edited here**. The palette manifest is read
with vite's `?raw` suffix and parsed, rather than imported as JSON, because this repo typechecks
without `resolveJsonModule` and a file that only works under one of the two toolchains is a trap
for whoever runs the other.

## The seam to `src/sky`

No panel imports the renderer. `src/ui/ports.ts` states what this interface needs from one, and
`src/ui/sky-adapter.ts` is the single file that knows both shapes. `src/worker/` is not imported
at all: the socket is spoken to through `ClientMessage` and `ServerMessage` and nothing else.

**One thing on the port has nowhere to land yet.** `highlight(id)` rings a light so a keyboard
user can see which star their cursor is on, and `src/sky` exposes no way to do it, so the
adapter drops the call. What would close it is either `highlight(id: string | null)` on `Sky`, or
a `locate(id): {x, y} | null` returning the CSS pixel a light was drawn at, which would let this
side draw the ring itself. Until then a keyboard user keeps the register selection and the
evidence panel and loses only the pointer back into the canvas.

Two mismatches are already resolved in the adapter rather than worked around in the panels: the
renderer focuses a visitor by id where this page only knows "me" (the id is kept from
`welcome`), and it reads its palette from the `data-theme` cascade rather than from an argument,
so the picker setting the attribute is the whole update and there is no second path to it.

## Dev-only, for the contrast sweep

| Package | Why | Needed by |
| --- | --- | --- |
| `playwright` | drives a real Chromium, so contrast is measured from computed styles and the keyboard is exercised through real focus | `test/ui/contrast-sweep.mjs`, `test/ui/keyboard-walk.mjs` |

**Not added to `package.json`,** because `npm test` and `tsc --noEmit` must stay green on a
checkout that has not installed a browser. The sweep is run on demand:

```
npm i -D playwright && npx playwright install chromium
node test/ui/contrast-sweep.mjs
node test/ui/contrast-sweep.mjs --self-test    # plants a failing colour, must exit 1
node test/ui/keyboard-walk.mjs
```

Both scripts stand up their own dev server and drive the page through a fake `WebSocket` that
speaks real `ServerMessage` frames. Nothing in `src/ui/` knows they exist: there is no test mode
and no seeded-data path in the shipped page, because a page that can invent a light is a page
that has broken this project's one rule somewhere a reviewer will not look.

`keyboard-walk.mjs` is a walk rather than a rule scan on purpose. A rule scan checks markup; what
makes a page like this unusable is behaviour a linter cannot see - a list that reorders under the
cursor, sixty-four tab stops to get past a feed, a focus ring clipped by its own scroller.

`PLAYWRIGHT_MODULE=/path/to/playwright` points it at an install elsewhere.

The sweep is the second of two contrast checks and neither replaces the other. `src/ui/contrast.ts`
plus `test/ui/contrast.test.ts` check the token pairings this interface claims to use, in
milliseconds, with no browser. The sweep checks where those colours actually landed, which is the
only way to catch a pairing the manifest does not know about.
