// ============================================================================
// Byte-bounded scrollback ring with ABSOLUTE cumulative-byte sequence numbers.
//
// `seq` is an absolute count of every byte the PTY has ever produced — it never
// resets and never decreases. The ring retains only the most recent `maxBytes`;
// when it overflows it drops the oldest bytes and RAISES the floor (the absolute
// seq of the oldest byte still retained). Thus:
//
//   floor          = head - size        (absolute seq of oldest retained byte)
//   head           = total produced     (absolute seq of the next byte to come)
//   size           = bytes retained     (<= maxBytes)
//
// Replay is intentionally NOT lossless: snapshotAfter(lastSeq) returns the bytes
// after lastSeq when lastSeq >= floor; otherwise it reports `truncated` so the
// gateway sends a fresh serialized snapshot instead of a byte replay.
//
// Internally a single contiguous backing buffer is used as a true circular
// buffer (head index wraps), so push is amortized O(n) over the bytes written
// and never reallocates after warm-up.
// ============================================================================

export interface SnapshotResult {
  /** Bytes to replay (after lastSeq up to head). Empty when fully caught up. */
  bytes: Uint8Array;
  /** Absolute seq the returned bytes start at (== lastSeq when not truncated). */
  baseSeq: number;
  /** True when lastSeq < floor: caller must send a serialized snapshot instead. */
  truncated: boolean;
}

export class RingBuffer {
  readonly #max: number;
  #buf: Uint8Array;
  /** Index in #buf of the oldest retained byte. */
  #start = 0;
  /** Bytes currently retained (<= capacity). */
  #size = 0;
  /** Absolute seq of the next byte to be produced (== total produced). */
  #head = 0;

  constructor(maxBytes: number) {
    if (maxBytes <= 0) throw new Error('RingBuffer: maxBytes must be > 0');
    this.#max = maxBytes;
    // Lazily-grown backing store, capped at #max. Start modest to avoid
    // allocating the full cap for idle sessions.
    const initial = Math.min(maxBytes, 64 * 1024);
    this.#buf = new Uint8Array(initial);
  }

  /** Absolute seq of the next byte (== total bytes ever produced). */
  get head(): number {
    return this.#head;
  }

  /** Absolute seq of the oldest retained byte. */
  get floor(): number {
    return this.#head - this.#size;
  }

  /** Bytes currently retained. */
  get size(): number {
    return this.#size;
  }

  /** Configured maximum retained bytes. */
  get maxBytes(): number {
    return this.#max;
  }

  /** Grow the backing buffer (preserving logical order) up to the cap. */
  #ensureCapacity(needed: number): void {
    if (this.#buf.length >= needed) return;
    let next = this.#buf.length;
    while (next < needed) next *= 2;
    if (next > this.#max) next = this.#max;
    const grown = new Uint8Array(next);
    // Re-linearize the existing data into the new buffer.
    this.#copyOut(grown, 0, this.#size);
    grown.fill(0, this.#size); // not strictly necessary; keeps it tidy
    this.#buf = grown;
    this.#start = 0;
  }

  /**
   * Copy `len` logical bytes (from logical offset 0 = oldest retained) into
   * `dst` at `dstOffset`, honoring the circular wrap.
   */
  #copyOut(dst: Uint8Array, dstOffset: number, len: number): void {
    const cap = this.#buf.length;
    const first = Math.min(len, cap - this.#start);
    dst.set(this.#buf.subarray(this.#start, this.#start + first), dstOffset);
    if (len > first) {
      dst.set(this.#buf.subarray(0, len - first), dstOffset + first);
    }
  }

  /**
   * Append bytes, advancing `head` by `bytes.length`. If the total would exceed
   * the cap, the oldest bytes are dropped and `floor` rises accordingly. A push
   * larger than the cap keeps only its trailing `maxBytes`.
   */
  push(bytes: Uint8Array): void {
    const n = bytes.length;
    if (n === 0) return;
    this.#head += n;

    if (n >= this.#max) {
      // The incoming chunk alone overflows the ring: keep only its tail.
      if (this.#buf.length < this.#max) this.#buf = new Uint8Array(this.#max);
      this.#buf.set(bytes.subarray(n - this.#max), 0);
      this.#start = 0;
      this.#size = this.#max;
      return;
    }

    this.#ensureCapacity(Math.min(this.#size + n, this.#max));
    const cap = this.#buf.length;

    // Write at the logical end (start + size) wrapping around.
    const writeAt = (this.#start + this.#size) % cap;
    const first = Math.min(n, cap - writeAt);
    this.#buf.set(bytes.subarray(0, first), writeAt);
    if (n > first) this.#buf.set(bytes.subarray(first), 0);

    this.#size += n;
    if (this.#size > this.#max) {
      // Drop oldest: advance start, shrink size. floor rises implicitly.
      const drop = this.#size - this.#max;
      this.#start = (this.#start + drop) % cap;
      this.#size = this.#max;
    }
  }

  /**
   * Replay-or-snapshot decision for a reconnecting client at absolute `lastSeq`.
   *
   *   - lastSeq >= head  -> already current; bytes empty, baseSeq = head.
   *   - floor <= lastSeq < head -> replay bytes (lastSeq..head); baseSeq = lastSeq.
   *   - lastSeq < floor  -> truncated: caller sends a serialized snapshot;
   *                          bytes empty, baseSeq = head.
   */
  snapshotAfter(lastSeq: number): SnapshotResult {
    const head = this.#head;
    const floor = this.floor;

    if (lastSeq >= head) {
      return { bytes: new Uint8Array(0), baseSeq: head, truncated: false };
    }
    if (lastSeq < floor) {
      return { bytes: new Uint8Array(0), baseSeq: head, truncated: true };
    }

    // Replay the suffix after lastSeq.
    const skip = lastSeq - floor; // logical offset into retained bytes
    const len = this.#size - skip;
    const out = new Uint8Array(len);
    // Read starting `skip` bytes in from the oldest retained byte.
    const cap = this.#buf.length;
    const from = (this.#start + skip) % cap;
    const first = Math.min(len, cap - from);
    out.set(this.#buf.subarray(from, from + first), 0);
    if (len > first) out.set(this.#buf.subarray(0, len - first), first);

    return { bytes: out, baseSeq: lastSeq, truncated: false };
  }

  /**
   * Drop the oldest `n` retained bytes (advance start / raise floor by n),
   * keeping the absolute seq counter. Used by the cross-session memory ceiling
   * to trim just enough to fall back under the cap instead of wiping the whole
   * ring. Clamped to the retained size; returns how many bytes were dropped.
   */
  dropOldest(n: number): number {
    if (n <= 0) return 0;
    const drop = Math.min(n, this.#size);
    this.#start = (this.#start + drop) % this.#buf.length;
    this.#size -= drop;
    return drop;
  }

  /** Drop all retained scrollback but KEEP the absolute seq counter (head). */
  evictAll(): void {
    this.#start = 0;
    this.#size = 0;
  }
}
