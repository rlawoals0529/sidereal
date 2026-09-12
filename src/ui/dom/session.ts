/**
 * The focus ritual, painted.
 *
 * The button is a real button, so it is reachable by Tab and pressed by Enter or Space with no
 * help from us. `F` is a shortcut on top of that, never instead of it, and the key is printed
 * on the control rather than hidden in a help screen nobody opens.
 *
 * The sky does the timing. Showing the elapsed span in degrees is not decoration: the Earth
 * turns 360 degrees against the stars in 86,164 seconds, so a 25 minute session is 6.27 degrees
 * every time. It is the same number the canvas is already using to place everything.
 */
import { degreesOfSky, duration } from "../time.ts";
import { FOCUS_DAY_MS, type FocusState, type Streak } from "../session.ts";
import { el } from "./el.ts";

export type SessionActions = { toggle(): void };

export type SessionModel = {
  focus: FocusState;
  streak: Streak;
  now: number;
  /** False when the browser refuses to store site data. The ritual still runs; the record does
   *  not, and the panel says which rather than showing a streak of zero with no explanation. */
  persists: boolean;
};

export type SessionView = { root: HTMLElement; render(model: SessionModel): void };

export function mountSession(actions: SessionActions): SessionView {
  const go = el("button", { type: "button", class: "session__go" });
  const goLabel = el("span");
  const key = el("kbd", { text: "F" });
  go.append(goLabel, " ", key);
  go.addEventListener("click", () => actions.toggle());

  const clock = el("span", { class: "session__clock num" });
  const sky = el("span", { class: "session__sky" });
  const streakText = el("span", { class: "session__streak" });
  const rule = el("span", { class: "session__rule" });

  const root = el("section", { class: "panel session", "aria-label": "Focus" }, [
    el("div", { class: "section__head" }, [
      el("h2", { class: "section__title", text: "Focus" }),
      streakText,
    ]),
    el("div", { class: "session__row" }, [go, clock, sky]),
    rule,
  ]);

  return {
    root,
    render({ focus, streak, now, persists }) {
      const running = focus.startedAt !== null;
      const elapsed = running ? now - focus.startedAt! : 0;

      goLabel.textContent = running ? "End session" : "Begin focus session";
      go.className = running ? "session__go session__go--stop" : "session__go";
      // The button IS the state, so it says so out loud as well as in its label.
      go.setAttribute("aria-pressed", String(running));

      clock.textContent = running ? duration(elapsed) : "";
      sky.textContent = running
        ? `${degreesOfSky(elapsed).toFixed(2)} degrees of sky`
        : "";

      streakText.textContent = streak.current === 0
        ? "no streak yet"
        : streak.current === 1
          ? `1 day streak, longest ${streak.longest}`
          : `${streak.current} day streak, longest ${streak.longest}`;

      const minutes = FOCUS_DAY_MS / 60_000;
      rule.textContent = persists
        ? `${minutes} minutes in a day keeps the streak. Today: ${duration(streak.todayMs + elapsed)}.`
        : "This browser is not storing site data, so sessions are not being recorded.";
    },
  };
}
