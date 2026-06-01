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
  /**
   * Absolute working directory the agent PTY was spawned in (resolved + verified
   * server-side). The client groups sessions into workspaces by their bound id
   * but can fall back to matching this path; also surfaced in the UI.
   */
  cwd: string;
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
  /**
   * Client-supplied session id (a UUID) used to RESUME a session the server no
   * longer holds — e.g. after a server restart. Omit for new sessions: the
   * server generates one. Must be a valid UUID and not already live, else 400.
   * Pairs with `resume`; on its own it just pins the new session's id.
   */
  id?: string;
  /**
   * Resume the agent's prior conversation instead of starting fresh. For the
   * 'claude' agent the server spawns `claude --resume <id>` (Claude persists its
   * transcript per-cwd, keyed by the session id we pinned at creation via
   * `--session-id`); for other agents it is a plain re-spawn in `cwd`.
   */
  resume?: boolean;
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
