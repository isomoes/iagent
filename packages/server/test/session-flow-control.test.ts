// Flow-control tests for Session using a FAKE Pty (no real terminal) and a FAKE
// SessionSocket. Asserts byte-based seq accounting, high/low watermark gating,
// socket-backpressure pause, and ack-/drain-driven resume. No real PTY spawns.

import { describe, expect, test } from 'bun:test';
import {
  PREFIX_CONTROL,
  PREFIX_DATA,
  decodeFrame,
  type ServerConfig,
} from '@iagent/shared';
import { Session, type AgentSpec, type SessionSocket } from '../src/session.js';
import type { Pty } from '../src/pty.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A push-only fake PTY: tests drive output via emit(); records writes. */
class FakePty implements Pty {
  cols: number;
  rows: number;
  readonly pid = 4242;
  written: Uint8Array[] = [];
  killed = false;
  closed = false;
  #dataCb: ((b: Uint8Array) => void) | null = null;
  #exitCb: ((c: number, s: string | null) => void) | null = null;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  write(d: Uint8Array): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  setRawMode(): void {}
  onData(cb: (b: Uint8Array) => void): void {
    this.#dataCb = cb;
  }
  onExit(cb: (c: number, s: string | null) => void): void {
    this.#exitCb = cb;
  }
  kill(): void {
    this.killed = true;
  }
  close(): void {
    this.closed = true;
  }
  ref(): void {}
  unref(): void {}
  // test hooks
  emit(b: Uint8Array): void {
    this.#dataCb?.(b);
  }
  exit(code: number, signal: string | null = null): void {
    this.#exitCb?.(code, signal);
  }
}

/** Fake socket that records frames and can simulate backpressure. */
class FakeSocket implements SessionSocket {
  frames: Uint8Array[] = [];
  /** When >0, the next N send() calls return -1 (backpressure). */
  failNext = 0;
  /** When >0, the next N DATA send() calls return -1 (control still passes). */
  failNextData = 0;
  closedCode: number | null = null;

  send(frame: Uint8Array): number {
    if (this.failNext > 0) {
      this.failNext--;
      return -1; // backpressured: NOT recorded as sent
    }
    if (frame[0] === PREFIX_DATA && this.failNextData > 0) {
      this.failNextData--;
      return -1; // backpressured DATA send: NOT recorded as sent
    }
    this.frames.push(frame);
    return frame.length;
  }
  cork(fn: () => void): void {
    fn();
  }
  close(code?: number): void {
    this.closedCode = code ?? 1000;
  }

  // helpers
  dataFrames(): Uint8Array[] {
    return this.frames.filter((f) => f[0] === PREFIX_DATA);
  }
  /** Total data-payload bytes received (excludes the 1-byte prefix). */
  dataBytes(): number {
    return this.dataFrames().reduce((n, f) => n + (f.length - 1), 0);
  }
  controlOf<T extends string>(t: T): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const f of this.frames) {
      if (f[0] !== PREFIX_CONTROL) continue;
      const d = decodeFrame(f);
      if (d.kind === 'control' && d.msg.t === t) out.push(d.msg as Record<string, unknown>);
    }
    return out;
  }
}

// ── Config / spec helpers ─────────────────────────────────────────────────────

function makeCfg(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 4517,
    token: 'test',
    allowedOrigins: [],
    agentCmd: 'fake',
    agentArgs: [],
    agentCwd: '.',
    agentEnv: {},
    maxSessions: 16,
    ringBytesPerSession: 1 << 20,
    totalRingBytes: 1 << 24,
    idleGcMs: 0,
    highWatermark: 1000,
    lowWatermark: 200,
    batchMs: 5,
    batchBytes: 1, // flush on every push -> deterministic, no timers
    ...over,
  };
}

const spec: AgentSpec = {
  agent: 'shell',
  cmd: 'fake',
  args: [],
  cwd: '.',
  env: {},
  cols: 80,
  rows: 24,
  title: 'test',
};

function startSession(cfg: ServerConfig): { session: Session; pty: FakePty } {
  let pty!: FakePty;
  const session = new Session('s1', 'local', spec, cfg, {
    spawnPty: (s) => {
      pty = new FakePty(s.cols, s.rows);
      return pty;
    },
  });
  session.start();
  return { session, pty };
}

const chunk = (n: number, fill = 65) => new Uint8Array(n).fill(fill);

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Session attach + replay (byte seq)', () => {
  test('fresh attach (lastSeq=0) on empty session sends attached baseSeq=0', () => {
    const cfg = makeCfg();
    const { session } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);

    const attached = sock.controlOf('attached');
    expect(attached.length).toBe(1);
    expect(attached[0]!.baseSeq).toBe(0);
    expect(attached[0]!.truncated).toBe(false);
    expect(attached[0]!.cols).toBe(80);
    expect(attached[0]!.rows).toBe(24);
    expect(sock.dataBytes()).toBe(0);
  });

  test('attach after buffered output replays bytes after lastSeq', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    // Produce 100 bytes BEFORE any socket is attached (lives only in the ring).
    pty.emit(chunk(100));

    const sock = new FakeSocket();
    session.attach(sock, 40); // client already has 40
    expect(sock.controlOf('attached')[0]!.baseSeq).toBe(40);
    expect(sock.dataBytes()).toBe(60); // replays bytes 40..100
  });

  test('attach replay under backpressure pauses; drain resends the full suffix', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    // 100 bytes buffered while detached.
    pty.emit(chunk(100));

    const sock = new FakeSocket();
    sock.failNextData = 1; // the replay DATA send is backpressured (-1); the 'attached' control still passes
    session.attach(sock, 40); // would replay bytes 40..100 (60 bytes)

    // The replay send was backpressured: NOTHING was delivered (the -1 must not
    // be treated as success and advance sentBytes past un-sent bytes).
    expect(sock.dataBytes()).toBe(0);
    // The attached control frame still went out (it preceded the failing send).
    expect(sock.controlOf('attached')[0]!.baseSeq).toBe(40);

    // Drain clears backpressure -> the full replayed suffix is re-derived and
    // resent (no phantom advance, no lost bytes).
    session.onDrain();
    expect(sock.dataBytes()).toBe(60);
  });

  test('attach with lastSeq below ring floor -> truncated, baseSeq=head', () => {
    const cfg = makeCfg({ ringBytesPerSession: 50 });
    const { session, pty } = startSession(cfg);
    pty.emit(chunk(200)); // ring keeps only last 50; floor=150

    const sock = new FakeSocket();
    session.attach(sock, 10); // older than floor
    const att = sock.controlOf('attached')[0]!;
    expect(att.truncated).toBe(true);
    expect(att.baseSeq).toBe(200); // view resets to head
    expect(sock.dataBytes()).toBe(0); // no byte replay when truncated
  });
});

describe('Session live streaming + flow control', () => {
  test('live output after attach streams as data frames; seq accounting holds', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);

    pty.emit(chunk(10));
    pty.emit(chunk(20));
    expect(sock.dataBytes()).toBe(30);
  });

  test('high watermark stops sending; ack catch-up below low resumes', () => {
    const cfg = makeCfg({ highWatermark: 100, lowWatermark: 40 });
    const { session, pty } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);

    // Emit 100 bytes -> inflight reaches the high watermark.
    pty.emit(chunk(100));
    expect(sock.dataBytes()).toBe(100);

    // Now inflight (100) >= HIGH (100): further output is withheld (ring only).
    pty.emit(chunk(50));
    expect(sock.dataBytes()).toBe(100); // still gated

    // Client acks 70 rendered -> inflight = 100-70 = 30 <= LOW(40): resume.
    session.applyAck(70);
    // Resume flushes the withheld 50 (bytes 100..150).
    expect(sock.dataBytes()).toBe(150);
  });

  test('socket backpressure (send -1) pauses; drain resumes from sentBytes', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);

    sock.failNext = 1; // the next data send returns -1 (backpressured)
    pty.emit(chunk(30)); // attempted, fails -> nothing recorded, paused
    expect(sock.dataBytes()).toBe(0);

    // More output while paused stays in the ring.
    pty.emit(chunk(20));
    expect(sock.dataBytes()).toBe(0);

    // Drain clears backpressure -> resends the unsent suffix (all 50 bytes).
    session.onDrain();
    expect(sock.dataBytes()).toBe(50);
  });

  test('ack is clamped to sentBytes and is monotonic', () => {
    const cfg = makeCfg({ highWatermark: 1000, lowWatermark: 200 });
    const { session, pty } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);
    pty.emit(chunk(50));
    // Over-ack beyond what was sent: clamps; a later in-range ack still applies.
    session.applyAck(99999);
    session.applyAck(10); // regression ignored (monotonic)
    // No throw, accounting stays consistent: emit more and it still flushes.
    pty.emit(chunk(10));
    expect(sock.dataBytes()).toBe(60);
  });
});

describe('Session input / resize / exit', () => {
  test('writeInput forwards raw bytes to the PTY (never decoded)', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    const input = Uint8Array.from([0xe2, 0x9c, 0x93]); // a split-prone multibyte char
    session.writeInput(input);
    expect(pty.written.length).toBe(1);
    expect(Array.from(pty.written[0]!)).toEqual([0xe2, 0x9c, 0x93]);
  });

  test('resize applies to PTY and echoes a resize control frame', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);
    session.resize(120, 40);
    expect(pty.cols).toBe(120);
    expect(pty.rows).toBe(40);
    const echoes = sock.controlOf('resize');
    expect(echoes.at(-1)).toMatchObject({ cols: 120, rows: 40 });
    // The PTY's current size is now authoritative on a re-attach.
    const sock2 = new FakeSocket();
    session.attach(sock2, 0);
    expect(sock2.controlOf('attached')[0]).toMatchObject({ cols: 120, rows: 40 });
  });

  test('PTY exit sends an exit control frame and closes the socket', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);
    pty.exit(0, null);
    expect(sock.controlOf('exit').at(-1)).toMatchObject({ code: 0, signal: null });
    expect(sock.closedCode).toBe(1000);
    expect(session.alive).toBe(false);
  });

  test('detach keeps the PTY running (tmux-like); reattach replays from lastSeq', () => {
    const cfg = makeCfg();
    const { session, pty } = startSession(cfg);
    const sock = new FakeSocket();
    session.attach(sock, 0);
    pty.emit(chunk(30));
    expect(sock.dataBytes()).toBe(30);

    session.detach();
    expect(session.alive).toBe(true); // still running
    pty.emit(chunk(20)); // produced while detached -> ring only

    const sock2 = new FakeSocket();
    session.attach(sock2, 30); // client had 30
    expect(sock2.dataBytes()).toBe(20); // replays the 20 produced while detached
  });
});
