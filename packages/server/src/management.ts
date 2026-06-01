// ============================================================================
// REST management channel (the data path is the per-session WebSocket).
//
//   GET    /api/sessions       -> ListSessionsRes  (list owned sessions)
//   POST   /api/sessions       -> CreateSessionRes (spawn a new agent PTY)
//   GET    /api/sessions/:id    -> CreateSessionRes (single session summary)
//   DELETE /api/sessions/:id    -> 204             (kill + remove)
//
// Browser requests must pass the origin allowlist. Returns `undefined` when the
// path is not a /api/sessions route so the caller can fall through to the WS
// upgrade / 404.
// ============================================================================

import type {
  ApiErrorRes,
  CreateSessionReq,
  CreateSessionRes,
  ListSessionsRes,
  ServerConfig,
} from '@iagent/shared';
import { SessionLimitError, SessionRequestError, type SessionManager } from './session-manager.js';
import { checkOrigin, principalFor } from './auth.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message } satisfies ApiErrorRes, status);
}

/**
 * Handle a /api/sessions request. Returns undefined for non-matching paths.
 */
export async function handleRest(
  req: Request,
  mgr: SessionManager,
  cfg: ServerConfig,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return undefined;

  // Auth gate (origin only when a browser supplies it).
  if (!checkOrigin(req, cfg)) return err('forbidden origin', 403);

  const principal = principalFor(req);

  const rest = url.pathname.slice('/api/'.length);
  const parts = rest.split('/').filter((p) => p.length > 0);

  if (parts[0] !== 'sessions') return err('not found', 404);

  if (parts.length === 1) {
    if (req.method === 'GET') {
      const sessions = mgr.list(principal);
      return json({ sessions } satisfies ListSessionsRes);
    }
    if (req.method === 'POST') {
      let body: CreateSessionReq = {};
      try {
        const text = await req.text();
        if (text.trim().length > 0) body = JSON.parse(text) as CreateSessionReq;
      } catch {
        return err('invalid JSON body', 400);
      }
      try {
        const session = mgr.create(body, principal);
        return json({ session: session.summary } satisfies CreateSessionRes, 201);
      } catch (e) {
        if (e instanceof SessionRequestError) return err(e.message, 400);
        if (e instanceof SessionLimitError) return err(e.message, 429);
        return err(`failed to create session: ${(e as Error).message}`, 500);
      }
    }
    return err('method not allowed', 405);
  }

  if (parts.length === 2) {
    const id = parts[1]!;
    if (req.method === 'GET') {
      const session = mgr.get(id);
      if (!session || !mgr.authorize(id, principal)) return err('not found', 404);
      return json({ session: session.summary } satisfies CreateSessionRes);
    }
    if (req.method === 'DELETE') {
      const ok = mgr.kill(id, principal);
      if (!ok) return err('not found', 404);
      return new Response(null, { status: 204 });
    }
    return err('method not allowed', 405);
  }

  return err('not found', 404);
}
