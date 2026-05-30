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
  // Non-editable, focusable (tabindex=-1) leave target: focusing it on the Tab
  // gesture drops a page-level Vim extension out of insert mode at once (see
  // term.onLeave below / ARCH §Focus).
  let viewEl = $state<HTMLDivElement | null>(null);
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

    // Re-entry affordance (ARCH §Focus & browser keyboard extensions). xterm
    // takes input through a hidden, zero-area helper <textarea> that page-level
    // Vim extensions (Surfingkeys/Vimium/Tridactyl) cannot see, so after `Esc`
    // blurs it their `f`/`i`/Tab have nothing to land on. The host is a real,
    // visible, focusable element (tabindex/role in markup) — when it receives
    // focus (an `f` hint's .focus(), native Tab) or a click lands on its padding,
    // we forward into xterm via term.focus(). Attached as DOM listeners (not
    // markup handlers) so they live and die with the terminal, add no reactive
    // state to this effect, and never decode/swallow keys.
    const refocusTerminal = (): void => {
      if (!disposed) term.focus();
    };
    el.addEventListener('focus', refocusTerminal);
    el.addEventListener('click', refocusTerminal);

    // Tab "leave" gesture: focus the (non-editable) panel container so a
    // page-level Vim extension drops out of insert mode at once — a bare blur
    // does not, wasting the first key (ARCH §Focus). viewEl is read at call
    // time, so its binding order relative to this effect does not matter.
    term.onLeave(() => {
      if (disposed) return;
      if (viewEl) viewEl.focus();
      else term.blur();
    });

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
      el.removeEventListener('focus', refocusTerminal);
      el.removeEventListener('click', refocusTerminal);
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

<div class="terminal-view" bind:this={viewEl} tabindex="-1">
  <!-- tabindex + role make the host a real, hint-discoverable focus target so a
       page-level Vim extension's `f` and native Tab can return focus to the
       terminal after Esc (ARCH §Focus & browser keyboard extensions). The
       focus/click forwarding into xterm is wired in the $effect above. -->
  <div
    class="terminal-host"
    bind:this={host}
    tabindex="0"
    role="textbox"
    aria-label="Terminal"
  ></div>
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
  /* It is only focusable (tabindex=-1) to be the Tab "leave" target; never show
     a ring for that programmatic focus. */
  .terminal-view:focus {
    outline: none;
  }
  .terminal-host {
    flex: 1 1 auto;
    min-height: 0;
    padding: 6px 8px;
  }
  /* Visible focus ring while the terminal owns the keyboard. focus lands on
     xterm's textarea (a descendant), so :focus-within is the real indicator;
     :focus covers the transient instant the host itself holds focus before it
     forwards into xterm (ARCH §Focus & browser keyboard extensions). */
  .terminal-host:focus,
  .terminal-host:focus-within {
    outline: 1px solid #e6b450;
    outline-offset: -1px;
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
