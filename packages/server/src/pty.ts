// ============================================================================
// PTY backend — a small interface over the OS pseudo-terminal, plus a
// Bun-native implementation (`BunPty`) built on `Bun.Terminal` + `Bun.spawn`
// (Bun >= 1.3.5).
//
// `Bun.Terminal` is PUSH-ONLY: it exposes write / resize / setRawMode /
// ref / unref / close and delivers output via a `data(term, bytes)` callback.
// There is NO pause()/resume() — backpressure is handled downstream on the
// socket + ring buffer (see Session), never on the producer.
//
// Process exit is observed via the spawned process's `proc.exited` promise,
// NOT the terminal's `exit` callback (which reports PTY-stream lifecycle, not
// the subprocess exit code). Teardown is `proc.kill()` then `terminal.close()`.
//
// ── node-pty fallback seam ──────────────────────────────────────────────────
// The `Pty` interface is the contract a future `NodePty` adapter must satisfy
// (e.g. for Windows or true producer pausing). A node-pty adapter would also
// expose pause()/resume(); those are intentionally absent here because
// Bun.Terminal cannot pause. Keep this interface stable so the adapter slots
// in without touching Session / SessionManager.
// ============================================================================

/** Options used to spawn an agent process inside a fresh PTY. */
export interface PtySpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** TERM name reported to the child; defaults to "xterm-256color". */
  name?: string;
}

/**
 * Minimal PTY contract. Implemented by `BunPty` (Bun.Terminal) and, in the
 * future, a node-pty adapter. Deliberately omits pause/resume — Bun.Terminal
 * is push-only and the design throttles downstream, not at the producer.
 */
export interface Pty {
  /** Write raw bytes (keystrokes / stdin) to the child. */
  write(data: Uint8Array): void;
  /** Resize the PTY window; the child receives SIGWINCH. */
  resize(cols: number, rows: number): void;
  /** Toggle raw mode (no line discipline / echo). */
  setRawMode(raw: boolean): void;
  /**
   * Subscribe to PTY output (stdout + stderr interleaved). At most one handler;
   * the latest registration wins. Bytes are opaque — never decode at a chunk
   * boundary (multibyte UTF-8 may split across chunks).
   */
  onData(cb: (bytes: Uint8Array) => void): void;
  /**
   * Subscribe to PROCESS exit (from proc.exited). `code` is the subprocess exit
   * code; `signal` the terminating signal name (or null).
   */
  onExit(cb: (code: number, signal: string | null) => void): void;
  /** Send a signal to the child (default SIGTERM-equivalent). */
  kill(signal?: string): void;
  /** Tear down: kill the process then close the terminal. Idempotent. */
  close(): void;
  /** Keep the event loop alive while this PTY is referenced. */
  ref(): void;
  /** Allow the event loop to exit even if this PTY is still open. */
  unref(): void;

  readonly cols: number;
  readonly rows: number;
  readonly pid: number;

  // DEFERRED node-pty adapter seam — Bun.Terminal cannot pause.
  pause?(): void;
  resume?(): void;
}

/**
 * Bun-native PTY: wraps `Bun.Terminal` + `Bun.spawn({ terminal })`.
 *
 * Lifecycle:
 *   - construct Terminal with the data/exit/drain callbacks
 *   - spawn the agent attached to it
 *   - proc.exited resolves -> fire onExit, mark dead
 *   - close() -> proc.kill() then terminal.close()
 */
class BunPty implements Pty {
  readonly pid: number;
  #cols: number;
  #rows: number;
  readonly #term: Bun.Terminal;
  readonly #proc: Bun.Subprocess;
  #dataCb: ((bytes: Uint8Array) => void) | null = null;
  #exitCb: ((code: number, signal: string | null) => void) | null = null;
  #closed = false;
  #exited = false;

  constructor(opts: PtySpawnOpts) {
    this.#cols = opts.cols;
    this.#rows = opts.rows;

    this.#term = new Bun.Terminal({
      cols: opts.cols,
      rows: opts.rows,
      name: opts.name ?? 'xterm-256color',
      data: (_term, bytes) => {
        // Opaque bytes straight through — NEVER decoded here.
        this.#dataCb?.(bytes);
      },
      // PTY-stream lifecycle only (EOF/read-error). The authoritative
      // process-exit signal comes from proc.exited below; we intentionally do
      // NOT treat this as process exit.
      exit: () => {},
    });

    this.#proc = Bun.spawn([opts.cmd, ...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      terminal: this.#term,
    });
    this.pid = this.#proc.pid;

    // Authoritative exit detection: the subprocess's exited promise (NOT the
    // terminal's exit callback, which reports PTY-stream lifecycle).
    void this.#proc.exited.then((code) => {
      if (this.#exited) return;
      this.#exited = true;
      const signal = this.#proc.signalCode ?? null;
      this.#exitCb?.(code, signal);
    });
  }

  write(data: Uint8Array): void {
    if (this.#closed) return;
    this.#term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.#closed) return;
    if (cols === this.#cols && rows === this.#rows) return;
    this.#cols = cols;
    this.#rows = rows;
    this.#term.resize(cols, rows);
    // Bun.Terminal updates the winsize but leaves the child without a foreground
    // pgrp, so the kernel never sends SIGWINCH and TUI agents don't repaint until
    // the next keystroke. Send it ourselves (setsid => pgid == pid). Remove once
    // Bun sets the PTY foreground pgrp natively.
    try {
      process.kill(-this.#proc.pid, 'SIGWINCH');
    } catch {
      try {
        process.kill(this.#proc.pid, 'SIGWINCH');
      } catch {}
    }
  }

  setRawMode(raw: boolean): void {
    if (this.#closed) return;
    this.#term.setRawMode(raw);
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.#dataCb = cb;
  }

  onExit(cb: (code: number, signal: string | null) => void): void {
    this.#exitCb = cb;
  }

  kill(signal?: string): void {
    if (this.#proc.killed) return;
    // Bun.spawn kill accepts a signal name or number; default is SIGTERM.
    this.#proc.kill(signal as NodeJS.Signals | undefined);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Teardown order per ARCH: kill the process, then close the terminal.
    try {
      if (!this.#proc.killed) this.#proc.kill();
    } catch {
      // process may already be gone
    }
    try {
      if (!this.#term.closed) this.#term.close();
    } catch {
      // terminal may already be closed
    }
  }

  ref(): void {
    this.#term.ref();
    this.#proc.ref();
  }

  unref(): void {
    this.#term.unref();
    this.#proc.unref();
  }

  get cols(): number {
    return this.#cols;
  }
  get rows(): number {
    return this.#rows;
  }
}

/** Spawn a Bun-native PTY running the configured agent command. */
export function spawnBunPty(opts: PtySpawnOpts): Pty {
  return new BunPty(opts);
}
