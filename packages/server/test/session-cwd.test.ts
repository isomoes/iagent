// cwd resolution + validation for created sessions. The PTY is a no-op fake (no
// real terminal spawns); we only assert how SessionManager resolves/validates
// the working directory and surfaces it on the summary, plus the REST 400 path.

import { describe, expect, test } from 'bun:test';
import { loadConfig } from '@iagent/shared';
import { SessionManager, SessionRequestError } from '../src/session-manager.js';
import { handleRest } from '../src/management.js';
import { PRINCIPAL } from '../src/auth.js';
import type { Pty } from '../src/pty.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** A do-nothing PTY so create() never spawns a real process. */
function fakePty(): Pty {
  return {
    write() {},
    resize() {},
    setRawMode() {},
    onData() {},
    onExit() {},
    kill() {},
    close() {},
    ref() {},
    unref() {},
    cols: 80,
    rows: 24,
    pid: 1,
  };
}

function makeManager(): SessionManager {
  return new SessionManager(loadConfig({}), { spawnPty: () => fakePty() });
}

describe('session cwd resolution', () => {
  test('default (no cwd) resolves the startup dir to an absolute path', () => {
    const s = makeManager().create({}, PRINCIPAL);
    expect(s.summary.cwd).toBe(resolve('.'));
    expect(s.summary.cwd).toBe(process.cwd());
  });

  test('an existing relative/absolute dir is resolved + reported on the summary', () => {
    const s = makeManager().create({ cwd: process.cwd() }, PRINCIPAL);
    expect(s.summary.cwd).toBe(process.cwd());
  });

  test('a leading ~ expands to the home directory', () => {
    const s = makeManager().create({ cwd: '~' }, PRINCIPAL);
    expect(s.summary.cwd).toBe(homedir());
  });

  test('a non-existent directory is rejected with SessionRequestError', () => {
    const bogus = resolve(process.cwd(), 'definitely-not-a-real-dir-xyz-123');
    expect(() => makeManager().create({ cwd: bogus }, PRINCIPAL)).toThrow(SessionRequestError);
  });

  test('a path that is a file (not a directory) is rejected', () => {
    // This test file itself is a regular file, not a directory.
    expect(() => makeManager().create({ cwd: import.meta.path }, PRINCIPAL)).toThrow(
      SessionRequestError,
    );
  });
});

describe('REST create maps a bad cwd to 400', () => {
  test('POST /api/sessions with a non-existent cwd -> 400', async () => {
    const cfg = loadConfig({});
    const mgr = new SessionManager(cfg, { spawnPty: () => fakePty() });
    const req = new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/this/path/does/not/exist/iagent-test' }),
    });
    const res = await handleRest(req, mgr, cfg);
    expect(res?.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain('does not exist');
  });
});
