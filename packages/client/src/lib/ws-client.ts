// ============================================================================
// WsClient — the per-session data-path WebSocket (ONE socket per attached
// session, ARCH §Wire protocol). Binary frames only; no text frames.
//
// FRAMING (see @iagent/shared/protocol): every frame is `prefix ++ payload`.
//   0x01 DATA    — opaque bytes. UP = keystrokes/stdin; DOWN = PTY stdout.
//   0x00 CONTROL — UTF-8 JSON ControlMsg.
//
// BYTE-BASED ACK LOOP (ARCH §Performance #2): we track `renderedBytes`, the
// cumulative count of DOWN-data bytes whose xterm write-callback has fired
// (i.e. actually rendered). We send { t:'ack', bytes:renderedBytes } coalesced
// every ACK_INTERVAL_BYTES or ACK_INTERVAL_MS. The server gates further sends
// on (sentBytes - ackedBytes); we never ACK bytes we merely received.
//
// SEQ / RECONNECT (ARCH §Session persistence): `lastSeq` is the absolute
// cumulative-byte count we have rendered. On (re)connect we send
// attach{sessionId,lastSeq}; the server either replays bytes after lastSeq or,
// if the ring floor passed it, sends a snapshot + truncated marker. The
// 'attached' frame carries the PTY's authoritative size; we fit to it FIRST,
// and only the focused client then issues resize frames.
//
// Reconnect uses exponential backoff, capped (~12 tries / a few minutes).
// ============================================================================

import {
  ACK_INTERVAL_BYTES,
  ACK_INTERVAL_MS,
  PING_INTERVAL_MS,
  decodeFrame,
  encodeControl,
  encodeData,
  type AttachedMsg,
  type ExitMsg,
  type ServerControl,
} from '@iagent/shared';

export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WsClientEvents {
  /** DOWN-data: hand straight to term.write(bytes, () => ack(rendered)). */
  onData(bytes: Uint8Array): void;
  /** attach-ack: fit terminal to msg.cols/rows (PTY authoritative size). */
  onAttached(msg: AttachedMsg): void;
  /** snapshot string (truncated reconnect): term.write(data). */
  onSnapshot(data: string): void;
  /** server-confirmed applied size (apply-then-ack resize echo). */
  onServerResize?(cols: number, rows: number): void;
  /** PTY exited; the socket will then close and we will NOT reconnect. */
  onExit(msg: ExitMsg): void;
  /** connection lifecycle for the StatusBar. */
  onStatus(status: WsStatus): void;
}

// Exponential backoff schedule: ~12 attempts, capped at 30s, ~3.5 min total.
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 12;

export class WsClient {
  private readonly url: string;
  private readonly sessionId: string;
  private readonly ev: WsClientEvents;

  private ws: WebSocket | null = null;
  private closedByCaller = false;
  private ptyExited = false;

  // Absolute cumulative-byte counters (BYTE-based, not codepoint-based).
  /** Bytes whose xterm render-callback has fired (== our view's seq). */
  private renderedBytes = 0;
  /** Last cumulative ack value we actually sent to the server. */
  private ackedSent = 0;
  private ackBytesTimer: ReturnType<typeof setTimeout> | null = null;

  // Reconnect state.
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Keepalive.
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // The PTY size last advertised by the server; the focused client fits to it.
  private serverCols = 0;
  private serverRows = 0;

  constructor(url: string, sessionId: string, ev: WsClientEvents) {
    this.url = url;
    this.sessionId = sessionId;
    this.ev = ev;
  }

  /** Open the socket and attach (sends attach{sessionId,lastSeq}). */
  connect(): void {
    if (this.closedByCaller || this.ptyExited) return;
    this.clearReconnectTimer();

    this.ev.onStatus(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.ev.onStatus('open');
      // Attach with the seq we have already rendered; server replays/snapshots.
      this.sendControl({ t: 'attach', sessionId: this.sessionId, lastSeq: this.renderedBytes });
      this.startPing();
    };

    ws.onmessage = (e) => this.handleMessage(e.data);

    ws.onerror = () => {
      // onclose follows; reconnection is handled there.
    };

    ws.onclose = () => {
      this.stopPing();
      this.flushAck(); // drop any pending ack timer
      this.ws = null;
      if (this.closedByCaller || this.ptyExited) {
        this.ev.onStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  // -- inbound -------------------------------------------------------------

  private handleMessage(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      // Protocol is binary-only; ignore stray text frames defensively.
      return;
    }
    const frame = decodeFrame(new Uint8Array(data));
    if (frame.kind === 'data') {
      const n = frame.bytes.length;
      this.ev.onData(frame.bytes);
      // We do NOT ack here: TerminalView's term.write callback calls
      // noteRendered(n), so we ACK only bytes that actually rendered.
      void n;
      return;
    }
    this.handleControl(frame.msg as ServerControl);
  }

  private handleControl(msg: ServerControl): void {
    switch (msg.t) {
      case 'attached': {
        this.serverCols = msg.cols;
        this.serverRows = msg.rows;
        // baseSeq is where our view now starts; align our rendered counter so
        // future acks are relative to the same absolute seq the server tracks.
        this.renderedBytes = msg.baseSeq;
        this.ackedSent = msg.baseSeq;
        this.ev.onAttached(msg);
        break;
      }
      case 'snapshot': {
        // Sent before 'attached' when truncated; safe to decode (it is a
        // complete escape-sequence string, not a frame-boundary fragment).
        this.ev.onSnapshot(msg.data);
        break;
      }
      case 'resize': {
        this.serverCols = msg.cols;
        this.serverRows = msg.rows;
        this.ev.onServerResize?.(msg.cols, msg.rows);
        break;
      }
      case 'exit': {
        this.ptyExited = true;
        this.ev.onExit(msg);
        // Server closes the socket next; onclose will report 'closed' and we
        // will NOT reconnect (ptyExited gate).
        break;
      }
      case 'pong':
        break;
      case 'ping':
        this.sendControl({ t: 'pong', ts: msg.ts });
        break;
    }
  }

  // -- ACK loop (byte-based, write-callback driven) ------------------------

  /**
   * Called by the renderer's write-callback once `count` more DOWN-data bytes
   * have actually rendered. Advances the cumulative rendered counter and
   * coalesces an ack (every ACK_INTERVAL_BYTES, or after ACK_INTERVAL_MS).
   */
  noteRendered(count: number): void {
    this.renderedBytes += count;
    if (this.renderedBytes - this.ackedSent >= ACK_INTERVAL_BYTES) {
      this.flushAck();
      return;
    }
    if (this.ackBytesTimer === null) {
      this.ackBytesTimer = setTimeout(() => this.flushAck(), ACK_INTERVAL_MS);
    }
  }

  private flushAck(): void {
    if (this.ackBytesTimer !== null) {
      clearTimeout(this.ackBytesTimer);
      this.ackBytesTimer = null;
    }
    if (this.renderedBytes <= this.ackedSent) return;
    if (this.sendControl({ t: 'ack', bytes: this.renderedBytes })) {
      this.ackedSent = this.renderedBytes;
    }
  }

  // -- outbound ------------------------------------------------------------

  /** UP-data: keystrokes/stdin bytes, framed as a DATA frame. */
  sendInput(bytes: Uint8Array): void {
    this.sendRaw(encodeData(bytes));
  }

  /**
   * Send a resize control frame. Caller (TerminalView) debounces this and only
   * the focused client should call it; on attach the PTY size is authoritative.
   */
  sendResize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.sendControl({ t: 'resize', cols, rows });
  }

  /**
   * Push the terminal's serialized screen to the server so a future TRUNCATED
   * reconnect can replay it instead of a blank screen (ARCH §Session
   * persistence). Sent on detach / before unmount, while the socket is open.
   */
  sendSnapshot(data: string): void {
    if (data.length === 0) return;
    this.sendControl({ t: 'clientSnapshot', data });
  }

  /** The PTY size the server last advertised (authoritative on attach). */
  get serverSize(): { cols: number; rows: number } {
    return { cols: this.serverCols, rows: this.serverRows };
  }

  /** Cumulative bytes rendered so far (== reconnect lastSeq). */
  get lastSeq(): number {
    return this.renderedBytes;
  }

  private sendControl(msg: Parameters<typeof encodeControl>[0]): boolean {
    return this.sendRaw(encodeControl(msg));
  }

  private sendRaw(frame: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      // Browser WebSocket has no -1/drain backpressure surface like Bun.serve;
      // bufferedAmount is the only signal. We still send (keystrokes/acks are
      // tiny); server-side flow control gates the heavy DOWN-data direction.
      // Send the backing ArrayBuffer slice: the DOM `send` overload rejects a
      // Uint8Array whose buffer is the SharedArrayBuffer-widened ArrayBufferLike.
      ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
      return true;
    } catch {
      return false;
    }
  }

  // -- keepalive -----------------------------------------------------------

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendControl({ t: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // -- reconnect -----------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.ptyExited) {
      this.ev.onStatus('closed');
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.ev.onStatus('closed');
      return;
    }
    const attempt = this.reconnectAttempts++;
    // Exponential backoff with full jitter, capped.
    const ceil = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const delay = Math.random() * ceil;
    this.ev.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -- teardown ------------------------------------------------------------

  /** Close the socket for good (lazy-detach or component teardown). */
  close(): void {
    this.closedByCaller = true;
    this.clearReconnectTimer();
    this.stopPing();
    if (this.ackBytesTimer !== null) {
      clearTimeout(this.ackBytesTimer);
      this.ackBytesTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ev.onStatus('closed');
  }
}
