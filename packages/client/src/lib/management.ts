// ============================================================================
// REST management-channel client: list / create / get / kill sessions.
//
// The data path is the per-session WebSocket; THIS module is only the
// lightweight control surface (GET/POST/DELETE /api/sessions). DTOs are the
// @iagent/shared contract, so the server and client stay type-checked end to
// end.
// ============================================================================

import type {
  ApiErrorRes,
  CreateSessionReq,
  CreateSessionRes,
  ListSessionsRes,
  SessionSummary,
} from '@iagent/shared';
import { apiBase } from './config.js';

/** Thrown on a non-2xx REST response; carries the HTTP status + server message. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  } catch (cause) {
    throw new ApiError(0, `network error: ${(cause as Error)?.message ?? 'fetch failed'}`);
  }

  if (!res.ok) {
    // Best-effort parse of the uniform { error } body; fall back to status text.
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorRes;
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep statusText.
    }
    throw new ApiError(res.status, message);
  }

  // DELETE returns 204 / empty body; tolerate it.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** GET /api/sessions */
export async function listSessions(): Promise<SessionSummary[]> {
  const { sessions } = await request<ListSessionsRes>('/sessions');
  return sessions;
}

/** GET /api/sessions/:id */
export async function getSession(id: string): Promise<SessionSummary> {
  const { session } = await request<CreateSessionRes>(`/sessions/${encodeURIComponent(id)}`);
  return session;
}

/** POST /api/sessions — spawns a PTY server-side; returns the new summary. */
export async function createSession(req: CreateSessionReq = {}): Promise<SessionSummary> {
  const { session } = await request<CreateSessionRes>('/sessions', {
    method: 'POST',
    body: JSON.stringify(req),
  });
  return session;
}

/** DELETE /api/sessions/:id — proc.kill() then terminal.close() server-side. */
export async function killSession(id: string): Promise<void> {
  await request<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
