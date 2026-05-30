// Byte-accounting tests for the scrollback ring: head/floor/size invariants,
// overflow + floor advance, and the replay-vs-snapshot decision.

import { describe, expect, test } from 'bun:test';
import { RingBuffer } from '../src/ring-buffer.js';

const bytes = (...n: number[]) => Uint8Array.from(n);
const seq = (start: number, len: number) =>
  Uint8Array.from({ length: len }, (_, i) => (start + i) & 0xff);

describe('RingBuffer', () => {
  test('empty buffer: head=floor=size=0', () => {
    const r = new RingBuffer(1024);
    expect(r.head).toBe(0);
    expect(r.floor).toBe(0);
    expect(r.size).toBe(0);
  });

  test('push advances head and size without dropping under capacity', () => {
    const r = new RingBuffer(1024);
    r.push(bytes(1, 2, 3));
    expect(r.head).toBe(3);
    expect(r.floor).toBe(0);
    expect(r.size).toBe(3);
    r.push(bytes(4, 5));
    expect(r.head).toBe(5);
    expect(r.floor).toBe(0);
    expect(r.size).toBe(5);
  });

  test('overflow drops oldest and raises floor; head keeps counting', () => {
    const r = new RingBuffer(4);
    r.push(bytes(1, 2, 3, 4));
    expect(r.size).toBe(4);
    expect(r.floor).toBe(0);
    r.push(bytes(5, 6)); // total 6 > cap 4 -> drop oldest 2
    expect(r.head).toBe(6);
    expect(r.size).toBe(4);
    expect(r.floor).toBe(2); // bytes 1,2 dropped
    const snap = r.snapshotAfter(2);
    expect(Array.from(snap.bytes)).toEqual([3, 4, 5, 6]);
    expect(snap.truncated).toBe(false);
  });

  test('push larger than capacity keeps only the trailing maxBytes', () => {
    const r = new RingBuffer(4);
    r.push(seq(0, 10)); // 0..9
    expect(r.head).toBe(10);
    expect(r.size).toBe(4);
    expect(r.floor).toBe(6);
    expect(Array.from(r.snapshotAfter(6).bytes)).toEqual([6, 7, 8, 9]);
  });

  test('circular wrap preserves byte order across many small pushes', () => {
    const r = new RingBuffer(5);
    for (let i = 0; i < 12; i++) r.push(bytes(i));
    // last 5 bytes are 7..11
    expect(r.head).toBe(12);
    expect(r.floor).toBe(7);
    expect(Array.from(r.snapshotAfter(7).bytes)).toEqual([7, 8, 9, 10, 11]);
    // partial replay from the middle of the retained window
    expect(Array.from(r.snapshotAfter(9).bytes)).toEqual([9, 10, 11]);
  });

  test('snapshotAfter: lastSeq >= head -> already current (empty, baseSeq=head)', () => {
    const r = new RingBuffer(16);
    r.push(bytes(1, 2, 3));
    const s = r.snapshotAfter(3);
    expect(s.bytes.length).toBe(0);
    expect(s.baseSeq).toBe(3);
    expect(s.truncated).toBe(false);
  });

  test('snapshotAfter: lastSeq within window -> replay suffix, baseSeq=lastSeq', () => {
    const r = new RingBuffer(16);
    r.push(seq(0, 8)); // 0..7
    const s = r.snapshotAfter(5);
    expect(Array.from(s.bytes)).toEqual([5, 6, 7]);
    expect(s.baseSeq).toBe(5);
    expect(s.truncated).toBe(false);
  });

  test('snapshotAfter: lastSeq < floor -> truncated, baseSeq=head, no bytes', () => {
    const r = new RingBuffer(4);
    r.push(seq(0, 10)); // floor now 6
    const s = r.snapshotAfter(2);
    expect(s.truncated).toBe(true);
    expect(s.bytes.length).toBe(0);
    expect(s.baseSeq).toBe(r.head);
  });

  test('lastSeq exactly at floor is replayable (not truncated)', () => {
    const r = new RingBuffer(4);
    r.push(seq(0, 10)); // floor 6, head 10
    const s = r.snapshotAfter(6);
    expect(s.truncated).toBe(false);
    expect(Array.from(s.bytes)).toEqual([6, 7, 8, 9]);
  });

  test('dropOldest raises floor by N without touching head; replay starts at new floor', () => {
    const r = new RingBuffer(16);
    r.push(seq(0, 8)); // bytes 0..7, floor 0, head 8
    const dropped = r.dropOldest(3);
    expect(dropped).toBe(3);
    expect(r.head).toBe(8); // head/seq unchanged
    expect(r.size).toBe(5);
    expect(r.floor).toBe(3); // oldest 3 bytes gone
    expect(Array.from(r.snapshotAfter(3).bytes)).toEqual([3, 4, 5, 6, 7]);
    // Anything older than the new floor is now truncated.
    expect(r.snapshotAfter(1).truncated).toBe(true);
  });

  test('dropOldest clamps to retained size and is a no-op for n<=0', () => {
    const r = new RingBuffer(16);
    r.push(seq(0, 4));
    expect(r.dropOldest(0)).toBe(0);
    expect(r.dropOldest(-5)).toBe(0);
    expect(r.size).toBe(4);
    expect(r.dropOldest(100)).toBe(4); // clamps to size
    expect(r.size).toBe(0);
    expect(r.floor).toBe(4);
    expect(r.head).toBe(4);
  });

  test('dropOldest honors the circular wrap (start past the buffer end)', () => {
    const r = new RingBuffer(5);
    for (let i = 0; i < 12; i++) r.push(bytes(i)); // retains 7..11, start wrapped
    expect(r.dropOldest(2)).toBe(2); // drop 7,8 -> floor 9
    expect(r.floor).toBe(9);
    expect(Array.from(r.snapshotAfter(9).bytes)).toEqual([9, 10, 11]);
  });

  test('evictAll drops scrollback but preserves head (absolute seq)', () => {
    const r = new RingBuffer(16);
    r.push(seq(0, 8));
    r.evictAll();
    expect(r.head).toBe(8);
    expect(r.size).toBe(0);
    expect(r.floor).toBe(8);
    // A subsequent push continues the absolute counter.
    r.push(bytes(99));
    expect(r.head).toBe(9);
    expect(Array.from(r.snapshotAfter(8).bytes)).toEqual([99]);
  });
});
