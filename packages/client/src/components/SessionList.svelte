<script lang="ts">
  // ==========================================================================
  // SessionList — sidebar grouped by WORKSPACE. Each workspace (a name bound to
  // a directory path, persisted client-side in workspaceStore) is a collapsible
  // group listing its sessions plus a "+ new" row that spawns a session with the
  // workspace path as the agent cwd. A trailing "+ New workspace" form adds one.
  //
  // Sessions are still server-sourced (sessionStore); grouping is purely a view
  // over the bound workspace id (workspaceStore.bindings), with a synthetic
  // "Unassigned" group for any live session that maps to no workspace so nothing
  // is ever hidden. Selecting a session changes focus (lazy attach: App swaps the
  // live TerminalView).
  // ==========================================================================

  import { sessionStore } from '../lib/sessions.svelte.js';
  import { settingsStore } from '../lib/settings.svelte.js';
  import { workspaceStore, basename, type Workspace } from '../lib/workspaces.svelte.js';
  import SettingsPanel from './SettingsPanel.svelte';

  // Whether the settings modal is open (local UI state, not persisted).
  let showSettings = $state(false);

  const sessions = $derived(sessionStore.sessions);
  const workspaces = $derived(workspaceStore.workspaces);
  const activeId = $derived(sessionStore.activeId);

  // A merged row: a server-live session and/or a client-persisted (resumable)
  // one. After a server restart the live list is empty, so every known session
  // shows up here as `resumable` and a click re-spawns it (claude --resume).
  interface Row {
    id: string;
    title: string;
    agent: string;
    cwd: string;
    alive: boolean;
    /** present in the server's current list. */
    live: boolean;
    /** server-forgotten but re-creatable (we know its workspace cwd + meta). */
    resumable: boolean;
    createdAt: number;
  }

  interface Group {
    /** null = the synthetic "Unassigned" group. */
    ws: Workspace | null;
    rows: Row[];
  }

  // One group per workspace (declared order) + a trailing Unassigned group. Rows
  // are the UNION of server-live sessions and client-persisted bindings, so a
  // stopped session stays visible (and resumable) across a server restart.
  const groups = $derived.by<Group[]>(() => {
    const liveById = new Map(sessions.map((s) => [s.id, s]));
    const ids = new Set<string>([...liveById.keys(), ...Object.keys(workspaceStore.bindings)]);

    const byWs = new Map<string, Row[]>();
    for (const w of workspaces) byWs.set(w.id, []);
    const unassigned: Row[] = [];

    for (const id of ids) {
      const s = liveById.get(id);
      const wid = workspaceStore.workspaceIdForSession(id);
      const ws = wid ? workspaces.find((w) => w.id === wid) : undefined;
      const meta = workspaceStore.metaFor(id);
      const row: Row = {
        id,
        title: s?.title || meta?.title || id.slice(0, 8),
        agent: s?.agent ?? meta?.agent ?? 'claude',
        cwd: s?.cwd ?? ws?.path ?? '',
        alive: s?.alive ?? false,
        live: s !== undefined,
        // Resumable when the server doesn't have it but we recorded it under a
        // still-existing workspace (so we have both the id and the cwd).
        resumable: s === undefined && ws !== undefined && meta !== undefined,
        createdAt: s?.createdAt ?? meta?.createdAt ?? 0,
      };
      const bucket = ws ? byWs.get(ws.id) : undefined;
      if (bucket) bucket.push(row);
      else unassigned.push(row);
    }

    for (const rows of byWs.values()) rows.sort((a, b) => a.createdAt - b.createdAt);
    unassigned.sort((a, b) => a.createdAt - b.createdAt);

    const out: Group[] = workspaces.map((w) => ({ ws: w, rows: byWs.get(w.id) ?? [] }));
    if (unassigned.length > 0) out.push({ ws: null, rows: unassigned });
    return out;
  });

  function statusDot(r: Row): string {
    if (r.live && r.alive) {
      const st = sessionStore.status(r.id);
      if (r.id === activeId && st === 'open') return 'live';
      if (r.id === activeId && (st === 'connecting' || st === 'reconnecting')) return 'pending';
      return 'idle';
    }
    if (r.resumable) return 'stopped';
    return 'dead';
  }

  // ── New-workspace form (inline) ───────────────────────────────────────────
  let showForm = $state(false);
  let formName = $state('');
  let formPath = $state('');

  function submitWorkspace(): void {
    const path = formPath.trim();
    if (!path) return;
    const ws = workspaceStore.add(formName, path);
    workspaceStore.expand(ws.id);
    formName = '';
    formPath = '';
    showForm = false;
  }

  function cancelWorkspace(): void {
    formName = '';
    formPath = '';
    showForm = false;
  }

  // ── Session / workspace actions ───────────────────────────────────────────

  async function newSession(ws: Workspace, count: number): Promise<void> {
    workspaceStore.expand(ws.id);
    const summary = await sessionStore.create({
      cwd: ws.path,
      title: `session ${count + 1}`,
    });
    if (summary) workspaceStore.recordSession(summary, ws.id);
  }

  /** Live row -> just focus it; resumable (server-forgotten) row -> re-spawn it. */
  async function onSelect(r: Row): Promise<void> {
    if (r.live) {
      sessionStore.select(r.id);
    } else if (r.resumable) {
      await sessionStore.resume(r.id, { cwd: r.cwd, agent: r.agent, title: r.title });
    }
  }

  async function removeWorkspace(ws: Workspace, group: Group): Promise<void> {
    const live = group.rows.filter((r) => r.live && r.alive).length;
    if (live > 0 && !confirm(`Remove "${ws.name}" and kill ${live} running session(s)?`)) {
      return;
    }
    // Kill live PTYs; remove() then forgets every binding/meta for the workspace.
    for (const r of group.rows) if (r.live) await sessionStore.kill(r.id);
    workspaceStore.remove(ws.id);
  }

  /** Kill a live session (REST DELETE) or just forget a stopped one (no server call). */
  async function onKill(e: MouseEvent, r: Row): Promise<void> {
    e.stopPropagation();
    if (r.live) await sessionStore.kill(r.id);
    else workspaceStore.forgetSession(r.id);
  }

  function isTextEntryFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  // Up/Down switch sessions only while blurred. Bubble-phase + the defaultPrevented
  // / text-entry bails keep the rule from ARCH §Focus: never globally swallow keys
  // — a focused agent and a blurred page Vim extension both keep their arrows.
  function onArrowSwitch(e: KeyboardEvent): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.defaultPrevented || showSettings || isTextEntryFocused()) return;

    const rows = groups
      .filter((g) => !(g.ws && workspaceStore.isCollapsed(g.ws.id)))
      .flatMap((g) => g.rows);
    if (rows.length < 2) return;

    const step = e.key === 'ArrowDown' ? 1 : -1;
    const cur = rows.findIndex((r) => r.id === activeId);
    const next = cur === -1 ? (step === 1 ? 0 : rows.length - 1) : (cur + step + rows.length) % rows.length;
    const target = rows[next];
    if (!target) return;
    e.preventDefault();
    void onSelect(target);
  }

  $effect(() => {
    window.addEventListener('keydown', onArrowSwitch);
    return () => window.removeEventListener('keydown', onArrowSwitch);
  });
</script>

{#if settingsStore.sidebarCollapsed}
  <!-- Folded rail: just the affordances to unfold and to open settings. -->
  <aside class="session-list session-list--rail">
    <button
      class="rail-btn"
      title="Expand sidebar"
      aria-label="Expand sidebar"
      onclick={() => settingsStore.toggleSidebar()}
    >»</button>
    <button
      class="rail-btn"
      title="Settings"
      aria-label="Settings"
      onclick={() => (showSettings = true)}
    >⚙</button>
  </aside>
{:else}
<aside class="session-list">
  <header class="session-list__header">
    <span class="brand">iagent</span>
    <div class="header-actions">
      <button
        class="icon-btn"
        title="Settings"
        aria-label="Settings"
        onclick={() => (showSettings = true)}
      >⚙</button>
      <button
        class="icon-btn"
        title="Collapse sidebar"
        aria-label="Collapse sidebar"
        onclick={() => settingsStore.toggleSidebar()}
      >«</button>
    </div>
  </header>

  {#if sessionStore.error}
    <div class="error" role="alert">{sessionStore.error}</div>
  {/if}

  <div class="groups">
    {#each groups as g (g.ws?.id ?? '__unassigned')}
      {@const collapsed = g.ws ? workspaceStore.isCollapsed(g.ws.id) : false}
      <section class="group">
        {#if g.ws}
          {@const ws = g.ws}
          <div class="group__header">
            <button
              class="twisty"
              aria-label={collapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!collapsed}
              onclick={() => workspaceStore.toggleCollapsed(ws.id)}
            >{collapsed ? '▸' : '▾'}</button>
            <span class="ws-name" title={ws.path}>{ws.name}</span>
            <span class="ws-count">{g.rows.length}</span>
            <button
              class="ws-remove"
              title="Remove workspace"
              aria-label="Remove workspace"
              onclick={() => removeWorkspace(ws, g)}
            >×</button>
          </div>
        {:else}
          <div class="group__header group__header--unassigned">
            <span class="twisty-spacer"></span>
            <span class="ws-name" title="Sessions not bound to a workspace">Unassigned</span>
            <span class="ws-count">{g.rows.length}</span>
          </div>
        {/if}

        {#if !collapsed}
          <ul class="sessions">
            {#each g.rows as r (r.id)}
              <li>
                <!-- Row is a div (not a button) so it can contain the kill
                     button; nested <button> is invalid HTML. Keyboard via role. -->
                <div
                  class="session"
                  class:active={r.id === activeId}
                  role="button"
                  tabindex="0"
                  aria-pressed={r.id === activeId}
                  title={r.resumable ? `Resume — ${r.cwd}` : r.cwd}
                  onclick={() => onSelect(r)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void onSelect(r);
                    }
                  }}
                >
                  <span class="dot" data-state={statusDot(r)} aria-hidden="true"></span>
                  <span class="title">{r.title}</span>
                  <span class="agent">{r.agent}</span>
                  <button
                    class="kill"
                    title={r.live ? 'Kill session' : 'Forget session'}
                    aria-label={r.live ? 'Kill session' : 'Forget session'}
                    onclick={(e) => onKill(e, r)}
                  >×</button>
                </div>
              </li>
            {/each}

            {#if g.ws}
              {@const ws = g.ws}
              <li>
                <button
                  class="new-session"
                  disabled={sessionStore.loading}
                  onclick={() => newSession(ws, g.rows.length)}
                >+ new session</button>
              </li>
            {/if}
          </ul>
        {/if}
      </section>
    {/each}

    {#if workspaces.length === 0}
      <p class="empty">No workspaces yet. Add one (a directory path) to spawn sessions there.</p>
    {/if}
  </div>

  <footer class="session-list__footer">
    {#if showForm}
      <form
        class="ws-form"
        onsubmit={(e) => {
          e.preventDefault();
          submitWorkspace();
        }}
      >
        <input
          class="ws-input"
          type="text"
          placeholder="/path/to/project"
          bind:value={formPath}
          oninput={() => {
            // Mirror the basename into the name field until the user edits it.
            if (formName === '' || formName === basename(formPath)) {
              formName = basename(formPath);
            }
          }}
        />
        <input
          class="ws-input"
          type="text"
          placeholder="name (optional)"
          bind:value={formName}
        />
        <div class="ws-form__actions">
          <button type="submit" class="btn-primary" disabled={!formPath.trim()}>Add</button>
          <button type="button" class="btn-ghost" onclick={cancelWorkspace}>Cancel</button>
        </div>
      </form>
    {:else}
      <button class="new-ws-btn" onclick={() => (showForm = true)}>+ New workspace</button>
    {/if}
  </footer>
</aside>
{/if}

{#if showSettings}
  <SettingsPanel onClose={() => (showSettings = false)} />
{/if}

<style>
  .session-list {
    display: flex;
    flex-direction: column;
    width: 240px;
    flex: 0 0 240px;
    min-height: 0;
    background: #0e1219;
    border-right: 1px solid #1c2230;
    color: #bfbdb6;
  }
  .session-list__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #1c2230;
  }
  .brand {
    font: 600 13px ui-monospace, monospace;
    letter-spacing: 0.04em;
    color: #e6b450;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #8a93a3;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0;
  }
  .icon-btn:hover {
    background: #161b25;
    color: #e6b450;
  }
  /* Folded rail: a thin vertical strip with just the unfold + settings glyphs. */
  .session-list--rail {
    width: 40px;
    flex: 0 0 40px;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding-top: 8px;
  }
  .rail-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #8a93a3;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0;
  }
  .rail-btn:hover {
    background: #161b25;
    color: #e6b450;
  }
  .error {
    padding: 6px 12px;
    font: 11px ui-monospace, monospace;
    color: #f07178;
    background: #1a1014;
  }
  .groups {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
  }
  .empty {
    padding: 12px;
    margin: 0;
    font: 12px ui-monospace, monospace;
    line-height: 1.5;
    color: #5c6773;
  }
  .group {
    margin-bottom: 4px;
  }
  .group__header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    font: 600 11px ui-monospace, monospace;
    letter-spacing: 0.03em;
    color: #8a93a3;
    text-transform: uppercase;
  }
  .group__header--unassigned {
    color: #5c6773;
  }
  .twisty {
    flex: 0 0 auto;
    width: 14px;
    border: none;
    background: transparent;
    color: #5c6773;
    cursor: pointer;
    padding: 0;
    font-size: 10px;
    line-height: 1;
  }
  .twisty-spacer {
    flex: 0 0 auto;
    width: 14px;
  }
  .ws-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-count {
    flex: 0 0 auto;
    color: #3d4654;
    font-weight: 400;
  }
  .ws-remove {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: #3d4654;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  .ws-remove:hover {
    color: #f07178;
  }
  .sessions {
    list-style: none;
    margin: 0 0 2px 0;
    padding: 0;
  }
  .session {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px 6px 20px;
    margin: 1px 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font: 12px ui-monospace, monospace;
  }
  .session:hover {
    background: #161b25;
  }
  .session.active {
    background: #1f2733;
  }
  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #5c6773;
  }
  .dot[data-state='live'] {
    background: #7fd962;
  }
  .dot[data-state='pending'] {
    background: #e6b450;
  }
  .dot[data-state='dead'] {
    background: #f07178;
  }
  /* Server-forgotten but resumable: a cool tone that reads as "click to wake". */
  .dot[data-state='stopped'] {
    background: #59c2ff;
  }
  .title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent {
    flex: 0 0 auto;
    font-size: 10px;
    color: #5c6773;
  }
  .kill {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: #5c6773;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  .kill:hover {
    color: #f07178;
  }
  .new-session {
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    color: #5c6773;
    cursor: pointer;
    font: 11px ui-monospace, monospace;
    padding: 5px 8px 5px 20px;
    border-radius: 4px;
  }
  .new-session:hover {
    background: #161b25;
    color: #bfbdb6;
  }
  .new-session:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .session-list__footer {
    flex: 0 0 auto;
    padding: 8px;
    border-top: 1px solid #1c2230;
  }
  .new-ws-btn {
    width: 100%;
    font: 12px ui-monospace, monospace;
    color: #0b0e14;
    background: #e6b450;
    border: none;
    border-radius: 4px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .ws-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ws-input {
    width: 100%;
    box-sizing: border-box;
    font: 12px ui-monospace, monospace;
    color: #bfbdb6;
    background: #0b0e14;
    border: 1px solid #1c2230;
    border-radius: 4px;
    padding: 5px 7px;
  }
  .ws-input:focus {
    outline: none;
    border-color: #e6b450;
  }
  .ws-form__actions {
    display: flex;
    gap: 6px;
  }
  .btn-primary {
    flex: 1 1 auto;
    font: 12px ui-monospace, monospace;
    color: #0b0e14;
    background: #e6b450;
    border: none;
    border-radius: 4px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn-ghost {
    flex: 0 0 auto;
    font: 12px ui-monospace, monospace;
    color: #8a93a3;
    background: transparent;
    border: 1px solid #1c2230;
    border-radius: 4px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .btn-ghost:hover {
    border-color: #2a3340;
  }
</style>
