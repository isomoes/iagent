<script lang="ts">
  // ==========================================================================
  // StatusBar — connection status (connecting/open/reconnecting/closed), the
  // session's PTY size, agent, and exit code for the focused session, plus the
  // iagent version (always shown, far right).
  // ==========================================================================

  import type { SessionSummary } from '@iagent/shared';
  import { sessionStore } from '../lib/sessions.svelte.js';
  import type { WsStatus } from '../lib/ws-client.js';

  // Inlined at build time from package.json (see vite.config.ts).
  const version = __APP_VERSION__;

  interface Props {
    session: SessionSummary | undefined;
  }
  const { session }: Props = $props();

  const status = $derived<WsStatus | undefined>(
    session ? sessionStore.status(session.id) : undefined,
  );

  const statusLabel = $derived(
    !session
      ? '—'
      : !session.alive
        ? 'exited'
        : (status ?? 'idle'),
  );
</script>

<footer class="status-bar">
  {#if session}
    <span class="seg status" data-state={statusLabel}>{statusLabel}</span>
    <span class="seg">{session.agent}</span>
    <span class="seg">{session.cols}×{session.rows}</span>
    <span class="seg id" title={session.id}>{session.id.slice(0, 8)}</span>
    {#if !session.alive && session.exitCode !== null}
      <span class="seg exit">exit {session.exitCode}</span>
    {/if}
  {:else}
    <span class="seg">no session</span>
  {/if}
  <span class="seg version" title="iagent version">v{version}</span>
</footer>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 0 0 auto;
    height: 24px;
    padding: 0 12px;
    background: #0e1219;
    border-top: 1px solid #1c2230;
    font: 11px ui-monospace, monospace;
    color: #5c6773;
  }
  .seg.status {
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .seg.status[data-state='open'] {
    color: #7fd962;
  }
  .seg.status[data-state='connecting'],
  .seg.status[data-state='reconnecting'] {
    color: #e6b450;
  }
  .seg.status[data-state='closed'],
  .seg.status[data-state='exited'] {
    color: #f07178;
  }
  .seg.id {
    margin-left: auto;
  }
  .seg.exit {
    color: #f07178;
  }
  /* Always far-right: pushes off the first auto-margin (the id seg) when a
     session is shown, and right-aligns itself in the no-session case. */
  .seg.version {
    margin-left: auto;
    color: #3d4654;
  }
</style>
