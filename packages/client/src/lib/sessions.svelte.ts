// ============================================================================
// Session store — Svelte 5 runes module ($state, NO legacy stores).
//
// Holds the session list (REST-sourced), the focused session id (lazy attach:
// only the focused tab gets a live WS + terminal), and a connection-status map
// for the StatusBar. Polls the REST list so background sessions' alive/exit
// state stays current. Mutations go through @iagent/shared-typed management.ts.
// ============================================================================

import type { AgentKind, CreateSessionReq, SessionSummary } from '@iagent/shared';
import type { WsStatus } from './ws-client.js';
import { ApiError, createSession, killSession, listSessions } from './management.js';
import { measureGrid } from './terminal.js';
import { settingsStore } from './settings.svelte.js';
import { workspaceStore } from './workspaces.svelte.js';

const POLL_INTERVAL_MS = 4000;

class SessionStore {
  /** REST-sourced session list. */
  sessions = $state<SessionSummary[]>([]);
  /** The focused session id (the ONLY one with a live WS — lazy attach). */
  activeId = $state<string | null>(null);
  /** Last error surfaced from a management call (for the UI to show). */
  error = $state<string | null>(null);
  /** True while an initial list / create call is in flight. */
  loading = $state(false);

  /** Per-session connection status, keyed by id (svelte-reactive map). */
  private statusMap = $state<Record<string, WsStatus>>({});

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The element the focused terminal occupies (the <main> panel). Registered by
   * App on mount; used to measure the initial grid so a new PTY spawns at the
   * real viewport size instead of the server's 80×24 default.
   */
  private hostEl: HTMLElement | null = null;

  /** The focused session summary, or undefined. */
  get active(): SessionSummary | undefined {
    const id = this.activeId;
    return id ? this.sessions.find((s) => s.id === id) : undefined;
  }

  status(id: string): WsStatus | undefined {
    return this.statusMap[id];
  }

  setStatus(id: string, status: WsStatus): void {
    // No-op on unchanged status: avoids allocating a new map (and waking its
    // reactive readers) on every repeated 'connecting'/'open' emit.
    if (this.statusMap[id] === status) return;
    this.statusMap = { ...this.statusMap, [id]: status };
  }

  /** Fetch the list; preserves the active selection if it still exists. */
  async refresh(): Promise<void> {
    try {
      const next = await listSessions();
      this.sessions = next;
      this.error = null;
      // Keep workspace bindings in sync with the live set (prune dead, adopt
      // cwd-matching orphans) so localStorage doesn't accrue stale entries.
      workspaceStore.reconcile(next);
      // Keep focus valid; if the active session vanished, fall back to first.
      if (this.activeId && !next.some((s) => s.id === this.activeId)) {
        this.activeId = next[0]?.id ?? null;
      } else if (!this.activeId && next.length > 0) {
        this.activeId = next[0]?.id ?? null;
      }
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** Register the panel element used to size new sessions (call once on mount). */
  setHost(el: HTMLElement | null): void {
    this.hostEl = el;
  }

  /**
   * Measure the grid the focused terminal area would fit right now, so a new
   * session's PTY can spawn at the real viewport size. Subtracts the status bar
   * (always present at the panel's foot) from the available height; returns
   * null if the panel isn't laid out, in which case create() falls back to the
   * server default and the post-attach fit corrects it.
   */
  private measureInitialGrid(): { cols: number; rows: number } | null {
    const host = this.hostEl;
    if (!host) return null;
    const statusBar = host.querySelector('.status-bar') as HTMLElement | null;
    const width = host.clientWidth;
    const height = host.clientHeight - (statusBar?.offsetHeight ?? 0);
    return measureGrid(width, height, settingsStore.terminalFontSize);
  }

  /** Create a session (REST POST), select it, and return its summary. */
  async create(req: CreateSessionReq = {}): Promise<SessionSummary | null> {
    this.loading = true;
    try {
      // Size the PTY to the live viewport unless the caller pinned a size.
      if (req.cols === undefined && req.rows === undefined) {
        const grid = this.measureInitialGrid();
        if (grid) req = { ...req, cols: grid.cols, rows: grid.rows };
      }
      const session = await createSession(req);
      this.sessions = [...this.sessions, session];
      this.activeId = session.id; // focus it -> TerminalView opens its WS.
      this.error = null;
      return session;
    } catch (e) {
      this.error = (e as Error).message;
      return null;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Resume a session the server no longer holds (e.g. after a restart): re-POST
   * with the SAME id + workspace cwd and `resume: true` so the server spawns
   * `claude --resume <id>`, restoring the conversation. Focuses it on success.
   */
  async resume(
    id: string,
    opts: { cwd: string; agent?: AgentKind; title?: string },
  ): Promise<SessionSummary | null> {
    this.loading = true;
    try {
      const req: CreateSessionReq = { id, resume: true, cwd: opts.cwd };
      if (opts.agent) req.agent = opts.agent;
      if (opts.title) req.title = opts.title;
      const grid = this.measureInitialGrid();
      if (grid) {
        req.cols = grid.cols;
        req.rows = grid.rows;
      }
      const session = await createSession(req);
      this.sessions = this.sessions.some((s) => s.id === session.id)
        ? this.sessions.map((s) => (s.id === session.id ? session : s))
        : [...this.sessions, session];
      this.activeId = session.id; // focus it -> TerminalView opens its WS.
      this.error = null;
      return session;
    } catch (e) {
      this.error = (e as Error).message;
      return null;
    } finally {
      this.loading = false;
    }
  }

  /** Kill a session (REST DELETE), forget its client record, and drop it. */
  async kill(id: string): Promise<void> {
    try {
      await killSession(id);
    } catch (e) {
      // A session the server already forgot (e.g. after a restart) 404s — that
      // is "already gone" for our purposes, so only surface other errors.
      if (!(e instanceof ApiError && e.status === 404)) this.error = (e as Error).message;
    }
    this.sessions = this.sessions.filter((s) => s.id !== id);
    const { [id]: _removed, ...rest } = this.statusMap;
    void _removed;
    this.statusMap = rest;
    workspaceStore.forgetSession(id);
    if (this.activeId === id) {
      this.activeId = this.sessions[0]?.id ?? null;
    }
  }

  /** Focus a session (lazy attach: TerminalView opens/closes WS on change). */
  select(id: string): void {
    if (this.activeId !== id) this.activeId = id;
  }

  /** Begin polling the REST list (call once on app mount). */
  startPolling(): void {
    if (this.pollTimer !== null) return;
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

/** Singleton session store shared across the component tree. */
export const sessionStore = new SessionStore();
