// ============================================================================
// Workspace store — Svelte 5 runes module ($state), persisted in localStorage.
//
// A workspace binds a NAME to a directory PATH; spawning a session "in" a
// workspace passes that path as the PTY cwd (CreateSessionReq.cwd). The server
// stays workspace-agnostic — it only ever sees a per-session cwd — so the whole
// workspace concept (the list, which session belongs to which workspace, and
// per-workspace collapse state) lives client-side and survives reloads via
// localStorage. The session list itself remains server-sourced (sessions.svelte).
//
// Persistence is a single versioned key written eagerly on every mutation
// (explicit #save(), not a reactive $effect: this is a plain module singleton,
// not a component, so it has no effect scope).
// ============================================================================

import type { AgentKind, SessionSummary } from '@iagent/shared';

export interface Workspace {
  id: string;
  /** Human label shown in the sidebar; defaults to the path's basename. */
  name: string;
  /** Directory passed as the agent cwd. As entered by the user. */
  path: string;
}

/**
 * The bit of a session we persist client-side so it survives a SERVER restart
 * (which wipes the in-memory PTYs). Combined with the workspace path (via the
 * binding) it is enough to RESUME: re-create the session with the same id +
 * cwd. Its mere presence is the resumable marker — only sessions we ourselves
 * spawned (so the server pinned `--session-id <id>`) get an entry.
 */
export interface SessionMeta {
  agent: AgentKind;
  title: string;
  /** epoch ms; preserves stable ordering within a workspace across reloads. */
  createdAt: number;
}

const STORAGE_KEY = 'iagent.workspaces.v1';

interface Persisted {
  workspaces: Workspace[];
  /** sessionId -> workspaceId. The durable source of truth for grouping. */
  bindings: Record<string, string>;
  /** sessionId -> resume metadata (agent/title/createdAt). */
  meta: Record<string, SessionMeta>;
  /** workspaceId -> collapsed?  (absent/false = expanded). */
  collapsed: Record<string, boolean>;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access can throw (privacy modes); degrade to in-memory.
  }
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: time-free, collision-resistant enough for a client-local id.
  return `ws-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function isWorkspace(v: unknown): v is Workspace {
  const w = v as Workspace;
  return !!w && typeof w.id === 'string' && typeof w.name === 'string' && typeof w.path === 'string';
}

function isRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function load(): Persisted {
  const empty: Persisted = { workspaces: [], bindings: {}, meta: {}, collapsed: {} };
  const ls = storage();
  if (!ls) return empty;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(isWorkspace) : [],
      bindings: isRecord(parsed.bindings) ? (parsed.bindings as Record<string, string>) : {},
      meta: isRecord(parsed.meta) ? (parsed.meta as Record<string, SessionMeta>) : {},
      collapsed: isRecord(parsed.collapsed) ? (parsed.collapsed as Record<string, boolean>) : {},
    };
  } catch {
    return empty;
  }
}

/** Last path segment of a directory, for a default workspace name. */
export function basename(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

class WorkspaceStore {
  workspaces = $state<Workspace[]>([]);
  bindings = $state<Record<string, string>>({});
  meta = $state<Record<string, SessionMeta>>({});
  collapsed = $state<Record<string, boolean>>({});

  constructor() {
    const p = load();
    this.workspaces = p.workspaces;
    this.bindings = p.bindings;
    this.meta = p.meta;
    this.collapsed = p.collapsed;
  }

  #save(): void {
    const ls = storage();
    if (!ls) return;
    const data: Persisted = {
      workspaces: this.workspaces,
      bindings: this.bindings,
      meta: this.meta,
      collapsed: this.collapsed,
    };
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // quota / disabled storage: keep running with the in-memory copy.
    }
  }

  // ── Workspace CRUD ──────────────────────────────────────────────────────

  /** Add a workspace; name falls back to the path's basename. Returns it. */
  add(name: string, path: string): Workspace {
    const trimmedPath = path.trim();
    const ws: Workspace = {
      id: newId(),
      name: name.trim() || basename(trimmedPath),
      path: trimmedPath,
    };
    this.workspaces = [...this.workspaces, ws];
    this.#save();
    return ws;
  }

  /** Remove a workspace and forget its collapse state + session bindings/meta. */
  remove(id: string): void {
    this.workspaces = this.workspaces.filter((w) => w.id !== id);
    const { [id]: _c, ...collapsed } = this.collapsed;
    void _c;
    this.collapsed = collapsed;
    const bindings: Record<string, string> = {};
    const meta = { ...this.meta };
    for (const [sid, wid] of Object.entries(this.bindings)) {
      if (wid === id) delete meta[sid];
      else bindings[sid] = wid;
    }
    this.bindings = bindings;
    this.meta = meta;
    this.#save();
  }

  rename(id: string, name: string): void {
    const n = name.trim();
    if (!n) return;
    this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, name: n } : w));
    this.#save();
  }

  // ── Collapse state ────────────────────────────────────────────────────────

  isCollapsed(id: string): boolean {
    return this.collapsed[id] === true;
  }

  toggleCollapsed(id: string): void {
    this.collapsed = { ...this.collapsed, [id]: !this.collapsed[id] };
    this.#save();
  }

  /** Force a workspace expanded (e.g. after spawning a session into it). */
  expand(id: string): void {
    if (!this.collapsed[id]) return;
    const { [id]: _c, ...rest } = this.collapsed;
    void _c;
    this.collapsed = rest;
    this.#save();
  }

  // ── Session ↔ workspace bindings ────────────────────────────────────────

  /**
   * Remember a session: bind it to a workspace AND store its resume metadata.
   * Called on every session we spawn, so the pair (binding -> workspace path,
   * meta -> id/agent/title) is the complete recipe to resume it later.
   */
  recordSession(summary: SessionSummary, workspaceId: string): void {
    this.bindings = { ...this.bindings, [summary.id]: workspaceId };
    this.meta = {
      ...this.meta,
      [summary.id]: { agent: summary.agent, title: summary.title, createdAt: summary.createdAt },
    };
    this.#save();
  }

  /** Forget a session entirely (binding + meta) — e.g. when the user kills it. */
  forgetSession(id: string): void {
    if (!(id in this.bindings) && !(id in this.meta)) return;
    const { [id]: _b, ...bindings } = this.bindings;
    const { [id]: _m, ...meta } = this.meta;
    void _b;
    void _m;
    this.bindings = bindings;
    this.meta = meta;
    this.#save();
  }

  /** The workspace a session belongs to, if any (bound id only). */
  workspaceIdForSession(sessionId: string): string | undefined {
    return this.bindings[sessionId];
  }

  /** Resume metadata for a session, if we recorded it. */
  metaFor(sessionId: string): SessionMeta | undefined {
    return this.meta[sessionId];
  }

  /**
   * Reconcile against the server's live list (call after every REST refresh).
   * Crucially this does NOT drop a session just because the server forgot it —
   * that is exactly the resumable case we want to keep. It only:
   *   - drops bindings/meta whose WORKSPACE was removed (true orphans), and
   *   - best-effort adopts a still-unbound LIVE session whose absolute cwd
   *     EXACTLY matches a workspace path (sessions created out-of-band; exact
   *     match only, so never a false grouping).
   * Idempotent.
   */
  reconcile(sessions: SessionSummary[]): void {
    const wsIds = new Set(this.workspaces.map((w) => w.id));
    const bindings = { ...this.bindings };
    const meta = { ...this.meta };
    let changed = false;

    for (const [sid, wid] of Object.entries(this.bindings)) {
      if (!wsIds.has(wid)) {
        delete bindings[sid];
        delete meta[sid];
        changed = true;
      }
    }
    for (const s of sessions) {
      if (bindings[s.id]) continue;
      const match = this.workspaces.find((w) => w.path === s.cwd);
      if (match) {
        bindings[s.id] = match.id;
        meta[s.id] = { agent: s.agent, title: s.title, createdAt: s.createdAt };
        changed = true;
      }
    }
    if (changed) {
      this.bindings = bindings;
      this.meta = meta;
      this.#save();
    }
  }
}

/** Singleton workspace store shared across the component tree. */
export const workspaceStore = new WorkspaceStore();
