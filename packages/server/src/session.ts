// ============================================================================
// Session — one running agent PTY + its scrollback ring + at most one attached
// socket, with byte-based flow control and output coalescing.
//
// PTY output path (per ARCH §Performance):
//   pty.onData -> ring.push (always; the ring is the only sink for a detached
//   session and the throttle for an attached one) -> coalesce on a ~batchMs
//   timer / batchBytes threshold -> flush ONE data frame per batch, gated by:
//     (a) the byte-based high/low watermark on unacked bytes, and
//     (b) socket backpressure (send() === -1 -> wait for drain()).
//
// Flow control is byte-based and absolute:
//   producedBytes  = ring.head           (cumulative bytes the PTY has emitted)
//   sentBytes      = cumulative bytes flushed to the socket
//   ackedBytes     = last ack.bytes the client reported as RENDERED
//   inflight       = sentBytes - ackedBytes
// We stop flushing when inflight >= highWatermark and resume as soon as an ack
// drops it back below highWatermark (the gate that stopped us) — so we never
// strand permitted-but-unsent bytes in a dead band. Un-sent bytes wait in the
// ring (lossy under overflow, by design). The PTY is never paused.
//
// The socket is abstracted behind `SessionSocket` so the WS gateway (real Bun
// ServerWebSocket) and tests (a fake) share the exact same Session code.
// ============================================================================

import {
  encodeControl,
  encodeData,
  type AgentKind,
  type ServerConfig,
  type SessionSummary,
} from '@iagent/shared';
import type { Pty } from './pty.js';
import { spawnBunPty } from './pty.js';
import { RingBuffer } from './ring-buffer.js';
import type { Principal } from './auth.js';

/** Fully-resolved spawn spec (defaults already merged from config + request). */
export interface AgentSpec {
  agent: AgentKind;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  title: string;
}

/**
 * The attached transport, as Session sees it. The WS gateway implements this
 * over a Bun ServerWebSocket; tests implement an in-memory fake.
 */
export interface SessionSocket {
  /**
   * Send one already-framed binary message. Returns the Bun send status:
   * a positive byte count on success, -1 if backpressured, 0 if dropped.
   * Session treats <= 0 as "could not send" and waits for onDrain().
   */
  send(frame: Uint8Array): number;
  /**
   * Batch multiple send() calls into one syscall (Bun ws.cork). The default
   * impl just runs the callback (fine for the fake / tests).
   */
  cork(fn: () => void): void;
  /** Close the socket (optionally with a code). */
  close(code?: number): void;
}

/** Hooks the PTY-spawn can be overridden for tests (no real terminal). */
export interface SessionDeps {
  spawnPty?: (spec: AgentSpec) => Pty;
}

const SEND_OK = (status: number) => status > 0;

export class Session {
  readonly id: string;
  readonly owner: Principal;
  readonly #cfg: ServerConfig;
  readonly #spec: AgentSpec;
  readonly #ring: RingBuffer;
  readonly #spawnPty: (spec: AgentSpec) => Pty;

  #pty: Pty | null = null;
  #cols: number;
  #rows: number;

  // Lifecycle / bookkeeping for the REST summary.
  readonly #createdAt = Date.now();
  #lastActivity = Date.now();
  #alive = false;
  #exitCode: number | null = null;
  #exitSignal: string | null = null;

  // Single attached socket (lazy attach: at most one live socket per session).
  #socket: SessionSocket | null = null;
  #sentBytes = 0;
  #ackedBytes = 0;
  #socketPaused = false; // true after send() returned <= 0, until onDrain()

  // Latest @xterm/addon-serialize screen pushed by the client that last held
  // it (the server has no terminal model). Replayed on a TRUNCATED reconnect so
  // the client reconstructs the screen instead of starting blank.
  #clientSnapshot = '';

  // Output coalescing. The ring (sentBytes..head) is the source of truth for
  // WHAT to send; the timer only decides WHEN. No separate queue is needed.
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, owner: Principal, spec: AgentSpec, cfg: ServerConfig, deps: SessionDeps = {}) {
    this.id = id;
    this.owner = owner;
    this.#cfg = cfg;
    this.#spec = spec;
    this.#cols = spec.cols;
    this.#rows = spec.rows;
    this.#ring = new RingBuffer(cfg.ringBytesPerSession);
    this.#spawnPty = deps.spawnPty ?? ((s) => spawnBunPty(s));
  }

  // ── Public read-only views ────────────────────────────────────────────────

  get alive(): boolean {
    return this.#alive;
  }

  get cols(): number {
    return this.#cols;
  }
  get rows(): number {
    return this.#rows;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  /** True while a live client socket is attached (lazy attach). */
  get attached(): boolean {
    return this.#socket !== null;
  }

  /** Bytes currently held in this session's scrollback ring. */
  get bufferedBytes(): number {
    return this.#ring.size;
  }

  /** Live, serializable view for the REST layer. */
  get summary(): SessionSummary {
    return {
      id: this.id,
      title: this.#spec.title,
      agent: this.#spec.agent,
      cwd: this.#spec.cwd,
      cols: this.#cols,
      rows: this.#rows,
      createdAt: this.#createdAt,
      lastActivity: this.#lastActivity,
      alive: this.#alive,
      exitCode: this.#exitCode,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Spawn the PTY and wire output -> ring + coalesced broadcast, plus exit. */
  start(): void {
    if (this.#pty) return;
    const pty = this.#spawnPty(this.#spec);
    this.#pty = pty;
    this.#alive = true;

    pty.onData((bytes) => this.#onPtyData(bytes));
    pty.onExit((code, signal) => this.#onPtyExit(code, signal));
  }

  #onPtyData(bytes: Uint8Array): void {
    this.#lastActivity = Date.now();
    // The ring ALWAYS absorbs first — it is the sink for detached sessions and
    // the throttle for attached ones.
    this.#ring.push(bytes);
    // Coalesce; the flush decides whether the socket can take it right now.
    this.#enqueue(bytes);
  }

  #onPtyExit(code: number, signal: string | null): void {
    this.#alive = false;
    this.#exitCode = code;
    this.#exitSignal = signal;
    this.#lastActivity = Date.now();
    // Flush whatever is queued, then notify + close the socket.
    this.#flush();
    if (this.#socket) {
      this.#socket.send(encodeControl({ t: 'exit', code, signal }));
      this.#socket.close(1000);
      // Drop our reference: the PTY is dead and this socket is closing, so the
      // session is now orphaned and the idle-GC's dead-and-detached branch can
      // reap it on the next sweep (don't wait on the ws close handler).
      this.#socket = null;
      this.#socketPaused = false;
    }
  }

  // ── Input / resize ────────────────────────────────────────────────────────

  /** Raw keystrokes/stdin from the client -> PTY. Never decoded. */
  writeInput(bytes: Uint8Array): void {
    if (!this.#pty || !this.#alive) return;
    this.#lastActivity = Date.now();
    this.#pty.write(bytes);
  }

  /**
   * Cache the client's latest serialized screen (@xterm/addon-serialize),
   * pushed before it detaches. Used to satisfy ARCH §Session persistence: a
   * truncated reconnect replays this snapshot instead of leaving a blank screen.
   */
  setClientSnapshot(data: string): void {
    this.#clientSnapshot = data;
  }

  /** Apply a resize to the PTY then echo it back to the attached client. */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.#cols = cols;
    this.#rows = rows;
    this.#lastActivity = Date.now();
    this.#pty?.resize(cols, rows);
    // apply-then-ack: confirm the applied size to the focused client.
    this.#socket?.send(encodeControl({ t: 'resize', cols, rows }));
  }

  // ── Attach / detach ────────────────────────────────────────────────────────

  /**
   * Attach `socket` at absolute `lastSeq`. Decides replay-vs-snapshot, sends
   * the snapshot (if truncated) + the `attached` control frame (PTY's CURRENT
   * size is authoritative) + any replay bytes, then becomes the live sink.
   *
   * `serializeSnapshot` produces the @xterm/addon-serialize string when a
   * truncation forces a snapshot; the gateway may supply it (server has no
   * terminal model of its own — it only buffers raw bytes). When omitted it
   * falls back to the last client-pushed snapshot (setClientSnapshot); if that
   * is also empty, a truncation simply resets the client's baseSeq to head.
   */
  attach(socket: SessionSocket, lastSeq: number, serializeSnapshot?: () => string): void {
    const snapshotFn = serializeSnapshot ?? (() => this.#clientSnapshot);
    // Replace any prior socket (lazy attach: one live socket per session).
    this.detach();
    this.#socket = socket;

    const snap = this.#ring.snapshotAfter(lastSeq);
    let baseSeq = snap.baseSeq;

    socket.cork(() => {
      if (snap.truncated) {
        const data = snapshotFn();
        if (data.length > 0) {
          socket.send(encodeControl({ t: 'snapshot', data }));
        }
        baseSeq = this.#ring.head; // client's view starts fresh at head
      }

      socket.send(
        encodeControl({
          t: 'attached',
          sessionId: this.id,
          cols: this.#cols,
          rows: this.#rows,
          baseSeq,
          truncated: snap.truncated,
        }),
      );

      // The client now has everything up to baseSeq.
      this.#sentBytes = baseSeq;
      this.#ackedBytes = baseSeq;
      this.#socketPaused = false;

      // Replay raw bytes after lastSeq (none when truncated or fully current).
      // Mirror #flush: branch on the SEND status, NOT raw truthiness (-1 is
      // truthy). On backpressure (-1) or drop (0) the bytes stay in the ring;
      // #sentBytes is unchanged (== baseSeq) so the suffix is re-derived after
      // onDrain(), and we pause so live flushes don't pile onto a full socket.
      if (!snap.truncated && snap.bytes.length > 0) {
        const status = this.#sendData(snap.bytes);
        if (SEND_OK(status)) {
          this.#sentBytes += snap.bytes.length;
        } else {
          this.#socketPaused = true; // wait for onDrain(); re-derive from #sentBytes (=baseSeq)
        }
      }
    });

    this.#lastActivity = Date.now();
  }

  /** Detach the current socket (PTY KEEPS running — tmux-like). */
  detach(socket?: SessionSocket): void {
    if (socket && socket !== this.#socket) return;
    this.#socket = null;
    this.#socketPaused = false;
    // Any unsent bytes are still in the ring and replayed on the next attach
    // via lastSeq; nothing buffered separately to drop.
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  // ── Flow control ────────────────────────────────────────────────────────────

  /** Client ack of cumulative RENDERED bytes; may unblock a paused flush. */
  applyAck(bytes: number): void {
    // Monotonic, clamped: never exceed what we've actually sent, never regress.
    if (bytes > this.#ackedBytes) this.#ackedBytes = Math.min(bytes, this.#sentBytes);
    // Resume as soon as the ack drops us back below the gate that STOPPED us
    // (the high watermark). #kickFlush already no-ops unless #canSend (inflight
    // < high) && unsent > 0, so this preserves the high-watermark stop gate
    // while removing the (low, high) dead band where sending was permitted but
    // nothing re-armed the flush. (ARCH §Performance #2: "resumes on catch-up".)
    this.#kickFlush();
  }

  /** Bun drain event: socket backpressure cleared -> resume flushing. */
  onDrain(): void {
    this.#socketPaused = false;
    this.#kickFlush();
  }

  get #inflight(): number {
    return this.#sentBytes - this.#ackedBytes;
  }

  /** Can we flush right now? Gated by watermark + socket backpressure. */
  get #canSend(): boolean {
    return (
      this.#socket !== null &&
      !this.#socketPaused &&
      this.#inflight < this.#cfg.highWatermark
    );
  }

  // ── Output coalescing ───────────────────────────────────────────────────────

  /** Bytes the ring holds that the socket has not yet been sent. */
  get #unsentBytes(): number {
    // Clamp: if sentBytes fell below the floor under overflow it'll be bumped
    // up in #flush; here just report the non-negative gap to head.
    return this.#ring.head - Math.max(this.#sentBytes, this.#ring.floor);
  }

  /**
   * On new PTY output: flush now if we've accumulated >= batchBytes of unsent
   * data, otherwise arm the ~batchMs coalescing timer. The payload itself is
   * always re-derived from the ring at flush time.
   */
  #enqueue(_bytes: Uint8Array): void {
    if (!this.#socket) return; // detached: bytes live only in the ring
    if (!this.#canSend) return; // gated: a later ack/drain will kick a flush
    if (this.#unsentBytes >= this.#cfg.batchBytes) {
      this.#flush();
    } else if (!this.#flushTimer && this.#unsentBytes > 0) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        this.#flush();
      }, this.#cfg.batchMs);
    }
  }

  /** Resume point after an ack catch-up or a socket drain. */
  #kickFlush(): void {
    if (this.#canSend && this.#unsentBytes > 0) this.#flush();
  }

  /**
   * Flush the unsent ring suffix (sentBytes..head) as ONE coalesced data frame,
   * if the watermark + socket permit. On a failed send the bytes stay in the
   * ring (sentBytes unchanged) and are re-derived on the next resume.
   */
  #flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (!this.#socket || !this.#canSend) return;

    // If heavy overflow while paused pushed sentBytes below the ring floor, the
    // gap is unrecoverable — jump forward to the floor (old bytes gone, by
    // design — see ARCH §Multi-session "detached draining").
    const floor = this.#ring.floor;
    if (this.#sentBytes < floor) {
      this.#sentBytes = floor;
      if (this.#ackedBytes < floor) this.#ackedBytes = floor;
    }

    const { bytes: payload } = this.#ring.snapshotAfter(this.#sentBytes);
    if (payload.length === 0) return;

    this.#socket.cork(() => {
      const status = this.#sendData(payload);
      if (SEND_OK(status)) {
        this.#sentBytes += payload.length;
      } else {
        // Backpressure (-1) or dropped (0): pause until drain. Bytes stay in
        // the ring; sentBytes is unchanged so the suffix is recomputed later.
        this.#socketPaused = true;
      }
    });
  }

  /** Frame + send a data payload. Returns the raw send status. */
  #sendData(bytes: Uint8Array): number {
    if (!this.#socket) return 0;
    return this.#socket.send(encodeData(bytes));
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /** Kill the PTY (proc.kill -> terminal.close) and tear down sockets. */
  kill(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#pty?.close();
    this.#alive = false;
    if (this.#socket) {
      this.#socket.close(1000);
      this.#socket = null;
    }
  }

  /** Drop scrollback to reclaim memory (keeps the absolute seq counter). */
  evictScrollback(): void {
    this.#ring.evictAll();
  }

  /**
   * Drop up to `n` of the OLDEST retained scrollback bytes (raises the ring
   * floor) to reclaim memory under the cross-session ceiling, without wiping
   * the whole buffer. Returns the number of bytes actually dropped.
   */
  trimScrollback(n: number): number {
    return this.#ring.dropOldest(n);
  }
}
