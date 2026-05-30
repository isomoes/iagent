import { describe, expect, it } from 'bun:test';

import {
  PREFIX_CONTROL,
  PREFIX_DATA,
  encodeControl,
  encodeData,
  decodeFrame,
  type ControlMsg,
} from './protocol.js';

describe('control frame round-trip', () => {
  const cases: ControlMsg[] = [
    { t: 'attach', sessionId: 'sess-abc', lastSeq: 0 },
    { t: 'attach', sessionId: 'sess-xyz', lastSeq: 123_456_789 },
    { t: 'resize', cols: 120, rows: 40 },
    { t: 'ack', bytes: 262_144 },
    { t: 'ping', ts: 1_700_000_000_000 },
    { t: 'pong', ts: 1_700_000_000_001 },
    { t: 'attached', sessionId: 's1', cols: 80, rows: 24, baseSeq: 999, truncated: false },
    { t: 'attached', sessionId: 's1', cols: 80, rows: 24, baseSeq: 1000, truncated: true },
    { t: 'snapshot', data: '\x1b[2J\x1b[H hello — café 🚀 \x1b[0m' },
    { t: 'exit', code: 0, signal: null },
    { t: 'exit', code: 137, signal: 'SIGKILL' },
  ];

  for (const msg of cases) {
    it(`encodes+decodes ${msg.t}`, () => {
      const frame = encodeControl(msg);
      expect(frame[0]).toBe(PREFIX_CONTROL);
      const decoded = decodeFrame(frame);
      expect(decoded.kind).toBe('control');
      if (decoded.kind === 'control') {
        expect(decoded.msg).toEqual(msg);
      }
    });
  }

  it('preserves multibyte UTF-8 inside the JSON snapshot string', () => {
    const data = 'café 𝕏 漢字 🚀🌍';
    const decoded = decodeFrame(encodeControl({ t: 'snapshot', data }));
    expect(decoded.kind).toBe('control');
    if (decoded.kind === 'control' && decoded.msg.t === 'snapshot') {
      expect(decoded.msg.data).toBe(data);
    }
  });
});

describe('data frame passthrough (raw bytes, never text)', () => {
  it('round-trips arbitrary bytes including NUL and high bytes', () => {
    const payload = new Uint8Array([0x00, 0x01, 0x1b, 0x5b, 0x41, 0xff, 0xfe, 0x80, 0x7f]);
    const frame = encodeData(payload);
    expect(frame[0]).toBe(PREFIX_DATA);

    const decoded = decodeFrame(frame);
    expect(decoded.kind).toBe('data');
    if (decoded.kind === 'data') {
      // Bytes are returned verbatim — identical contents, no decode/re-encode.
      expect(Array.from(decoded.bytes)).toEqual(Array.from(payload));
    }
  });

  it('treats a lone 0x01 prefix as an empty data payload', () => {
    const decoded = decodeFrame(encodeData(new Uint8Array(0)));
    expect(decoded.kind).toBe('data');
    if (decoded.kind === 'data') {
      expect(decoded.bytes.length).toBe(0);
    }
  });

  it('does NOT corrupt a multibyte UTF-8 codepoint split across two frames', () => {
    // "é" is U+00E9 = 0xC3 0xA9 in UTF-8. A coalescing batcher could legally
    // emit the lead byte in one data frame and the trailing byte in the next.
    // The codec must pass each fragment through as raw bytes WITHOUT decoding;
    // re-joining the payloads must reproduce the original codepoint exactly.
    const full = new TextEncoder().encode('é'); // [0xC3, 0xA9]
    const chunkA = full.subarray(0, 1); // lead byte only — invalid on its own
    const chunkB = full.subarray(1, 2); // trailing continuation byte

    const decodedA = decodeFrame(encodeData(chunkA));
    const decodedB = decodeFrame(encodeData(chunkB));
    expect(decodedA.kind).toBe('data');
    expect(decodedB.kind).toBe('data');

    if (decodedA.kind === 'data' && decodedB.kind === 'data') {
      // Each half is preserved byte-exact (no replacement char, no throw).
      expect(decodedA.bytes.length).toBe(1);
      expect(decodedB.bytes.length).toBe(1);
      const rejoined = new Uint8Array([...decodedA.bytes, ...decodedB.bytes]);
      // Only NOW, with the full codepoint reassembled, is decoding valid.
      expect(new TextDecoder('utf-8', { fatal: true }).decode(rejoined)).toBe('é');
      expect(Array.from(rejoined)).toEqual(Array.from(full));
    }
  });
});

describe('decodeFrame error handling', () => {
  it('throws on an empty frame', () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrow();
  });

  it('throws on an unknown channel prefix', () => {
    expect(() => decodeFrame(new Uint8Array([0x7a, 0x00]))).toThrow();
  });
});
