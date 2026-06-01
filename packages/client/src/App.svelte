<script lang="ts">
  // ==========================================================================
  // App — root shell: session list (sidebar) + the focused TerminalView + a
  // status bar. LAZY ATTACH is enforced by keying the TerminalView on the
  // active session id ({#key activeId}): only ONE TerminalView exists at a
  // time, so only one live WebSocket + one WebGL context is held. Switching
  // sessions unmounts the old view (closing its WS / freeing its GL context)
  // and mounts a fresh one that re-attaches; the server replays from its ring.
  // ==========================================================================

  import SessionList from './components/SessionList.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import TerminalView from './components/TerminalView.svelte';
  import { sessionStore } from './lib/sessions.svelte.js';

  const activeId = $derived(sessionStore.activeId);
  const active = $derived(sessionStore.active);

  // The panel that holds the focused terminal; registered so the store can
  // measure the viewport and spawn new PTYs at full size (not the 80×24 default).
  let panelEl = $state<HTMLElement | null>(null);

  $effect(() => {
    sessionStore.startPolling();
    return () => sessionStore.stopPolling();
  });

  $effect(() => {
    sessionStore.setHost(panelEl);
    return () => sessionStore.setHost(null);
  });
</script>

<div class="app">
  <div class="layout">
    <SessionList />

    <main class="panel" bind:this={panelEl}>
      {#if activeId}
        <!-- key forces unmount/remount on session switch => lazy attach. -->
        {#key activeId}
          <TerminalView sessionId={activeId} />
        {/key}
      {:else}
        <div class="placeholder">
          <p>No session selected.</p>
          <p class="hint">Create a session from the sidebar to spawn an agent.</p>
        </div>
      {/if}
      <StatusBar session={active} />
    </main>
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: #0b0e14;
  }
  .layout {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .panel {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    flex: 1 1 auto;
    color: #5c6773;
    font: 13px ui-monospace, monospace;
  }
  .placeholder .hint {
    font-size: 11px;
    color: #3d4654;
  }
</style>
