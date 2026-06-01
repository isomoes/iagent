// BunPty.resize() over a REAL Bun.Terminal: asserts a winsize change delivers
// SIGWINCH to the child (Bun.Terminal updates the winsize but doesn't signal),
// and that a no-op resize doesn't. The child is a tiny `bun -e` program that
// echoes a marker on SIGWINCH.

import { afterEach, expect, test } from 'bun:test';
import { spawnBunPty, type Pty } from '../src/pty.js';

const CHILD =
  "process.stdout.write('READY\\n');" +
  "process.on('SIGWINCH', () => process.stdout.write('WINCH ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'));" +
  'setInterval(() => {}, 1 << 30);';

let pty: Pty | null = null;
afterEach(() => {
  pty?.close();
  pty = null;
});

function spawnChild(cols: number, rows: number): { pty: Pty; out: () => string } {
  const p = spawnBunPty({
    cmd: 'bun',
    args: ['-e', CHILD],
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    cols,
    rows,
  });
  let buf = '';
  const dec = new TextDecoder();
  p.onData((b) => {
    buf += dec.decode(b);
  });
  return { pty: p, out: () => buf };
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(stepMs);
  }
  return pred();
}

test('resize delivers SIGWINCH to the child at the new size', async () => {
  const child = spawnChild(80, 24);
  pty = child.pty;
  expect(await waitUntil(() => child.out().includes('READY'))).toBe(true);

  pty.resize(120, 40);

  expect(await waitUntil(() => child.out().includes('WINCH'))).toBe(true);
  // Child re-queried on the signal and saw the new grid: winsize + notify both work.
  expect(child.out()).toContain('WINCH 120x40');
  expect(pty.cols).toBe(120);
  expect(pty.rows).toBe(40);
});

test('no-op resize (same dims) sends no SIGWINCH', async () => {
  const child = spawnChild(100, 30);
  pty = child.pty;
  expect(await waitUntil(() => child.out().includes('READY'))).toBe(true);

  pty.resize(100, 30); // identical to spawn dims — must not signal
  await Bun.sleep(200);

  expect(child.out()).not.toContain('WINCH');
});

test('resize after close is a no-op (no signal, no throw)', async () => {
  const child = spawnChild(80, 24);
  pty = child.pty;
  expect(await waitUntil(() => child.out().includes('READY'))).toBe(true);

  pty.close();
  expect(() => pty?.resize(200, 60)).not.toThrow();
});
