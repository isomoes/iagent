<script lang="ts">
  // ==========================================================================
  // TerminalView — mounts the live Terminal + WsClient for the FOCUSED session
  // (lazy attach, ARCH §Multi-session). It is keyed by sessionId in App.svelte,
  // so switching tabs unmounts this (closing the WS, freeing the WebGL context)
  // and mounts a fresh one for the new session, which re-attaches and lets the
  // server replay from the ring buffer.
  //
  // Wires the write-callback ACK loop: every DOWN-data batch is written to
  // xterm with a render-callback that advances WsClient.noteRendered(n), which
  // coalesces byte-based acks back to the server (the flow-control signal).
  // ==========================================================================

  import { untrack } from 'svelte';
  import type { AttachedMsg, ExitMsg } from '@iagent/shared';
  import { createTerminal, type TerminalHandle } from '../lib/terminal.js';
  import { WsClient, type WsStatus } from '../lib/ws-client.js';
  import { sessionWsUrl } from '../lib/config.js';
  import { sessionStore } from '../lib/sessions.svelte.js';

  interface Props {
    sessionId: string;
  }
  const { sessionId }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let exitInfo = $state<ExitMsg | null>(null);

  const RESIZE_DEBOUNCE_MS = 150;

  // Effect: on mount (and whenever sessionId changes via key), build the
  // terminal + socket; on teardown dispose both. This IS the lazy-attach core.
  $effect(() => {
    const el = host;
    if (!el) return;

    const id = sessionId;
    let disposed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    // Only the focused client issues resizes, and only AFTER it has fitted to
    // the server's authoritative size from the 'attached' frame.
    let attached = false;

    const term: TerminalHandle = createTerminal();
    term.mount(el);

    const ws = new WsClient(sessionWsUrl(id), id, {
      onData(bytes) {
        const n = bytes.length;
        // Render-callback fires once xterm has actually rendered the bytes;
        // THEN we count them as rendered + ack (never on mere receipt).
        term.write(bytes, () => {
          if (!disposed) ws.noteRendered(n);
        });
      },
      onAttached(msg: AttachedMsg) {
        // PTY size is the source of truth on attach: fit to it FIRST so any
        // replayed scrollback/snapshot renders at the size it was produced.
        term.applySize(msg.cols, msg.rows);
        attached = true;
        exitInfo = null;
        term.focus();
        // ...and ONLY THEN, as the focused client, fit to our real container and
        // issue a (debounced) resize if it differs from the PTY's current size.
        // Without this a freshly-created PTY (spawned at 80x24) stays locked at
        // 80x24 inside a larger viewport, since the ResizeObserver does not
        // re-fire on a grid resize (ARCH §Wire protocol: fit, then resize).
        const dims = term.fit();
        if (dims.cols > 0 && dims.rows > 0 && (dims.cols !== msg.cols || dims.rows !== msg.rows)) {
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => ws.sendResize(dims.cols, dims.rows), RESIZE_DEBOUNCE_MS);
        }
      },
      onSnapshot(data) {
        // Truncated reconnect: replay the serialized screen before live data.
        term.writeSnapshot(data);
      },
      onServerResize(cols, rows) {
        // Apply-then-ack echo from the server; keep xterm in lockstep.
        term.applySize(cols, rows);
      },
      onExit(msg) {
        exitInfo = msg;
      },
      onStatus(status: WsStatus) {
        sessionStore.setStatus(id, status);
        // Background poll will reflect alive/exitCode; nothing else to do.
      },
    });

    // Keystrokes -> DATA frames (UP). Raw UTF-8 bytes, never decoded server-side
    // at a boundary. (DEFERRED: local echo/typeahead would render here first.)
    term.onInput((bytes) => ws.sendInput(bytes));

    // Grid resize -> debounced resize control frame (focused client only).
    term.onResize((cols, rows) => {
      if (!attached) return; // ignore the initial fit-driven resize.
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        ws.sendResize(cols, rows);
      }, RESIZE_DEBOUNCE_MS);
    });

    // Refit on container resize (debounced -> single resize frame).
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      const dims = term.fit();
      if (attached && dims.cols > 0 && dims.rows > 0) {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => ws.sendResize(dims.cols, dims.rows), RESIZE_DEBOUNCE_MS);
      }
    });
    ro.observe(el);

    // connect() synchronously emits onStatus -> sessionStore.setStatus, which
    // reads AND writes the statusMap $state. Run it untracked so this effect
    // depends ONLY on host + sessionId; otherwise the status write invalidates
    // the effect, remounting the terminal + socket in a tight loop (a fresh
    // WebGL context + WS per cycle, until the browser exhausts both).
    untrack(() => ws.connect());

    return () => {
      disposed = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      ro.disconnect();
      // Push our serialized screen BEFORE closing, so a later truncated
      // reconnect (this tab refocused after long background output) replays the
      // reconstructed screen instead of a blank terminal (ARCH §Session
      // persistence). Server caches the latest per session.
      if (attached) ws.sendSnapshot(term.serialize());
      ws.close(); // closes WS for good (lazy detach)
      term.dispose(); // frees the WebGL context
    };
  });
</script>

<div class="terminal-view">
  <div class="terminal-host" bind:this={host}></div>
  {#if exitInfo}
    <div class="exit-banner" role="status">
      Process exited (code {exitInfo.code}{exitInfo.signal ? `, signal ${exitInfo.signal}` : ''}).
    </div>
  {/if}
</div>

<style>
  .terminal-view {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #0b0e14;
  }
  .terminal-host {
    flex: 1 1 auto;
    min-height: 0;
    padding: 6px 8px;
  }
  .exit-banner {
    flex: 0 0 auto;
    padding: 6px 10px;
    font: 12px/1.4 ui-monospace, monospace;
    color: #f07178;
    background: #1a1f29;
    border-top: 1px solid #2a3140;
  }
</style>
