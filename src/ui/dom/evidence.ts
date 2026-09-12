/**
 * The evidence panel: what the selected light actually was.
 *
 * The rows come from `evidenceRows` and are not assembled here. That is the point: if this file
 * built its own rows it could grow a tidy "Location" row next to the placement row, filled
 * straight from the coordinates, and the honesty guarantee would be gone with nothing failing.
 */
import { evidenceRows, type Evidence } from "../evidence.ts";
import { el, fill } from "./el.ts";

export type EvidenceView = {
  root: HTMLElement;
  render(evidence: Evidence | null): void;
};

export const EVIDENCE_ID = "evidence";

export function mountEvidence(): EvidenceView {
  const body = el("div", { class: "evidence" });
  const root = el(
    "section",
    {
      id: EVIDENCE_ID,
      class: "panel",
      // A region rather than a live region. The pointer drives this too, and a live region fed
      // by hover over a hundred events a second never finishes a sentence.
      role: "region",
      "aria-label": "Evidence for the selected light",
    },
    [
      el("div", { class: "section__head" }, [
        el("h2", { class: "section__title", text: "Evidence" }),
      ]),
      body,
    ],
  );

  return {
    root,
    render(evidence) {
      if (!evidence) {
        fill(body, [
          el("p", {
            class: "evidence__empty",
            text: "Point at a light, or arrow through the register, to see what it was.",
          }),
        ]);
        return;
      }
      fill(
        body,
        evidenceRows(evidence).map((row) =>
          row.id === "label"
            ? el("p", { class: "evidence__label", text: row.value })
            : el(
                "div",
                { class: row.id === "placement" ? "evidence__row placement" : "evidence__row" },
                [
                  el("span", {
                    class: row.id === "placement"
                      ? evidence.placement.measured
                        ? "evidence__key mark--measured"
                        : "evidence__key mark--regional"
                      : "evidence__key",
                    text: row.key,
                  }),
                  el("span", { class: "evidence__value", text: row.value }),
                ],
              ),
        ),
      );
    },
  };
}
