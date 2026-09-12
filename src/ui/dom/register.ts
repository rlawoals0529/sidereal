/**
 * The register, painted: one real button per light in the sky.
 *
 * Why this exists at all is in `register.ts`. What matters here is the two DOM habits that make
 * it usable with a keyboard:
 *
 * **Rows are reused, not rebuilt.** The list re-renders once a second to age its timestamps,
 * and `replaceChildren` on a list containing the focused element removes that element, which
 * drops focus to the body. So the DOM is only restructured when the ORDER of ids changes, and
 * the per-second update writes text into the rows that are already there.
 *
 * **One tab stop for the whole list.** Sixty-four tab stops to get past a list is sixty-four
 * too many. Roving `tabindex`, as a listbox does, with the arrow keys moving inside it.
 */
import type { SkyEvent } from "../../shared/event.ts";
import { KINDS } from "../ports.ts";
import { announce, describeEvent, type Evidence } from "../evidence.ts";
import { cursorIndex, heldCount, visible, type Filter, type Register } from "../register.ts";
import { listIntent } from "../keys.ts";
import { el } from "./el.ts";

export type RegisterActions = {
  move(by: number): void;
  edge(to: "first" | "last"): void;
  select(id: string): void;
  filter(next: Filter): void;
  focusEnter(): void;
  focusLeave(): void;
};

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  edit: "Edits",
  quake: "Quakes",
  orbit: "ISS",
  aurora: "Aurora",
};

type Row = { button: HTMLButtonElement; label: HTMLElement; meta: HTMLElement };

export type RegisterView = {
  root: HTMLElement;
  render(state: Register, serverNow: number): void;
  /** Move focus onto whichever row the cursor is on. Called after an arrow key. */
  focusCursor(state: Register): void;
};

export function mountRegister(actions: RegisterActions): RegisterView {
  const count = el("span", { class: "section__count" });
  const list = el("ul", {
    class: "register__list",
    // A listbox, because that is what it is: a single-select list of the sky's contents.
    role: "listbox",
    "aria-label": "Lights in the sky, newest first",
  });
  const held = el("p", { class: "held", "aria-live": "off" });

  const filterButtons = new Map<Filter, HTMLButtonElement>();
  const filters = el("div", { class: "filters", role: "group", "aria-label": "Filter by feed" });
  for (const filter of ["all", ...KINDS] as Filter[]) {
    const button = el("button", {
      type: "button",
      "aria-pressed": "false",
      text: FILTER_LABELS[filter],
    });
    button.addEventListener("click", () => actions.filter(filter));
    filterButtons.set(filter, button);
    filters.append(button);
  }

  const root = el("section", { class: "panel", "aria-label": "Register" }, [
    el("div", { class: "section__head" }, [
      el("h2", { class: "section__title", text: "Register" }),
      count,
    ]),
    filters,
    list,
    held,
  ]);

  const rows = new Map<string, Row>();
  let order = "";

  const rowFor = (event: SkyEvent): Row => {
    const existing = rows.get(event.id);
    if (existing) return existing;
    const label = el("span", { class: "entry__label" });
    const meta = el("span", { class: "entry__meta" });
    const button = el("button", { type: "button", class: "entry", role: "option" }, [label, meta]);
    button.addEventListener("click", () => actions.select(event.id));
    button.addEventListener("keydown", (e) => {
      const intent = listIntent(e.key);
      if (intent.t === "none") return;
      // Arrow keys inside a listbox must not also scroll the page under it.
      e.preventDefault();
      if (intent.t === "move") actions.move(intent.by);
      else actions.edge(intent.to);
    });
    const row: Row = { button, label, meta };
    rows.set(event.id, row);
    return row;
  };

  // Delegated, so the freeze covers the whole list rather than one row at a time. `focusout`
  // fires on every arrow key as focus moves between rows, so leaving is decided by where focus
  // WENT, not by the fact that it left a row.
  list.addEventListener("focusin", () => actions.focusEnter());
  list.addEventListener("focusout", (e) => {
    if (!list.contains(e.relatedTarget as Node | null)) actions.focusLeave();
  });

  return {
    root,
    render(state, serverNow) {
      const items = visible(state);
      const signature = items.map((e) => e.id).join(",");

      if (signature !== order) {
        list.replaceChildren(...items.map((e) => rowFor(e).button));
        order = signature;
        // Rows for events that have aged out would otherwise be held forever by this map.
        const live = new Set(items.map((e) => e.id));
        for (const id of [...rows.keys()]) if (!live.has(id)) rows.delete(id);
      }

      const at = cursorIndex(state);
      items.forEach((event, index) => {
        const row = rowFor(event);
        const evidence: Evidence = describeEvent(event, serverNow);
        row.label.textContent = event.label;
        row.meta.textContent = `${evidence.kindLabel}, ${evidence.relative}, ${
          evidence.placement.measured ? "measured" : "regional"
        }`;
        row.button.setAttribute("aria-label", announce(evidence));
        row.button.setAttribute("aria-selected", String(index === at));
        row.button.setAttribute("aria-current", String(index === at));
        // The single tab stop. Index 0 when nothing is selected, so the list is always
        // reachable by Tab even before anything has been chosen.
        row.button.tabIndex = index === (at < 0 ? 0 : at) ? 0 : -1;
      });

      count.textContent = items.length === 1 ? "1 light" : `${items.length} lights`;

      for (const [filter, button] of filterButtons) {
        button.setAttribute("aria-pressed", String(state.filter === filter));
      }

      const waiting = heldCount(state);
      held.textContent = waiting === 0
        ? ""
        : waiting === 1
          ? "1 new light, held while you read"
          : `${waiting} new lights, held while you read`;
    },
    focusCursor(state) {
      const at = cursorIndex(state);
      const event = visible(state)[at];
      if (event) rows.get(event.id)?.button.focus();
    },
  };
}
