// ============================================================================
// SessionManager — owns the live Map<id, Session>. In-memory now, but the
// surface (create/get/list/kill + authorize + GC) is durable-ready: a persisted
// implementation would swap the backing store without changing callers.
//
// Enforces three limits from ARCH §Multi-session:
//   - maxSessions          : reject create() past the concurrent cap.
//   - idleGcMs             : reap DETACHED sessions idle longer than the
//                            threshold (proc.kill -> terminal.close) on a
//                            periodic timer; dead+detached sessions are reaped
//                            immediately. Attached (actively-viewed) sessions
//                            are never reaped — GC targets orphaned sessions.
//   - totalRingBytes       : a cross-session memory ceiling; when exceeded the
//                            oldest-active sessions' scrollback is TRIMMED
//                            (just enough oldest bytes dropped, spilling to the
//                            next-oldest session) until back under the cap.
// ============================================================================

import type { AgentKind, CreateSessionReq, ServerConfig, SessionSummary } from '@iagent/shared';
import { Session, type AgentSpec, type SessionDeps } from './session.js';
import type { Principal } from './auth.js';
import { newSessionId } from './ids.js';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** GC sweep cadence (we still honor idleGcMs as the per-session threshold). */
const GC_SWEEP_MS = 30_000;

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLimitError';
  }
}

/** A bad CreateSessionReq (e.g. a cwd that isn't an existing directory) -> 400. */
export class SessionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRequestError';
  }
}

/** RFC-4122-shaped UUID (what crypto.randomUUID emits + what claude --session-id wants). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** claude flags that already manage the conversation/resume lifecycle. */
const CLAUDE_SESSION_FLAGS = new Set([
  '-r',
  '--resume',
  '-c',
  '--continue',
  '--session-id',
  '--fork-session',
]);

/**
 * Make claude sessions resumable across a server restart by pinning the
 * conversation to the iagent session id: a NEW session gets `--session-id <id>`
 * (claude stores its transcript under that id), and a RESUME gets `--resume
 * <id>` (claude reloads it). No-op for non-claude agents (nothing to resume) and
 * skipped entirely if the configured args already drive these flags.
 */
function resolveAgentArgs(
  agent: AgentKind,
  baseArgs: string[],
  id: string,
  resume: boolean,
): string[] {
  if (agent !== 'claude') return baseArgs;
  if (baseArgs.some((a) => CLAUDE_SESSION_FLAGS.has(a))) return baseArgs;
  return resume ? [...baseArgs, '--resume', id] : [...baseArgs, '--session-id', id];
}

/**
 * Resolve a workspace/session cwd to a canonical absolute path and verify it is
 * an existing directory. Expands a leading `~`/`~/` (shells do this; spawn does
 * not) and resolves relatives against the server's startup dir (process.cwd()),
 * preserving the historical default of cwd '.'. Throws SessionRequestError so a
 * mistyped workspace path surfaces as a clean 400, not a cryptic spawn ENOENT.
 */
function resolveCwd(input: string): string {
  let p = input.trim() || '.';
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = resolve(homedir(), p.slice(2));
  const abs = resolve(p);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch {
    throw new SessionRequestError(`working directory does not exist: ${abs}`);
  }
  if (!stat.isDirectory()) {
    throw new SessionRequestError(`not a directory: ${abs}`);
  }
  return abs;
}

export class SessionManager {
  readonly #cfg: ServerConfig;
  readonly #deps: SessionDeps;
  readonly #sessions = new Map<string, Session>();
  #gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: ServerConfig, deps: SessionDeps = {}) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Resolve a CreateSessionReq into a full AgentSpec, merging request overrides
   * over the configured agent defaults. 'shell' is the dev fallback ($SHELL).
   */
  #resolveSpec(req: CreateSessionReq, id: string): AgentSpec {
    const agent: AgentKind = req.agent ?? (this.#cfg.agentCmd === 'claude' ? 'claude' : this.#cfg.agentCmd);

    // Default command from config; 'shell' agent or an explicit cmd override it.
    let cmd = req.cmd ?? this.#cfg.agentCmd;
    let baseArgs = req.args ?? this.#cfg.agentArgs;
    if (req.agent === 'shell' && req.cmd === undefined) {
      cmd = (this.#deps as { shell?: string }).shell ?? process.env.SHELL ?? '/bin/sh';
      baseArgs = req.args ?? [];
    }

    return {
      agent,
      cmd,
      args: resolveAgentArgs(agent, baseArgs, id, req.resume === true),
      cwd: resolveCwd(req.cwd ?? this.#cfg.agentCwd),
      env: { ...process.env, ...this.#cfg.agentEnv, ...(req.env ?? {}) } as Record<string, string>,
      cols: req.cols && req.cols > 0 ? req.cols : DEFAULT_COLS,
      rows: req.rows && req.rows > 0 ? req.rows : DEFAULT_ROWS,
      title: req.title ?? agent,
    };
  }

  /**
   * Validate a client-supplied session id (for resume) or mint a fresh one.
   * A provided id must be a UUID and not already live — so a resume targets a
   * known-shaped, non-colliding id (the single-user/localhost owner is trusted,
   * but the format + uniqueness checks still gate it).
   */
  #resolveId(reqId: string | undefined): string {
    if (reqId === undefined) return newSessionId();
    if (!UUID_RE.test(reqId)) throw new SessionRequestError(`invalid session id: ${reqId}`);
    if (this.#sessions.has(reqId)) throw new SessionRequestError(`session already exists: ${reqId}`);
    return reqId;
  }

  /** Create + start a session owned by `owner`. Throws on the concurrency cap. */
  create(req: CreateSessionReq, owner: Principal): Session {
    if (this.#sessions.size >= this.#cfg.maxSessions) {
      throw new SessionLimitError(`max concurrent sessions reached (${this.#cfg.maxSessions})`);
    }
    const id = this.#resolveId(req.id);
    const spec = this.#resolveSpec(req, id);
    const session = new Session(id, owner, spec, this.#cfg, this.#deps);
    this.#sessions.set(id, session);
    session.start();
    this.#enforceMemoryCeiling();
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /** Sessions visible to `owner` (single-user: all owned by PRINCIPAL). */
  list(owner: Principal): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const s of this.#sessions.values()) {
      if (s.owner === owner) out.push(s.summary);
    }
    return out;
  }

  /** Per-session ownership check (used by REST + WS attach). */
  authorize(id: string, owner: Principal): boolean {
    const s = this.#sessions.get(id);
    return s !== undefined && s.owner === owner;
  }

  /** Kill + remove a session. Returns false if it didn't exist / not owned. */
  kill(id: string, owner: Principal): boolean {
    const s = this.#sessions.get(id);
    if (!s || s.owner !== owner) return false;
    s.kill();
    this.#sessions.delete(id);
    return true;
  }

  /** Total scrollback bytes currently retained across all sessions. */
  get totalBufferedBytes(): number {
    let total = 0;
    for (const s of this.#sessions.values()) total += s.bufferedBytes;
    return total;
  }

  // ── GC / limits ───────────────────────────────────────────────────────────

  /**
   * Cross-session memory ceiling: while the summed scrollback exceeds
   * totalRingBytes, trim the oldest-active session's OLDEST bytes (just enough
   * to fall back under the cap, by design — see ARCH §Multi-session "detached
   * draining"), spilling to the next-oldest session if one isn't enough.
   */
  #enforceMemoryCeiling(): void {
    if (this.#cfg.totalRingBytes <= 0) return;
    let guard = this.#sessions.size + 1; // bound the loop
    let over = this.totalBufferedBytes - this.#cfg.totalRingBytes;
    while (over > 0 && guard-- > 0) {
      let victim: Session | null = null;
      for (const s of this.#sessions.values()) {
        if (s.bufferedBytes === 0) continue;
        if (!victim || s.lastActivity < victim.lastActivity) victim = s;
      }
      if (!victim) break;
      // Drop only as many of the victim's OLDEST bytes as needed to fall back
      // under the cap (not its whole ring); spill to the next-oldest session if
      // one victim isn't enough. (ARCH §Multi-session: oldest bytes dropped.)
      const dropped = victim.trimScrollback(over);
      if (dropped === 0) break; // no progress possible: avoid spinning
      over -= dropped;
    }
  }

  /**
   * Reap sessions in two cases (ARCH §Multi-session — GC targets ORPHANED
   * sessions, so a live attached viewer is never reaped out from under):
   *   - Already-exited (dead) sessions with no attached socket -> reap NOW,
   *     independent of the idle threshold, so a finished agent stops consuming
   *     a maxSessions slot + ring memory (otherwise #onPtyExit bumps
   *     lastActivity and the dead session would linger up to idleGcMs).
   *   - DETACHED, still-alive sessions idle longer than idleGcMs. An attached
   *     session is being actively viewed (lastActivity only tracks PTY/input
   *     activity, not "attached & reading"), so it is NOT orphaned and is
   *     skipped regardless of idle time.
   */
  #sweepIdle(): void {
    const now = Date.now();
    const idleMs = this.#cfg.idleGcMs;
    for (const [id, s] of this.#sessions) {
      const deadAndDetached = !s.alive && !s.attached;
      const idleDetached = idleMs > 0 && !s.attached && now - s.lastActivity >= idleMs;
      if (deadAndDetached || idleDetached) {
        s.kill();
        this.#sessions.delete(id);
      }
    }
  }

  /** Start the periodic GC sweep (idle reap + memory ceiling). */
  startIdleGc(): void {
    if (this.#gcTimer) return;
    this.#gcTimer = setInterval(() => {
      this.#sweepIdle();
      this.#enforceMemoryCeiling();
    }, GC_SWEEP_MS);
    // Don't keep the process alive solely for the GC timer.
    (this.#gcTimer as { unref?: () => void }).unref?.();
  }

  stopIdleGc(): void {
    if (this.#gcTimer) {
      clearInterval(this.#gcTimer);
      this.#gcTimer = null;
    }
  }

  /** Kill every session (graceful shutdown). */
  shutdown(): void {
    this.stopIdleGc();
    for (const s of this.#sessions.values()) s.kill();
    this.#sessions.clear();
  }
}
