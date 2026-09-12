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
import type { Star } from "./stars.ts";

/**
 * What a light was drawn from. Every arm is a record somebody measured: a feed said this
 * happened, a person is connected right now, or an observatory catalogued this star.
 *
 * **Why `star` is a record and not chrome, at length, because the shortcut was available and
 * is wrong.** The cheap way to get nine thousand stars on screen is to add "stars" to `CHROME`
 * and be done: one name on a frozen list, no ledger, no per-slot bookkeeping, no memory. It
 * would also be false. `CHROME` is for things that are not lights and do not stand for
 * anything that was measured, and its one member says exactly that - a horizon circle is a
 * coordinate reference, drawn in the token for a boundary, carrying no claim about the world.
 * A star is the opposite of that. It has a position Hipparcos measured to milliarcseconds, a
 * magnitude somebody photometered, and a colour index that is a real difference between two
 * real filters, and this renderer draws all three. Filing it as furniture would be the first
 * time the project printed a measurement while telling its own audit the pixel meant nothing.
 *
 * **Why a third arm rather than dressing a star up as an `event`.** A star did not happen. It
 * has no `at`, no `placement`, and no `source` in the sense the feeds use, so a synthetic
 * `SkyEvent` for one would put four fabricated fields into the type whose whole job is that
 * every field is something a source said. The audit does not care how many arms `Backing` has;
 * it cares that a drawn slot names a record and that the record is still there. A new arm
 * satisfies both without inventing anything.
 *
 * **Why this does not weaken `assertEarned`.** The three rules are unchanged and none of them
 * is relaxed for stars. Every star slot is admitted to the ledger individually, through the
 * same `ledger.admit` call every other layer makes, and the layer records the key it got back:
 * a slot written without that key still fails rule 1, and a key the ledger has forgotten still
 * fails rule 2. The catalogue layer is a registered layer, so rule 3's "drew further than it
 * was filled" still applies, and because the buffer is exactly the size of the catalogue there
 * is no spare slot for anything to hide in. The invariant the audit actually enforces is that
 * you cannot put light on this canvas without naming what it came from; nine thousand more
 * lights that each name a catalogue row is that invariant being met, not bypassed.
 *
 * What WOULD bypass it is one record standing for the whole catalogue, so that any rogue slot
 * could point at "the stars" and pass. That is the version this deliberately does not do, and
 * it is why there are 8,920 ledger entries rather than one.
 */
export type Backing =
  | { of: "event"; event: SkyEvent }
  | { of: "visitor"; presence: Presence }
  | { of: "star"; star: Star };

export function backingId(b: Backing): string {
  if (b.of === "event") return `e:${b.event.id}`;
  if (b.of === "visitor") return `v:${b.presence.id}`;
  // The catalogue index, which is the only identity a star has here and is stable for a given
  // generated file. Prefixed like the others so it cannot collide with a revision id.
  return `s:${b.star.index}`;
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
