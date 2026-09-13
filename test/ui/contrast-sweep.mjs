/**
 * The contrast sweep: the real page, in a real browser, under all fifteen palettes.
 *
 * The unit suite checks the token pairings this interface CLAIMS to use. This one does not take
 * that claim on trust: it drives the page, reads computed styles, and composites the whole
 * ancestor stack, so it sees where a colour actually landed rather than where a manifest says
 * it does. Both are needed. Either one alone has a hole the other covers.
 *
 * It is a `.mjs` script rather than a vitest file on purpose. `@playwright/test` is not a
 * dependency of this repo (see `src/ui/DEPS.md`), and a `.ts` file under `test/` would be pulled
 * into `tsc --noEmit` and fail the typecheck for everybody who has not installed it.
 *
 *   node test/ui/contrast-sweep.mjs
 *   node test/ui/contrast-sweep.mjs --self-test   # plant a failure, prove it goes red
 *
 * `PLAYWRIGHT_MODULE` overrides where playwright is imported from, for a checkout that has it
 * somewhere other than this repo's own node_modules.
 *
 * STATES, not pages. The probe must be called once per distinct state, because a state with the
 * register full has surfaces the empty one does not and neither is a subset of the other. The
 * palette list is one of them for a specific reason: it is hidden with the `hidden` attribute,
 * and anything hidden is invisible to a probe that reads computed styles, so it is opened and
 * measured as a state of its own.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = new URL(".", import.meta.url);
const ROOT = new URL("../../", HERE);
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/`;
const selfTest = process.argv.includes("--self-test");

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { probeContrast, describeFailures } = await import(new URL("../../e2e/contrast-probe.ts", HERE));
const themes = JSON.parse(readFileSync(new URL("src/theme/palettes.json", ROOT), "utf8"));

/**
 * A fake socket, installed before any of the page's own code runs.
 *
 * The sky is empty until a server sends something, and an empty page has almost no surfaces to
 * measure, so a sweep against it would pass by measuring nothing. These are real
 * `ServerMessage` shapes: the point is to reach the states the page has in production, not to
 * invent a mode it does not otherwise have. Nothing in `src/ui/` knows this exists.
 */
const FAKE_SOCKET = () => {
  const now = Date.now();
  const people = [
    { id: "p1", palette: "rain-lantern", az: 12, alt: 30, focused: true, since: now - 900_000 },
    { id: "p2", palette: "sakura-road", az: 200, alt: 10, focused: false, since: now - 60_000 },
  ];
  const events = [
    {
      id: "q1", kind: "quake", at: now - 240_000, lat: 53.1234, lon: 158.61,
      placement: "measured", magnitude: 0.62,
      label: "M4.1, 61 km NNE of Petropavlovsk-Kamchatsky", source: "USGS",
    },
    {
      id: "e1", kind: "edit", at: now - 8_000, lat: 50.45, lon: 30.5234,
      placement: "regional", magnitude: 0.31,
      label: "Kyiv Metro", source: "Wikimedia EventStreams",
    },
    {
      id: "e2", kind: "edit", at: now - 30_000, lat: 35.68, lon: 139.76,
      placement: "regional", magnitude: 0.77,
      label: "Tokyo Metropolitan Government Building", source: "Wikimedia EventStreams",
    },
    {
      id: "o1", kind: "orbit", at: now - 1_000, lat: -12.4, lon: 44.9,
      placement: "measured", magnitude: 1, label: "ISS", source: "Open Notify",
    },
    {
      id: "a1", kind: "aurora", at: now - 120_000, lat: 67.1, lon: -50.2,
      placement: "measured", magnitude: 0.44, label: "Auroral oval, 67 N", source: "NOAA OVATION",
    },
  ];

  class FakeSocket {
    constructor() {
      this.listeners = {};
      window.__socket = this;
      setTimeout(() => {
        this.fire("open");
        this.fire("message", { data: JSON.stringify({ t: "welcome", you: "me", others: people, serverNow: Date.now() }) });
        this.fire("message", { data: JSON.stringify({ t: "events", batch: events, serverNow: Date.now() }) });
      }, 0);
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
    send() {}
    close() { this.fire("close"); }
  }
  window.WebSocket = FakeSocket;
  /** Drop the connection the way a closed laptop lid does, so the offline state is reachable. */
  window.__drop = () => window.__socket.close();
};

// --host 127.0.0.1 explicitly: vite's default binds `localhost`, which on this machine resolves
// to ::1 only, and a browser told to open 127.0.0.1 gets a connection refused with the server
// plainly running and printing that it is ready.
const server = spawn("node_modules/.bin/vite", ["--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: fileURLToPath(ROOT),
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const die = setTimeout(() => reject(new Error("vite did not start")), 30_000);
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) { clearTimeout(die); resolve(); }
  });
});

const browser = await chromium.launch();
const failures = [];
let measured = 0;
let states = 0;
let distinct = 0;

/** One state of the page, prepared by `prepare`, then swept across every palette. */
async function sweep(name, prepare, { width = 1280, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.addInitScript(FAKE_SOCKET);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".entry");
  await prepare(page);

  /**
   * Let every transition finish before reading a single colour.
   *
   * `ui.css` transitions background-color, border-color and color over 140ms, so a probe that
   * measures the moment a state becomes reachable is sampling a frame partway through a
   * crossfade. It reported 4.46:1 against a 4.5 floor on amethyst-yokai in CI and passed on
   * this machine, which is the signature of a race rather than of a colour: the settled value
   * is the one the reader actually sits looking at, and it is the only one worth a verdict.
   *
   * `getAnimations` covers CSS transitions as well as animations. The catch is there because a
   * transition that is interrupted rejects, and an interrupted transition is finished for our
   * purposes. The extra frame afterwards is for the style recalculation that follows.
   */
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => undefined)),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

  if (selfTest) {
    // A check that has never gone red is a check nobody has a reason to believe.
    await page.evaluate(() => {
      const planted = document.createElement("p");
      planted.className = "planted-failure";
      planted.textContent = "planted, must fail";
      planted.style.color = "color-mix(in srgb, var(--fg) 18%, var(--panel))";
      document.querySelector(".panel")?.append(planted);
    });
  }

  const probe = await probeContrast(page, themes);
  if (probe.styles < 8) throw new Error(`${name}: measured only ${probe.styles} styles`);
  if (probe.distinctPalettes < 10) {
    throw new Error(`${name}: only ${probe.distinctPalettes} palettes actually painted`);
  }
  measured += probe.measured;
  distinct = Math.max(distinct, probe.distinctPalettes);
  states++;
  for (const f of probe.failures) failures.push({ ...f, state: name });
  console.log(
    `  ${name.padEnd(26)} ${String(probe.measured).padStart(5)} readings  ` +
    `${probe.styles} styles  ${probe.distinctPalettes}/15 palettes  ${probe.failures.length} failures`,
  );
  await context.close();
}

console.log(`\ncontrast sweep, ${themes.length} palettes\n`);

await sweep("resting", async () => {});
await sweep("entry focused", async (page) => {
  await page.locator(".entry").first().focus();
  await page.keyboard.press("ArrowDown");
});
await sweep("palette list open", async (page) => {
  await page.locator(".palette__toggle").click();
  await page.waitForSelector(".palette__option:visible");
});
await sweep("session running", async (page) => {
  await page.locator(".session__go").click();
});
await sweep("offline", async (page) => {
  await page.evaluate(() => window.__drop());
  await page.waitForFunction(() => document.body.textContent.includes("not connected"));
});
await sweep("narrow, 400px", async () => {}, { width: 400, height: 760 });

/* Layout, which the colour probe says nothing about. */
const context = await browser.newContext({ viewport: { width: 400, height: 760 } });
const page = await context.newPage();
await page.addInitScript(FAKE_SOCKET);
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector(".entry");
const layout = [];
for (const width of [400, 360, 320]) {
  await page.setViewportSize({ width, height: 760 });
  await page.waitForTimeout(120);
  layout.push(
    await page.evaluate(() => {
      const doc = document.documentElement;
      const chrome = document.querySelector(".chrome");
      const style = getComputedStyle(chrome);
      return {
        width: window.innerWidth,
        scrollWidth: doc.scrollWidth,
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
      };
    }),
  );
}
await context.close();

console.log("\nlayout");
for (const row of layout) {
  const overflow = row.scrollWidth > row.width;
  console.log(
    `  ${String(row.width).padStart(4)}px  scrollWidth ${row.scrollWidth}  ` +
    `gutter ${row.left}/${row.right}px  ${overflow ? "HORIZONTAL SCROLL" : "no horizontal scroll"}`,
  );
}

await browser.close();
server.kill();

const badLayout = layout.filter((r) => r.scrollWidth > r.width || r.left < 16 || r.right < 16);
console.log(
  `\n${states} states, ${measured} readings, ${distinct}/15 palettes painted, ` +
  `${failures.length} contrast failures, ${badLayout.length} layout failures\n`,
);
if (failures.length) console.log(describeFailures(failures));
process.exit(failures.length + badLayout.length > 0 ? 1 : 0);
