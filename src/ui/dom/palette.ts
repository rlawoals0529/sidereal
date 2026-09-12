/**
 * The palette picker: a radio group with one tab stop, where arrowing is the preview.
 *
 * Selection follows focus, which is what makes moving through fifteen palettes a way of looking
 * at them rather than a survey you fill in blind. Escape puts back whichever one was on the page
 * when the group was reached, so trying them is not a one-way door.
 *
 * The list is toggled with `hidden` rather than a `<details>`, for a reason that is specific to
 * this project: the contrast sweep reads computed styles, and a closed `<details>` hides its
 * contents with `content-visibility`, which makes every control inside it invisible to the
 * probe. With `hidden` the sweep opens the list and measures it as a second state.
 */
import type { Theme } from "../../lib/theme.ts";
import { paletteIntent, wrap } from "../keys.ts";
import type { PalettePicker } from "../palette.ts";
import { el } from "./el.ts";

export type PaletteView = { root: HTMLElement; render(): void };

export function mountPalette(picker: PalettePicker, onChange: (id: string) => void): PaletteView {
  const chip = el("span", { class: "palette__chip" });
  const toggleLabel = el("span");
  const toggle = el("button", {
    type: "button",
    class: "palette__toggle",
    "aria-expanded": "false",
  });
  toggle.append(chip, toggleLabel);

  const list = el("div", { class: "palette__list", hidden: true });
  const group = el("div", { role: "radiogroup", "aria-label": "Palette", class: "palette__grid" });
  const options: HTMLButtonElement[] = [];

  for (const { label: groupLabel, themes } of picker.groups) {
    const holder = el("div", { class: "palette__options" });
    for (const theme of themes) holder.append(optionFor(theme));
    group.append(
      el("div", { class: "palette__group" }, [
        el("span", { class: "palette__groupname", text: groupLabel }),
        holder,
      ]),
    );
  }

  list.append(
    group,
    el("p", {
      class: "palette__note",
      // An honest statement of a protocol limit, not an apology. ClientMessage carries the
      // palette on `hello` and has no update, so a change reaches other people on reconnect.
      text: "Your star changes colour for everyone else the next time this page connects.",
    }),
  );

  const root = el("div", { class: "palette" }, [toggle, list]);

  function optionFor(theme: Theme): HTMLButtonElement {
    const swatch = el("span", { class: "palette__swatch" });
    swatch.style.background = theme.accent;
    const option = el(
      "button",
      { type: "button", class: "palette__option", role: "radio", "data-theme": theme.id },
      [swatch, el("span", { text: theme.label })],
    );
    option.addEventListener("click", () => {
      apply(theme.id);
      close(true);
    });
    option.addEventListener("keydown", (e) => {
      const intent = paletteIntent(e.key);
      if (intent.t === "none") return;
      e.preventDefault();
      if (intent.t === "cancel") {
        apply(picker.restore());
        close(true);
        return;
      }
      const from = options.indexOf(option);
      const to = intent.t === "move"
        ? wrap(from, intent.by, options.length)
        : intent.to === "first"
          ? 0
          : options.length - 1;
      const next = options[to];
      if (!next) return;
      apply(next.dataset.theme ?? picker.current());
      next.focus();
    });
    options.push(option);
    return option;
  }

  function apply(id: string): void {
    picker.select(id);
    onChange(picker.current());
    render();
  }

  function open(): void {
    // What Escape puts back is what was on the page when the group was REACHED, not when the
    // page loaded: with a mouse the list can sit open a long time before anything is tried.
    picker.mark();
    list.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    options.find((o) => o.getAttribute("aria-checked") === "true")?.focus();
  }

  function close(returnFocus: boolean): void {
    list.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (returnFocus) toggle.focus();
  }

  toggle.addEventListener("click", () => (list.hidden ? open() : close(true)));
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      apply(picker.restore());
      close(true);
    }
  });

  function render(): void {
    const current = picker.current();
    const theme = picker.themes.find((t) => t.id === current);
    toggleLabel.textContent = theme?.label ?? current;
    chip.style.background = theme?.accent ?? "";
    for (const option of options) {
      const mine = option.dataset.theme === current;
      option.setAttribute("aria-checked", String(mine));
      // One tab stop for the group, on whichever option is chosen. Standard radio behaviour,
      // so nothing about it has to be explained to anybody.
      option.tabIndex = mine ? 0 : -1;
    }
  }

  render();
  return { root, render };
}
