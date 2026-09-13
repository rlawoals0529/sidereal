/**
 * The keyboard, in a real browser. A canvas-based page that is mouse-only is a failed page, and
 * "it has buttons" is not evidence: what matters is whether Tab reaches them in an order that
 * makes sense, whether the ring is visible when it does, and whether the arrow keys move the
 * thing they appear to move.
 *
 * This is deliberately a walk rather than an axe-style rule scan. A rule scan checks markup; the
 * failures that make a page like this unusable are behavioural - a list that reorders under the
 * cursor, sixty-four tab stops to get past a feed, a focus ring clipped by its own scroller -
 * and none of those are visible to a linter.
 *
 *   node test/ui/keyboard-walk.mjs
 *
 * Same dependency and the same override as the contrast sweep. See `src/ui/DEPS.md`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}/`;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

/** The same fake socket the contrast sweep uses: real `ServerMessage` shapes, no invented mode. */
const FAKE_SOCKET = () => {
  const now = Date.now();
  const events = [
    { id: "q1", kind: "quake", at: now - 240_000, lat: 53.12, lon: 158.61, placement: "measured", magnitude: 0.62, label: "M4.1, 61 km NNE of Petropavlovsk-Kamchatsky", source: "USGS" },
    { id: "e1", kind: "edit", at: now - 8_000, lat: 50.45, lon: 30.52, placement: "regional", magnitude: 0.31, label: "Kyiv Metro", source: "Wikimedia EventStreams" },
    { id: "e2", kind: "edit", at: now - 30_000, lat: 35.68, lon: 139.76, placement: "regional", magnitude: 0.77, label: "Tokyo Metropolitan Government Building", source: "Wikimedia EventStreams" },
    { id: "o1", kind: "orbit", at: now - 1_000, lat: -12.4, lon: 44.9, placement: "measured", magnitude: 1, label: "ISS", source: "Open Notify" },
  ];
  class FakeSocket {
    constructor() {
      this.listeners = {};
      window.__socket = this;
      setTimeout(() => {
        this.fire("open");
        this.fire("message", { data: JSON.stringify({ t: "welcome", you: "me", others: [{ id: "p1", palette: "rain-lantern", az: 12, alt: 30, focused: true, since: now - 900_000 }], serverNow: Date.now() }) });
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
  /** Deliver a batch on demand, to test that the list does not move under the cursor. */
  window.__tick = (batch) =>
    window.__socket.fire("message", { data: JSON.stringify({ t: "events", batch, serverNow: Date.now() }) });
};

const server = spawn("node_modules/.bin/vite", ["--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: fileURLToPath(ROOT), stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const die = setTimeout(() => reject(new Error("vite did not start")), 30_000);
  server.stdout.on("data", (c) => { if (String(c).includes("ready in")) { clearTimeout(die); resolve(); } });
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(FAKE_SOCKET);
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector(".entry");

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/** Where focus is, in terms a human can read. */
const focused = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: "body", name: "", ring: "" };
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      cls: el.className,
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 60),
      ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      current: el.getAttribute("aria-current"),
    };
  });

console.log("\nkeyboard walk\n");

/* Tab from the top and record the order. */
const order = [];
await page.evaluate(() => document.body.focus());
for (let i = 0; i < 12; i++) {
  await page.keyboard.press("Tab");
  const at = await focused();
  order.push(at);
  if (at.tag === "body") break;
}
console.log("  tab order:");
for (const [i, at] of order.entries()) console.log(`    ${i + 1}. ${at.tag}.${at.cls || "-"}  ${at.name}`);

check("the first stop is the skip link", order[0]?.cls === "skip", order[0]?.name);
check(
  "the register is one tab stop, not sixty-four",
  order.filter((o) => String(o.cls).includes("entry")).length === 1,
);
check(
  "the focus session button is reachable by Tab",
  order.some((o) => String(o.cls).includes("session__go")),
);
check(
  "every stop paints a visible ring",
  order.every((o) => o.tag === "body" || (o.ring.includes("solid") && !o.ring.startsWith("none"))),
  order.find((o) => o.tag !== "body" && !o.ring.includes("solid"))?.cls ?? "",
);

/* The skip link lands on the register. */
await page.evaluate(() => document.body.focus());
await page.keyboard.press("Tab");
await page.keyboard.press("Enter");
check("the skip link lands on the register", await page.evaluate(() => document.activeElement?.id === "register"));

/* Arrow keys move the cursor and focus follows it. */
const first = page.locator(".entry").first();
await first.focus();
const before = await focused();
await page.keyboard.press("ArrowDown");
const after = await focused();
check("ArrowDown moves the cursor and focus with it", before.name !== after.name && after.current === "true", after.name);
await page.keyboard.press("End");
const last = await focused();
check("End reaches the oldest light", last.name !== after.name, last.name);

/* The evidence panel says what the focused light was, placement included. */
// innerText is the RENDERED text, so the row keys come back as the stylesheet draws them:
// `text-transform: uppercase` turns "Regional placement" into "REGIONAL PLACEMENT" here and
// nowhere else. Case-insensitive, because the case is a paint decision and the words are the
// claim. (The accessible name is unaffected: text-transform does not reach it.)
const panel = await page.locator("#evidence").innerText();
check("the panel names the placement in words", /regional placement|measured position/i.test(panel), panel.split("\n")[3] ?? "");
check(
  "a regional coordinate never appears without its caveat",
  !/regional placement/i.test(panel) || /not a measurement of where this happened/i.test(panel),
);

/* The list must not reorder under the cursor. */
const held = await page.evaluate(async () => {
  // Identity, not the label. An entry's accessible name ends with a relative time and the page
  // rewrites it once a second, so comparing labels across an 80ms wait reports that the cursor
  // moved roughly eight times in a hundred when nothing moved at all: the words "10 seconds
  // ago" simply became "11 seconds ago". That is what made this red in CI and green here.
  const before = document.activeElement;
  window.__tick([{ id: "late", kind: "edit", at: Date.now(), lat: 1, lon: 1, placement: "regional", magnitude: 0.2, label: "arrived while reading", source: "Wikimedia EventStreams" }]);
  await new Promise((r) => setTimeout(r, 80));
  return {
    stillThere: document.activeElement === before,
    firstRow: document.querySelector(".entry")?.getAttribute("aria-label") ?? "",
    notice: document.querySelector(".held")?.textContent ?? "",
  };
});
check("a light arriving while you read does not move your cursor", held.stillThere);
check("and it does not jump to the top of the list either", !held.firstRow.includes("arrived while reading"));
check("and the page says it is being held", held.notice.includes("held while you read"), held.notice);

/* Then it lands when focus leaves. */
await page.locator(".session__go").focus();
await page.waitForTimeout(120);
// Present in the list, and leading its own kind. Asserting it was first overall used to work
// and was an accident of the list being sorted purely by time: the register now leads with the
// rarest feed, so an edit sits below any quake or station row no matter how new it is. What is
// actually being guarded is that a held arrival lands rather than being lost, and that within
// its kind it is still the newest, so both are checked instead of the position it happens to
// land at.
const labels = await page.locator(".entry").evaluateAll((rows) =>
  rows.map((r) => r.getAttribute("aria-label") ?? ""),
);
const landedAt = labels.findIndex((l) => l.includes("arrived while reading"));
check("the held light lands when focus leaves the list", landedAt >= 0);
const firstEdit = labels.findIndex((l) => /wikipedia edit/i.test(l));
check(
  "and it leads its own kind, because within a feed the list is still newest first",
  landedAt >= 0 && landedAt === firstEdit,
  `landed at ${landedAt}, first edit at ${firstEdit}`,
);

/* The ritual starts from the keyboard. */
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press("f");
await page.waitForTimeout(80);
check(
  "F starts a focus session",
  (await page.locator(".session__go").getAttribute("aria-pressed")) === "true",
);
await page.locator(".session__go").focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
check(
  "and Enter on the button ends it",
  (await page.locator(".session__go").getAttribute("aria-pressed")) === "false",
);

/* The palette group is one tab stop, arrows preview, Escape puts back what you arrived with. */
await page.locator(".palette__toggle").click();
const arrived = await page.evaluate(() => document.documentElement.dataset.theme);
await page.keyboard.press("ArrowRight");
const previewed = await page.evaluate(() => document.documentElement.dataset.theme);
check("arrowing the palette group previews on the real page", arrived !== previewed, `${arrived} to ${previewed}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(80);
check("Escape puts back the palette you arrived with", (await page.evaluate(() => document.documentElement.dataset.theme)) === arrived);

/* The canvas is not in the accessibility tree, because the register is its equivalent. */
check("the canvas is hidden from assistive technology", (await page.locator("canvas").getAttribute("aria-hidden")) === "true");

await browser.close();
server.kill();

console.log(`\n${failures.length} failures\n`);
process.exit(failures.length ? 1 : 0);
