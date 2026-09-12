/**
 * The masthead, painted.
 *
 * The model in `masthead.ts` decides what may be said; this decides where it goes. The only
 * judgement here is about announcements:
 *
 * **Presence is announced, events are not.** A join or a leave is rare and is the thing a
 * viewer is most likely to be looking at, so it goes into a polite live region. The event line
 * changes on the order of a hundred times a second, and putting THAT in a live region is a
 * screen-reader denial of service: the listener would never hear the end of a sentence. Events
 * reach a listener through the register, where they are read one at a time on demand.
 */
import type { Masthead } from "../masthead.ts";
import { el, fill } from "./el.ts";

export type MastheadView = {
  root: HTMLElement;
  render(model: Masthead, options: { announcePresence: boolean; freshEvent: boolean }): void;
};

export function mountMasthead(): MastheadView {
  const name = el("h1", { class: "bar__name", text: "sidereal" });

  const people = el("b", { class: "num" });
  const peopleLabel = el("span");
  const rate = el("span");
  const clock = el("b", { class: "num" });
  const clockLabel = el("span", { text: "sidereal time at Greenwich" });
  const status = el("span");

  const facts = el("p", { class: "facts" }, [
    el("span", { class: "fact" }, [people, peopleLabel]),
    el("span", { class: "fact" }, [rate]),
    el("span", { class: "fact" }, [clock, clockLabel]),
  ]);

  const nowText = el("span", { class: "now__text" });
  const now = el("div", { class: "now" }, [
    el("span", { class: "now__label", text: "Newest light" }),
    nowText,
  ]);

  /** Only presence speaks. See the note at the top of this file. */
  const announcer = el("p", {
    class: "sr-only",
    "aria-live": "polite",
    "aria-atomic": "true",
  });

  const root = el("div", { class: "panel bar" }, [
    el("div", { class: "bar__top" }, [name, status]),
    facts,
    now,
    announcer,
  ]);

  return {
    root,
    render(model, { announcePresence, freshEvent }) {
      // A count we do not have is an empty slot, never a zero. See buildMasthead.
      people.textContent = model.people === null ? "" : String(model.people);
      peopleLabel.textContent = model.peopleText;
      rate.textContent = model.rateText;
      rate.className = model.connection === "offline" ? "status--offline" : "";
      clock.textContent = model.siderealText;
      clockLabel.textContent = "sidereal time at Greenwich";
      status.textContent = model.status ?? "";
      status.className = model.connection === "offline" ? "status--offline" : "fact";

      const mark = model.latest
        ? el("span", {
            class: model.latest.placement.measured ? "mark--measured" : "mark--regional",
            text: model.latest.placement.measured ? "measured" : "regional",
          })
        : null;

      if (model.latest) {
        fill(nowText, [
          `${model.latest.label}. `,
          el("span", { class: "now__source", text: model.latest.source }),
          `, ${model.latest.relative}, `,
          mark!,
          " position.",
        ]);
      } else {
        fill(nowText, [model.latestText]);
      }

      now.classList.toggle("now--fresh", freshEvent);

      if (announcePresence && model.people !== null) {
        announcer.textContent = `${model.peopleText}.`;
      }
    },
  };
}
