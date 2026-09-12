/**
 * Every light traces to a real event, enforced rather than intended.
 *
 * The rule is easy to state and easy to lose. Nobody adds a decorative particle field on
 * purpose; what happens is that six months from now a frame looks empty during a quiet
 * minute, somebody adds a faint wash to fill it, the wash is lovely, and the project quietly
 * stops being what it was. So the rule is wired to a test that fails rather than to a
 * paragraph in a readme.
 *
 * Three things have to be true for the rule to hold, and this file checks all three. Only
 * the first is obvious, and the third is the one that actually protects anything.
 *
 * 1. **Every drawn slot names a record.** A layer writes an instance and records what it was
 *    drawn from, in the same call. There is no way to get a slot without handing over the
 *    `SkyEvent` or `Presence` it came from.
 * 2. **Every named record still exists.** A slot pointing at a record the ledger has
 *    forgotten is as unbacked as one pointing at nothing.
 * 3. **Every draw call belongs to a layer or to declared chrome.** This is the important one.
 *    The first two only see the buffers they are told about; a new program drawing a glow
 *    over the top would satisfy both and be invisible to either. So the renderer reports
 *    every draw it issued, and a draw from a source that is not a registered layer or a name
 *    on the frozen `CHROME` list is a violation. You cannot add a light to this sky without
 *    the audit knowing.
 *
 * `assertEveryLightIsEarned` is the assertion form. `test/sky/every-light-is-earned.test.ts`
 * plants each of the three violations by reaching past the API and confirms the audit finds
 * it, because a guard nobody has watched fire is a guard nobody knows works.
 */
import type { SkyEvent } from "../shared/event.ts";
import type { Presence } from "../shared/protocol.ts";

/**
 * What a light was drawn from. Both arms are records somebody measured: a feed said this
 * happened, or a person is connected right now. There is deliberately no third arm.
 */
export type Backing =
  | { of: "event"; event: SkyEvent }
  | { of: "visitor"; presence: Presence };

export function backingId(b: Backing): string {
  return b.of === "event" ? `e:${b.event.id}` : `v:${b.presence.id}`;
}

/**
 * The elements that are allowed on screen without being a light.
 *
 * One, and it is a coordinate reference rather than a thing that happened: the horizon
 * circle. Drawn in `--edge`, the token for a boundary that does not have to be seen, it is
 * the frame the sky is read against the way an axis is the frame a chart is read against.
 * The four compass points are the same ring brightened over a few degrees of azimuth rather
 * than four more marks, which is one fewer element on screen for the same information.
 *
 * Frozen, listed by name, and pinned by a test that asserts this exact one entry. Adding a
 * second is a deliberate act that fails a test until someone changes the test, which is the
 * point: this is the list a wash of ambient glow would have to be added to, and adding it
 * there is at least honest.
 */
export const CHROME = Object.freeze(["horizon"] as const);
export type ChromeName = (typeof CHROME)[number];

/** A draw the renderer issued, as it reports itself for audit. */
export type DrawReport = {
  /** `layer:<name>` for a light layer, `chrome:<name>` for a coordinate reference. */
  source: string;
  /** Instances for an instanced draw, or 1 for a single strip. */
  instances: number;
};

export type Violation = { where: string; slot: number | null; why: string };

export type Audit = {
  /** Slots the renderer drew this frame that are backed by a record. */
  backed: number;
  /** Coordinate references drawn, by name. Never lights. */
  chrome: string[];
  violations: Violation[];
};

/**
 * The records behind the lights currently on the sky.
 *
 * Keyed by a prefixed id because `SkyEvent.id` and `Presence.id` come from different
 * namespaces and nothing stops a wiki revision id from colliding with a server-assigned
 * visitor id. Prefixing costs a character and removes the whole class of question.
 */
export class Ledger {
  private readonly records = new Map<string, Backing>();

  admit(b: Backing): string {
    const id = backingId(b);
    this.records.set(id, b);
    return id;
  }

  get(id: string): Backing | undefined {
    return this.records.get(id);
  }

  forget(id: string): void {
    this.records.delete(id);
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * Anything the audit can interrogate: a layer that can say which of its slots are being
 * drawn and what each one claims to be.
 *
 * Deliberately narrow. A layer that cannot answer these two questions cannot be audited, and
 * a layer that cannot be audited must not exist, so this interface is what registration
 * costs.
 */
export type Auditable = {
  readonly name: string;
  /** Slot indices the renderer drew this frame. */
  liveSlots(): Iterable<number>;
  /** The ledger key the slot was written with, or null if the layer never recorded one. */
  slotBacking(slot: number): string | null;
};

export function audit(
  ledger: Ledger,
  layers: readonly Auditable[],
  draws: readonly DrawReport[],
): Audit {
  const violations: Violation[] = [];
  const chrome: string[] = [];
  let backed = 0;

  const byName = new Map(layers.map((l) => [l.name, l]));
  const drawnInstances = new Map<string, number>();

  for (const d of draws) {
    const colon = d.source.indexOf(":");
    const family = colon < 0 ? "" : d.source.slice(0, colon);
    const name = colon < 0 ? d.source : d.source.slice(colon + 1);

    if (family === "chrome") {
      // Rule 3, the half that stops a decorative element being smuggled in as furniture.
      if (!(CHROME as readonly string[]).includes(name)) {
        violations.push({ where: d.source, slot: null, why: "chrome element is not on the declared list" });
      } else {
        chrome.push(name);
      }
      continue;
    }
    if (family !== "layer" || !byName.has(name)) {
      // Rule 3. A program drawing from nowhere. This is the one that catches a glow pass.
      violations.push({ where: d.source, slot: null, why: "draw call from a source that is not a registered layer" });
      continue;
    }
    drawnInstances.set(name, (drawnInstances.get(name) ?? 0) + d.instances);
  }

  for (const layer of layers) {
    let live = 0;
    for (const slot of layer.liveSlots()) {
      live++;
      const key = layer.slotBacking(slot);
      if (key === null) {
        // Rule 1. A slot the layer filled without recording what it was.
        violations.push({ where: layer.name, slot, why: "drawn slot has no backing record" });
        continue;
      }
      if (!ledger.get(key)) {
        // Rule 2. A slot pointing at a record that has been forgotten.
        violations.push({ where: layer.name, slot, why: `backing record ${key} is not in the ledger` });
        continue;
      }
      backed++;
    }
    const drawn = drawnInstances.get(layer.name) ?? 0;
    if (drawn > live) {
      // The count bug: the buffer was drawn further than it was filled, so whatever was left
      // in those slots got rendered. Stale instance data is not a backed light.
      violations.push({
        where: layer.name,
        slot: null,
        why: `drew ${drawn} instances but only ${live} slots are live`,
      });
    }
  }

  return { backed, chrome, violations };
}

export function describeViolations(v: readonly Violation[]): string {
  return v.map((x) => `${x.where}${x.slot === null ? "" : `[${x.slot}]`}: ${x.why}`).join("\n");
}

/** The assertion form. Throws with every violation named, not just the first. */
export function assertEveryLightIsEarned(a: Audit): void {
  if (a.violations.length === 0) return;
  throw new Error(
    `every light is earned: ${a.violations.length} unbacked drawable(s)\n${describeViolations(a.violations)}`,
  );
}
