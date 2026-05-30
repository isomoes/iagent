// ============================================================================
// REST management-channel DTOs (the data path is the WebSocket; this is the
// GET/POST/DELETE /api/sessions surface). Imported by server (to type the
// router) and client (to type the fetch wrappers).
// ============================================================================

/**
 * Which agent runs inside the PTY. 'claude' is the default first agent;
 * 'shell' is the dev fallback ($SHELL). Left open (`| string`) so other
 * pluggable agents (Codex, etc.) slot in without a shared-package change.
 */
export type AgentKind = 'claude' | 'shell' | (string & {});

/** Live, serializable view of a session — returned by every REST endpoint. */
export interface SessionSummary {
  id: string;
  title: string;
  agent: AgentKind;
  cols: number;
  rows: number;
  /** epoch ms */
  createdAt: number;
  /** epoch ms; bumped on PTY output / input. */
  lastActivity: number;
  /** true while the PTY process is running. */
  alive: boolean;
  /** process exit code, or null while still alive. */
  exitCode: number | null;
}

/**
 * POST /api/sessions body. All fields optional: the server fills defaults
 * from ServerConfig (agent => agentCmd/args/cwd/env) and merges overrides.
 */
export interface CreateSessionReq {
  title?: string;
  agent?: AgentKind;
  cols?: number;
  rows?: number;
  cwd?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** POST /api/sessions response. */
export interface CreateSessionRes {
  session: SessionSummary;
}

/** GET /api/sessions response. */
export interface ListSessionsRes {
  sessions: SessionSummary[];
}

/** Uniform error body for non-2xx REST responses. */
export interface ApiErrorRes {
  error: string;
}
