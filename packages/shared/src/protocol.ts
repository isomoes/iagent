// ============================================================================
// Wire protocol — THE contract both server and client import.
//
// Every WebSocket message on a session socket is a SINGLE binary frame
// (ArrayBuffer / Uint8Array). No text frames, no permessage-deflate.
//
//   byte[0]   = channel prefix  (0x01 = DATA, 0x00 = CONTROL)
//   byte[1..] = payload
//
// DATA frames carry an OPAQUE byte stream and are NEVER decoded as text at a
// frame boundary: batching/chunking can split a multibyte UTF-8 codepoint
// across two frames, so down-data goes straight to term.write(Uint8Array)
// (xterm buffers partial codepoints) and up-data is the raw bytes from
// term.onData. seq/ACK accounting is BYTE-based, never codepoint-based; no
// seq/length is embedded inside a data frame (each side maintains an absolute
// cumulative-byte counter instead).
//
// CONTROL frames carry UTF-8 JSON of one ControlMsg. Always small; never
// carries terminal data except the snapshot string on reconnect.
// ============================================================================

/** Channel prefix for CONTROL frames (UTF-8 JSON ControlMsg). */
export const PREFIX_CONTROL = 0x00 as const;
/** Channel prefix for DATA frames (opaque raw bytes). */
export const PREFIX_DATA = 0x01 as const;

export type FramePrefix = typeof PREFIX_CONTROL | typeof PREFIX_DATA;

// ---------------------------------------------------------------------------
// Tuning constants (defaults shared so both sides agree on the same budgets).
// Server reads these for flow control / coalescing; client for ACK coalescing.
// ---------------------------------------------------------------------------

/** Output coalescing flush interval (ms): batch PTY data on this timer. */
export const DEFAULT_BATCH_MS = 8;
/** Output coalescing size threshold (bytes): flush a batch once this big. */
export const DEFAULT_BATCH_BYTES = 64 * 1024; // 64 KiB

/** Stop flushing new data when inflight (sentBytes - ackedBytes) >= this. */
export const DEFAULT_HIGH_WATERMARK = 1024 * 1024; // 1 MiB
/** Resume flushing once inflight drops back to <= this. */
export const DEFAULT_LOW_WATERMARK = 256 * 1024; // 256 KiB

/** Client coalesces ACKs: send a cumulative ack roughly every this many bytes. */
export const ACK_INTERVAL_BYTES = 256 * 1024; // 256 KiB
/** Client coalesces ACKs: ...or at least this often (ms) while data flows. */
export const ACK_INTERVAL_MS = 50;

/** Keepalive ping cadence (ms). */
export const PING_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Control message shapes. Discriminant field is "t".
// ---------------------------------------------------------------------------

// client -> server
/** lastSeq = cumulative bytes the client already has (0 on first attach). */
export type AttachMsg = { t: 'attach'; sessionId: string; lastSeq: number };
/** Debounced client-side; only the focused client sends resize. */
export type ResizeMsg = { t: 'resize'; cols: number; rows: number };
/** CUMULATIVE rendered byte count (monotonic, absolute) from xterm write-cb. */
export type AckMsg = { t: 'ack'; bytes: number };
export type PingMsg = { t: 'ping'; ts: number };
export type PongMsg = { t: 'pong'; ts: number };
/**
 * Client-pushed @xterm/addon-serialize screen, cached by the server so a later
 * TRUNCATED reconnect (ring floor passed the client's lastSeq) can replay a
 * fresh snapshot instead of a blank terminal. The server has no terminal model
 * of its own, so the serialize string must originate from the client that last
 * held the screen (sent on detach / before unmount). A complete escape-sequence
 * string, never a frame-boundary fragment.
 */
export type ClientSnapshotMsg = { t: 'clientSnapshot'; data: string };

// server -> client
/**
 * Sent immediately after attach.
 * cols/rows = PTY's CURRENT size (source of truth).
 * baseSeq   = cumulative-byte seq the client's view starts at AFTER any
 *             snapshot/replay.
 * truncated = scrollback floor passed lastSeq, so a snapshot was sent instead
 *             of byte replay.
 */
export type AttachedMsg = {
  t: 'attached';
  sessionId: string;
  cols: number;
  rows: number;
  baseSeq: number;
  truncated: boolean;
};
/**
 * @xterm/addon-serialize output, sent as CONTROL (not a data frame) before
 * "attached" when truncated. A complete escape-sequence string, safe to
 * decode; client term.write(data) then proceeds.
 */
export type SnapshotMsg = { t: 'snapshot'; data: string };
/** PTY process exited; the socket then closes. */
export type ExitMsg = { t: 'exit'; code: number; signal: string | null };

export type ClientControl =
  | AttachMsg
  | ResizeMsg
  | AckMsg
  | ClientSnapshotMsg
  | PingMsg
  | PongMsg;
export type ServerControl =
  | AttachedMsg
  | SnapshotMsg
  | ResizeMsg
  | ExitMsg
  | PingMsg
  | PongMsg;
export type ControlMsg = ClientControl | ServerControl;

/** Discriminant string literals, handy for exhaustive switches. */
export type ControlMsgKind = ControlMsg['t'];

// ---------------------------------------------------------------------------
// Framing helpers (shared by both sides). Reused TextEncoder/Decoder; the
// decoder is ONLY ever applied to CONTROL payloads, never to DATA payloads.
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/** Encode a control message: 0x00 ++ utf8(JSON.stringify(msg)). */
export function encodeControl(msg: ControlMsg): Uint8Array {
  const json = utf8Encoder.encode(JSON.stringify(msg));
  const frame = new Uint8Array(json.length + 1);
  frame[0] = PREFIX_CONTROL;
  frame.set(json, 1);
  return frame;
}

/**
 * Encode a data frame: 0x01 ++ bytes.
 * The payload is copied exactly once (after the 1-byte prefix); the bytes
 * themselves are NEVER inspected or decoded.
 */
export function encodeData(bytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(bytes.length + 1);
  frame[0] = PREFIX_DATA;
  frame.set(bytes, 1);
  return frame;
}

/** Discriminated result of decodeFrame. */
export type DecodedFrame =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'control'; msg: ControlMsg };

/**
 * Discriminate a frame by its 1-byte prefix.
 *
 * - DATA: returns a zero-copy subarray view of the payload as raw bytes. The
 *   caller MUST hand these straight to term.write / pty.write and MUST NOT
 *   decode them as text — a multibyte UTF-8 codepoint may be split across
 *   frames at this boundary.
 * - CONTROL: parses the UTF-8 JSON payload into a ControlMsg.
 *
 * Throws on an empty frame, an unknown prefix, or malformed control JSON.
 */
export function decodeFrame(buf: Uint8Array): DecodedFrame {
  if (buf.length < 1) {
    throw new Error('decodeFrame: empty frame');
  }
  const prefix = buf[0];
  if (prefix === PREFIX_DATA) {
    // Zero-copy view: opaque bytes, never decoded as text.
    return { kind: 'data', bytes: buf.subarray(1) };
  }
  if (prefix === PREFIX_CONTROL) {
    const json = utf8Decoder.decode(buf.subarray(1));
    return { kind: 'control', msg: JSON.parse(json) as ControlMsg };
  }
  throw new Error(`decodeFrame: unknown frame prefix 0x${(prefix ?? 0).toString(16).padStart(2, '0')}`);
}
