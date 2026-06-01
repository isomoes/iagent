<script lang="ts">
  // ==========================================================================
  // StatusBar — connection status (connecting/open/reconnecting/closed), the
  // session's PTY size, agent, and exit code for the focused session, plus the
  // iagent version (always shown, far right).
  // ==========================================================================

  import type { SessionSummary } from '@iagent/shared';
  import { sessionStore } from '../lib/sessions.svelte.js';
  import type { WsStatus } from '../lib/ws-client.js';

  // Inlined at build time (see vite.config.ts): the package version for a real
  // build, or the literal 'dev' under the Vite dev server. Show 'dev' bare; a
  // real version gets a 'v' prefix.
  const version = __APP_VERSION__;
  const versionLabel = version === 'dev' ? 'dev' : `v${version}`;

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
  <span class="seg version" title="iagent version">{versionLabel}</span>
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
  .seg.exit {
    color: #f07178;
  }
  /* Always far-right: its auto-margin absorbs all free space, right-aligning
     itself while the id/size segments stay left-packed together. */
  .seg.version {
    margin-left: auto;
    color: #3d4654;
  }
</style>
