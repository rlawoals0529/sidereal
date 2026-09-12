/**
 * Boot. The only file that knows about all the others, and the only one that touches globals.
 *
 * Everything below it is either a pure function over state or a view that takes a model, which
 * is what lets the behaviour be tested in a plain node runner. The parts that genuinely need a
 * browser - a socket, a clock, a canvas, a media query - are reached for exactly here.
 */
import "../theme/palettes.css";
import "../theme/base.css";
import "../theme/type.css";
import "./ui.css";

import type { SkyEvent } from "../shared/event.ts";
import { describeEvent } from "./evidence.ts";
import { createLink } from "./link.ts";
import { buildMasthead } from "./masthead.ts";
import { onReducedMotionChange, prefersReducedMotion } from "./motion.ts";
import { createPalettePicker } from "./palette.ts";
import { nullSky, type SkyHandle } from "./ports.ts";
import { adaptSky } from "./sky-adapter.ts";
import {
  emptyRegister,
  freeze,
  ingest,
  move,
  moveTo,
  select,
  setFilter,
  thaw,
  cursorEvent,
  type Filter,
} from "./register.ts";
import { begin, end, idle, streak, type FocusState } from "./session.ts";
import { eventRate, initialSky, peopleCount, reduceSky, withConnection } from "./sky-state.ts";
import { localSessionStore, memorySessionStore, storageAvailable } from "./storage.ts";
import { mountEvidence } from "./dom/evidence.ts";
import { mountMasthead } from "./dom/masthead.ts";
import { mountPalette } from "./dom/palette.ts";
import { mountRegister } from "./dom/register.ts";
import { mountSession } from "./dom/session.ts";
import { el } from "./dom/el.ts";

const canvas = document.getElementById("sky") as HTMLCanvasElement | null;
const chrome = document.getElementById("chrome");
if (!canvas || !chrome) throw new Error("index.html is missing #sky or #chrome");

const reducedMotion = prefersReducedMotion();

/** How long the newest-light line stays lit after it changes. Matches the CSS animation. */
const FRESH_MS = 1200;

/* ---- state ------------------------------------------------------------------------------ */

let sky = initialSky();
let register = emptyRegister();
let focus: FocusState;
/** The record under the pointer, kept whole rather than as an id: the renderer hands back the
 *  event it drew, and looking it up again here would let the panel disagree with the canvas. */
let hovered: SkyEvent | null = null;
let lastLatestId: string | null = null;
let litUntil = 0;
let lastPresenceEpoch = 0;

const persists = storageAvailable();
// The seam. A server-backed store implements the same two methods and this line changes.
const sessions = persists ? localSessionStore() : memorySessionStore();
focus = idle(sessions.load());

const now = () => Date.now() + sky.skew;

/* ---- the renderer ------------------------------------------------------------------------ */

const picker = createPalettePicker();

let handle: SkyHandle = nullSky(canvas, { palette: picker.current(), reducedMotion });

/**
 * The renderer is loaded at runtime and its absence is not fatal.
 *
 * A machine with no WebGL2 and no 2D context, or a module that throws on construction, leaves
 * the canvas empty and everything else working: the register, the evidence panel and the focus
 * ritual are all real DOM and none of them needs a frame to have been drawn. `nullSky` draws
 * nothing rather than drawing a placeholder, because the one rule here is that every light
 * traces to a measured event and a stand-in that drew anything would be the first to break it.
 */
async function loadSky(): Promise<void> {
  try {
    const module = await import("../sky/index.ts");
    handle.destroy();
    handle = adaptSky(module.createSky, canvas!, {
      palette: picker.current(),
      reducedMotion,
    });
  } catch (error) {
    console.warn("sidereal: the canvas did not start, so the sky is empty", error);
  }
}

/* ---- views ------------------------------------------------------------------------------- */

const masthead = mountMasthead();
const evidence = mountEvidence();

const registerView = mountRegister({
  move(by) {
    register = move(register, by);
    render();
    registerView.focusCursor(register);
  },
  edge(to) {
    register = moveTo(register, to);
    render();
    registerView.focusCursor(register);
  },
  select(id) {
    register = select(register, id);
    render();
  },
  filter(next: Filter) {
    register = setFilter(register, next);
    render();
  },
  focusEnter() {
    register = freeze(register);
    render();
  },
  focusLeave() {
    register = thaw(register, now());
    render();
  },
});

const sessionView = mountSession({ toggle: () => toggleFocus() });

const paletteView = mountPalette(picker, (id) => {
  // No call into the renderer: it watches `data-theme` on the root, which the picker has
  // already set, and a second path to the same state is how two paths start disagreeing.
  link.hello({ t: "hello", palette: id });
});

registerView.root.id = "register";
// The skip link lands here, and a container is not focusable without this. -1 rather than 0:
// it is a destination, not a tab stop of its own.
registerView.root.tabIndex = -1;

chrome.append(
  el("div", { class: "head" }, [masthead.root, paletteView.root]),
  el("div", { class: "aside" }, [registerView.root, evidence.root]),
  el("div", { class: "foot" }, [sessionView.root]),
);

/* ---- the link ---------------------------------------------------------------------------- */

const socketUrl =
  import.meta.env.VITE_SKY_URL ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sky`;

const link = createLink(socketUrl, {
  onMessage(message) {
    sky = reduceSky(sky, message, Date.now());
    // The canvas reads the same frames this does, verbatim. Two halves fed from one stream
    // cannot end up disagreeing about who is present or what arrived.
    //
    // Guarded, and the guard is not decoration: a context lost on a GPU reset throws from here,
    // and without this the socket handler dies with it. The chrome is all real DOM and does not
    // need a frame to have been drawn, so the honest failure is an empty canvas and a page that
    // still works, not a page that stops updating with no clue why.
    try {
      handle.forward(message);
    } catch (error) {
      console.warn("sidereal: the canvas stopped taking frames, so it is now empty", error);
      handle = nullSky(canvas!, { palette: picker.current(), reducedMotion });
    }
    if (message.t === "events") register = ingest(register, message.batch, now());
    render();
  },
  onStatus(status) {
    sky = withConnection(sky, status);
    render();
  },
});

link.hello({ t: "hello", palette: picker.current() });

/* ---- the focus ritual --------------------------------------------------------------------- */

function toggleFocus(): void {
  if (focus.startedAt === null) {
    focus = begin(focus, Date.now());
    handle.setFocus(true);
    link.send({ t: "focus", on: true });
  } else {
    const result = end(focus, Date.now());
    focus = result.state;
    if (result.recorded) sessions.append(result.recorded);
    handle.setFocus(false);
    link.send({ t: "focus", on: false });
  }
  render();
}

/**
 * `F` starts and ends a session, on top of the button rather than instead of it.
 *
 * Guarded against the cases where a bare letter is not a shortcut: a modifier means it belongs
 * to the browser or the operating system, and a field means the person is typing. There are no
 * fields on this page today, and that is exactly the kind of thing that changes without anybody
 * remembering the shortcut exists.
 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "f" && e.key !== "F") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.isContentEditable) return;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  e.preventDefault();
  toggleFocus();
});

/**
 * A closed tab still ends the session.
 *
 * Without this, closing the page mid-session loses it entirely: the streak would only ever count
 * the sessions somebody remembered to stop, which is the ones they were least absorbed in.
 * `pagehide` rather than `beforeunload`, because the latter does not fire on mobile.
 */
addEventListener("pagehide", () => {
  if (focus.startedAt === null) return;
  const result = end(focus, Date.now());
  focus = result.state;
  if (result.recorded) sessions.append(result.recorded);
});

/* ---- pointer ------------------------------------------------------------------------------ */

canvas.addEventListener("pointermove", (e) => {
  const box = canvas.getBoundingClientRect();
  const hit = handle.hitTest(e.clientX - box.left, e.clientY - box.top);
  // Compared by id rather than by object, so a renderer that hands back a fresh object for the
  // same light does not re-render the panel on every pointer move across one star.
  if ((hit?.id ?? null) === (hovered?.id ?? null)) return;
  hovered = hit;
  handle.highlight(hit?.id ?? selectedId());
  render();
});

canvas.addEventListener("pointerleave", () => {
  if (hovered === null) return;
  hovered = null;
  handle.highlight(selectedId());
  render();
});

/**
 * A function declaration, not a const arrow, and that is the whole point.
 *
 * `render` is hoisted and is reachable from the socket handler the moment `createLink` opens
 * its connection, which is well above here. A `const` read from `render` is therefore in its
 * temporal dead zone for that window, and every frame that arrives in it throws
 * "Cannot access selectedId before initialization" straight out of the message handler. The
 * page kept running, the chrome kept updating, and the sky drew nothing, with the only trace
 * in a console nobody had open.
 *
 * Declaring it as a function hoists it with `render`, so the two cannot get out of order
 * again. Moving the line further up the file would have fixed this instance and left the trap.
 */
function selectedId(): string | null {
  return cursorEvent(register)?.id ?? null;
}

/* ---- render -------------------------------------------------------------------------------- */

function render(): void {
  const serverNow = now();

  const latest = sky.latest;
  if (latest && latest.id !== lastLatestId) {
    lastLatestId = latest.id;
    litUntil = Date.now() + FRESH_MS;
    // Tie the line to the star. Only while nothing else is selected, because overriding a
    // keyboard user's highlight every time an edit lands would make the list unusable.
    if (!hovered && !selectedId()) handle.highlight(latest.id);
  }

  const announcePresence = sky.presenceEpoch !== lastPresenceEpoch;
  lastPresenceEpoch = sky.presenceEpoch;

  masthead.render(
    buildMasthead({
      connection: sky.connection,
      people: peopleCount(sky),
      rate: eventRate(sky, serverNow),
      latest: latest ? describeEvent(latest, serverNow) : null,
      serverNow,
    }),
    { announcePresence, freshEvent: !reducedMotion && Date.now() < litUntil },
  );

  registerView.render(register, serverNow);

  // The pointer wins while it is over a light, and the keyboard cursor holds the panel the rest
  // of the time, so the two drivers never fight over it.
  const shown = hovered ?? cursorEvent(register);
  evidence.render(shown ? describeEvent(shown, serverNow) : null);

  sessionView.render({ focus, streak: streak(focus.sessions, Date.now()), now: Date.now(), persists });
}

/**
 * One tick a second, for the things that change without anything arriving: the sidereal clock,
 * every relative timestamp, and the session elapsed. Not `requestAnimationFrame`: nothing here
 * moves per frame, and a page meant to be left open all day should not wake sixty times a
 * second to redraw the same second.
 */
setInterval(render, 1000);

onReducedMotionChange(() => {
  // The preference changed mid-session. Reload is the honest answer for the canvas, which took
  // it at construction; the chrome's own motion is CSS and has already followed.
  location.reload();
});

void loadSky().then(render);
render();
