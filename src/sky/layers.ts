/**
 * Where instance data lives, and the reason a frame does not get more expensive as the sky
 * fills up.
 *
 * Every layer here holds one `Float32Array` that mirrors one GPU buffer, and the contract is
 * the same in all three: **an instance is written once and then only the clock changes.** The
 * shader derives rotation, age, decay, streak growth and ring radius from a uniform, so a
 * frame with four thousand lights and nothing new arriving uploads nothing at all. Per-frame
 * upload cost tracks arrivals, not population.
 *
 * Three shapes, because three access patterns:
 *
 * - `FifoLayer` for meteors and quakes. Arrivals are a stream, every instance has the same
 *   lifetime, so the live set is always a contiguous range of a ring buffer and retiring is
 *   moving one index. Drawing an offset range is why `vertexAttribPointer` takes a byte
 *   offset: WebGL2 has no base-instance parameter, so the offset goes in the pointer instead,
 *   and a live range that has wrapped is two draws rather than one.
 * - `SlotLayer` for aurora cells, visitors and the ISS head. These are keyed and updated in
 *   place: an OVATION cell that reports again should move its own light, not add a second
 *   one. Kept dense with a swap-remove so the draw is still one contiguous range.
 * - `PathLayer` for the ISS track and the horizon. Rewritten whole when they change, which
 *   for the track is once a second and for the horizon is once.
 *
 * **The float32 clock trap.** Instance times are seconds since the sky's own epoch, as
 * float32, because that is what an attribute is. Float32 holds about seven significant
 * digits, so at 86400 seconds the resolution is 5ms and at a month it is 150ms, which would
 * make meteors judder on a long-running tab. `rebase` moves the epoch forward and subtracts
 * the same amount from every stored time; the renderer calls it once an hour. It costs one
 * pass over the buffers and it is the difference between this being safe to leave open for a
 * week and not.
 */
import type { Backing } from "./provenance.ts";
import type { Ledger } from "./provenance.ts";

/** Indices into these arrays are derived from the array's own length, so `!` is a statement
 *  that the bound was already checked rather than a hope that it was. */

export type DrawRange = { first: number; count: number };

export type LayerStats = {
  name: string;
  live: number;
  capacity: number;
  /** Instances pushed out by a newer one before their time. Non-zero means undersized. */
  dropped: number;
};

abstract class BaseLayer {
  readonly data: Float32Array;
  protected readonly keys: (string | null)[];
  protected dirtyLo = Number.POSITIVE_INFINITY;
  protected dirtyHi = Number.NEGATIVE_INFINITY;
  dropped = 0;

  constructor(
    readonly name: string,
    readonly capacity: number,
    readonly stride: number,
    protected readonly ledger: Ledger,
  ) {
    this.data = new Float32Array(capacity * stride);
    this.keys = new Array<string | null>(capacity).fill(null);
  }

  protected touch(slot: number): void {
    if (slot < this.dirtyLo) this.dirtyLo = slot;
    if (slot + 1 > this.dirtyHi) this.dirtyHi = slot + 1;
  }

  /** The range of instances changed since the last call, then clears it. */
  takeDirty(): DrawRange | null {
    if (this.dirtyHi <= this.dirtyLo) return null;
    const r = { first: this.dirtyLo, count: this.dirtyHi - this.dirtyLo };
    this.dirtyLo = Number.POSITIVE_INFINITY;
    this.dirtyHi = Number.NEGATIVE_INFINITY;
    return r;
  }

  slotBacking(slot: number): string | null {
    return this.keys[slot] ?? null;
  }

  abstract liveSlots(): Iterable<number>;
  abstract draws(): DrawRange[];
  abstract stats(): LayerStats;
}

/**
 * A stream of equally short-lived things: meteors and quakes.
 *
 * Overflow drops the oldest, which is almost always the right call because the oldest is
 * nearly dead anyway. Almost always is not always, so it is counted rather than swallowed:
 * a non-zero `dropped` means capacity is below the arrival rate times the lifetime and lights
 * are vanishing early, which is a thing you would otherwise only notice as the sky feeling
 * thin.
 */
export class FifoLayer extends BaseLayer {
  private head = 0;
  private tail = 0;
  private count = 0;
  /** Epoch ms, float64, so retiring is exact however long the tab has been open. */
  private readonly born: Float64Array;

  constructor(name: string, capacity: number, stride: number, ledger: Ledger) {
    super(name, capacity, stride, ledger);
    this.born = new Float64Array(capacity);
  }

  /** `write` fills `stride` floats starting at the given offset. No allocation per push. */
  push(backing: Backing, atMs: number, write: (into: Float32Array, at: number) => void): void {
    if (this.count === this.capacity) {
      this.forgetSlot(this.tail);
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
      this.dropped++;
    }
    const slot = this.head;
    this.keys[slot] = this.ledger.admit(backing);
    this.born[slot] = atMs;
    write(this.data, slot * this.stride);
    this.touch(slot);
    this.head = (this.head + 1) % this.capacity;
    this.count++;
  }

  /** Advance the tail past everything that has outlived `lifeMs`. */
  retire(nowMs: number, lifeMs: number): void {
    while (this.count > 0 && this.born[this.tail]! + lifeMs < nowMs) {
      this.forgetSlot(this.tail);
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
    }
  }

  private forgetSlot(slot: number): void {
    const key = this.keys[slot];
    if (key !== null && key !== undefined) this.ledger.forget(key);
    this.keys[slot] = null;
  }

  *liveSlots(): Iterable<number> {
    for (let i = 0; i < this.count; i++) yield (this.tail + i) % this.capacity;
  }

  draws(): DrawRange[] {
    if (this.count === 0) return [];
    if (this.tail + this.count <= this.capacity) return [{ first: this.tail, count: this.count }];
    // Wrapped. Two draws with different attribute offsets, which is what WebGL2 leaves you
    // with in the absence of a base-instance parameter.
    const firstRun = this.capacity - this.tail;
    return [
      { first: this.tail, count: firstRun },
      { first: 0, count: this.count - firstRun },
    ];
  }

  /** Shift every stored time by `deltaMs`, for the float32 clock rebase. */
  rebase(deltaMs: number, timeFieldOffset: number): void {
    const d = deltaMs / 1000;
    for (const slot of this.liveSlots()) {
      this.data[slot * this.stride + timeFieldOffset]! -= d;
    }
    if (this.count > 0) {
      this.dirtyLo = 0;
      this.dirtyHi = this.capacity;
    }
  }

  stats(): LayerStats {
    return { name: this.name, live: this.count, capacity: this.capacity, dropped: this.dropped };
  }
}

/**
 * Keyed lights that update in place: aurora cells, visitors, the ISS head.
 *
 * Dense by construction. Removing swaps the last live slot into the hole, so the draw stays
 * one range and there are never holes full of stale instance data being rendered because a
 * count was off by one, which is exactly the bug the provenance audit's third rule exists to
 * catch and which this shape makes impossible in the first place.
 */
export class SlotLayer extends BaseLayer {
  private readonly slotOf = new Map<string, number>();
  private readonly keyAt: string[] = [];
  private count = 0;

  /** Reuses the light for this key, or takes a new slot. Returns the slot, or -1 if full. */
  upsert(key: string, backing: Backing, write: (into: Float32Array, at: number, slot: number) => void): number {
    let slot = this.slotOf.get(key);
    if (slot === undefined) {
      if (this.count === this.capacity) {
        this.dropped++;
        return -1;
      }
      slot = this.count++;
      this.slotOf.set(key, slot);
      this.keyAt[slot] = key;
    }
    this.keys[slot] = this.ledger.admit(backing);
    write(this.data, slot * this.stride, slot);
    this.touch(slot);
    return slot;
  }

  slotFor(key: string): number | undefined {
    return this.slotOf.get(key);
  }

  remove(key: string): void {
    const slot = this.slotOf.get(key);
    if (slot === undefined) return;
    const ledgerKey = this.keys[slot];
    if (ledgerKey !== null && ledgerKey !== undefined) this.ledger.forget(ledgerKey);
    this.slotOf.delete(key);

    const last = this.count - 1;
    if (slot !== last) {
      this.data.copyWithin(slot * this.stride, last * this.stride, (last + 1) * this.stride);
      this.keys[slot] = this.keys[last]!;
      const movedKey = this.keyAt[last]!;
      this.keyAt[slot] = movedKey;
      this.slotOf.set(movedKey, slot);
      this.touch(slot);
    }
    this.keys[last] = null;
    this.count = last;
  }

  *liveSlots(): Iterable<number> {
    for (let i = 0; i < this.count; i++) yield i;
  }

  draws(): DrawRange[] {
    return this.count === 0 ? [] : [{ first: 0, count: this.count }];
  }

  rebase(deltaMs: number, timeFieldOffset: number): void {
    const d = deltaMs / 1000;
    for (let i = 0; i < this.count; i++) this.data[i * this.stride + timeFieldOffset]! -= d;
    if (this.count > 0) {
      this.dirtyLo = 0;
      this.dirtyHi = this.count;
    }
  }

  stats(): LayerStats {
    return { name: this.name, live: this.count, capacity: this.capacity, dropped: this.dropped };
  }
}

/**
 * A ribbon along a path: the ISS track, and the horizon.
 *
 * Rewritten whole rather than appended to, because both callers rewrite whole. The track is
 * a sliding window of the last few minutes of fixes and the horizon changes only when the
 * observer moves, so neither has an incremental update worth the bookkeeping.
 *
 * Two vertices per point, side -1 and +1. Every vertex also carries the *next* point so the
 * shader can work out which way the ribbon is going after projecting, which it has to do
 * after rather than before: the projection is not linear, so the direction between two
 * points on the sphere is not the direction between their projections.
 */
export class PathLayer extends BaseLayer {
  private verts = 0;

  constructor(name: string, maxPoints: number, ledger: Ledger) {
    super(name, maxPoints * 2, 6, ledger);
  }

  /**
   * `points` are pairs in whichever space the draw is in, with a brightness and a backing.
   * A backing of null is only legal for declared chrome, and the audit is what enforces that.
   */
  set(points: readonly { a: number; b: number; fade: number; backing: Backing | null }[]): void {
    for (let i = 0; i < this.verts; i++) {
      const k = this.keys[i];
      if (k !== null && k !== undefined) this.ledger.forget(k);
      this.keys[i] = null;
    }
    const n = Math.min(points.length, this.capacity / 2);
    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      // The last point has no next, so it borrows the previous one's direction. Without this
      // the final segment's ribbon collapses to zero width and the track ends in a spike.
      const next = points[Math.min(i + 1, n - 1)]!;
      const prev = points[Math.max(i - 1, 0)]!;
      const ahead = i === n - 1 ? prev : next;
      for (let s = 0; s < 2; s++) {
        const v = i * 2 + s;
        const o = v * 6;
        this.data[o] = p.a;
        this.data[o + 1] = p.b;
        this.data[o + 2] = ahead.a;
        this.data[o + 3] = ahead.b;
        // The borrowed direction points backwards, so the side flips to keep the ribbon from
        // crossing itself at the very end.
        this.data[o + 4] = (s === 0 ? -1 : 1) * (i === n - 1 ? -1 : 1);
        this.data[o + 5] = p.fade;
        this.keys[v] = p.backing ? this.ledger.admit(p.backing) : null;
      }
    }
    this.verts = n * 2;
    this.dirtyLo = 0;
    this.dirtyHi = this.verts;
  }

  *liveSlots(): Iterable<number> {
    for (let i = 0; i < this.verts; i++) yield i;
  }

  draws(): DrawRange[] {
    return this.verts === 0 ? [] : [{ first: 0, count: this.verts }];
  }

  stats(): LayerStats {
    return { name: this.name, live: this.verts, capacity: this.capacity, dropped: this.dropped };
  }
}
