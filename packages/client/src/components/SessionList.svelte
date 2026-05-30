<script lang="ts">
  // ==========================================================================
  // SessionList — sidebar of sessions + a "new session" button. Selecting a
  // session changes the focus (lazy attach: App swaps the live TerminalView).
  // Killing a session calls REST DELETE via the store.
  // ==========================================================================

  import type { SessionSummary } from '@iagent/shared';
  import { sessionStore } from '../lib/sessions.svelte.js';

  const sessions = $derived(sessionStore.sessions);
  const activeId = $derived(sessionStore.activeId);

  function statusDot(s: SessionSummary): string {
    if (!s.alive) return 'dead';
    const st = sessionStore.status(s.id);
    if (s.id === activeId && (st === 'open')) return 'live';
    if (s.id === activeId && (st === 'connecting' || st === 'reconnecting')) return 'pending';
    return 'idle';
  }

  async function newSession(): Promise<void> {
    // Default agent comes from the server config (claude); leave req empty.
    await sessionStore.create({});
  }

  async function onKill(e: MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    await sessionStore.kill(id);
  }
</script>

<aside class="session-list">
  <header class="session-list__header">
    <span class="brand">iagent</span>
    <button class="new-btn" onclick={newSession} disabled={sessionStore.loading}>
      + New
    </button>
  </header>

  {#if sessionStore.error}
    <div class="error" role="alert">{sessionStore.error}</div>
  {/if}

  <ul class="sessions">
    {#each sessions as s (s.id)}
      <li>
        <!-- Row is a div (not a button) so it can contain the kill button;
             nested <button> is invalid HTML. Keyboard-accessible via role. -->
        <div
          class="session"
          class:active={s.id === activeId}
          role="button"
          tabindex="0"
          aria-pressed={s.id === activeId}
          onclick={() => sessionStore.select(s.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              sessionStore.select(s.id);
            }
          }}
        >
          <span class="dot" data-state={statusDot(s)} aria-hidden="true"></span>
          <span class="title" title={s.title}>{s.title || s.id.slice(0, 8)}</span>
          <span class="agent">{s.agent}</span>
          <button
            class="kill"
            title="Kill session"
            aria-label="Kill session"
            onclick={(e) => onKill(e, s.id)}
          >×</button>
        </div>
      </li>
    {:else}
      <li class="empty">No sessions. Create one to start.</li>
    {/each}
  </ul>
</aside>

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
  .new-btn {
    font: 12px ui-monospace, monospace;
    color: #0b0e14;
    background: #e6b450;
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .new-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .error {
    padding: 6px 12px;
    font: 11px ui-monospace, monospace;
    color: #f07178;
    background: #1a1014;
  }
  .sessions {
    list-style: none;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
  }
  .empty {
    padding: 12px;
    font: 12px ui-monospace, monospace;
    color: #5c6773;
  }
  .session {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    margin: 2px 0;
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
</style>
