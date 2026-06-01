// Resume wiring: client-supplied session ids + the claude --session-id/--resume
// arg injection that makes a session re-creatable after a server restart. The
// PTY is a capturing fake (no real spawn); we assert the AgentSpec the manager
// builds and the id-validation rules.

import { describe, expect, test } from 'bun:test';
import { loadConfig } from '@iagent/shared';
import { SessionManager, SessionRequestError } from '../src/session-manager.js';
import { handleRest } from '../src/management.js';
import { PRINCIPAL } from '../src/auth.js';
import type { Pty } from '../src/pty.js';
import type { AgentSpec } from '../src/session.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** A manager whose spawn records every AgentSpec it is asked to run. */
function capturing(): { mgr: SessionManager; specs: AgentSpec[] } {
  const specs: AgentSpec[] = [];
  const mgr = new SessionManager(loadConfig({}), {
    spawnPty: (s) => {
      specs.push(s);
      return fakePty();
    },
  });
  return { mgr, specs };
}

describe('claude session-id / resume arg injection', () => {
  test('a NEW claude session is pinned with --session-id <its own id>', () => {
    const { mgr, specs } = capturing();
    const s = mgr.create({ cwd: process.cwd() }, PRINCIPAL);
    expect(UUID_RE.test(s.id)).toBe(true);
    expect(specs[0]!.args).toEqual(['--session-id', s.id]);
  });

  test('a RESUME with a client-supplied id spawns --resume <id>', () => {
    const { mgr, specs } = capturing();
    const id = crypto.randomUUID();
    const s = mgr.create({ id, resume: true, cwd: process.cwd() }, PRINCIPAL);
    expect(s.id).toBe(id);
    expect(specs[0]!.args).toEqual(['--resume', id]);
  });

  test('non-claude agents get no session flags injected', () => {
    const { mgr, specs } = capturing();
    mgr.create({ agent: 'shell', cwd: process.cwd() }, PRINCIPAL);
    expect(specs[0]!.args).not.toContain('--session-id');
    expect(specs[0]!.args).not.toContain('--resume');
  });
});

describe('client-supplied session id validation', () => {
  test('a non-UUID id is rejected', () => {
    const { mgr } = capturing();
    expect(() => mgr.create({ id: 'not-a-uuid', cwd: process.cwd() }, PRINCIPAL)).toThrow(
      SessionRequestError,
    );
  });

  test('a duplicate (already-live) id is rejected', () => {
    const { mgr } = capturing();
    const id = crypto.randomUUID();
    mgr.create({ id, cwd: process.cwd() }, PRINCIPAL);
    expect(() => mgr.create({ id, cwd: process.cwd() }, PRINCIPAL)).toThrow(SessionRequestError);
  });

  test('REST maps an invalid id to 400', async () => {
    const cfg = loadConfig({});
    const mgr = new SessionManager(cfg, { spawnPty: () => fakePty() });
    const req = new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope', cwd: process.cwd() }),
    });
    const res = await handleRest(req, mgr, cfg);
    expect(res?.status).toBe(400);
  });
});
