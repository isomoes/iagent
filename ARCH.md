# iagent — Architecture

A web UI that hosts a terminal coding agent (Claude Code / Codex CLI). The agent's
**TTY lives on the server**; its **renderer lives in the browser**; a WebSocket is the wire.
Modeled on VSCode's integrated terminal (`xterm.js` front, server PTY back) — but the PTY is
`Bun.Terminal`, not `node-pty` (see §PTY backend for the consequences).

```
┌───────────────── Browser (client) ─────────────────┐
│ @xterm/xterm + addons (webgl, fit, serialize)       │
│ WS client: reconnect + backoff + lastSeq + ACKs     │
└──────────┬──────────────────────────────▲──────────┘
   keystrokes (binary)            PTY output (binary, seq-tagged)
           ▼                              │
    ════════  WebSocket (wss, auth on handshake)  ════════
           ▼                              │
┌──────────┴──────────────────────────────▲──────────┐
│ WS gateway (Bun.serve, native WebSocket)            │
│ SessionManager: PTY sessions by id, scrollback ring │
│                 buffer, monotonic seq, flow control │
│ Bun.Terminal → spawn agent (Claude Code; pluggable) │
└──────────┬──────────────────────────────▲──────────┘
      stdin │                              │ stdout/stderr
┌───────────▼──────────────────────────────┴─────────┐
│        Agent process running inside the PTY         │
└─────────────────────────────────────────────────────┘
```

## Stack

Full-stack TypeScript, **Bun** monorepo — Bun is package manager + runtime + bundler + test
runner; uses Bun workspaces. **Server is Bun-native by default** (no Node, no native addons); a
`node-pty` adapter is an optional fallback for true PTY pausing or Windows (see §PTY backend).

| Package           | Role           | Key deps                                                              |
| ----------------- | -------------- | --------------------------------------------------------------------- |
| `packages/client` | Browser UI     | Vite + **Svelte 5**, `@xterm/xterm`, `@xterm/addon-webgl` `-fit` `-serialize` `-web-links` |
| `packages/server` | PTY host + WS  | `Bun.serve` (native WebSocket), `Bun.Terminal` (native PTY, Bun ≥1.3.5) |
| `packages/shared` | Wire protocol  | Message types imported by both sides (type-checked end to end)        |

> **Svelte over React** — compiles to minimal vanilla JS, no virtual-DOM diffing, smallest
> runtime. The app shell (session list, tabs, panels) stays near-zero overhead; xterm.js + WebGL
> do the heavy lifting. (Client bundled by Vite via the Svelte plugin, run under Bun.)
> **`Bun.serve` over `ws`/socket.io** — native, faster, with built-in backpressure (`send()`
> returns `-1`, `backpressureLimit`, `drain` event) and `cork()` to batch sends into one syscall.
> **`Bun.Terminal` over `node-pty`** — native PTY, no fragile native-addon build. Trade-off:
> push-only, no pause/resume, POSIX-only — see §PTY backend.
> Use `@xterm/*` scoped packages; the old `xterm` package is deprecated.

## PTY backend

`Bun.Terminal` (Bun ≥1.3.5) is the PTY. **It is push-only** — `write`, `resize`, `setRawMode`,
`ref/unref`, `close`; output arrives via a `data(term, bytes)` callback. There is **no
`pause()`/`resume()`** (unlike `node-pty`). Consequences the design must respect:

- **The PTY cannot be throttled.** Backpressure is handled *downstream* of it (see §Performance),
  never by stopping the producer. The server-side ring buffer is the sole sink and the throttle.
- **Maturity / portability risk** — `Bun.Terminal` is new and **POSIX-only (no Windows)**. So the
  PTY sits behind a small `Pty` interface in `SessionManager`; a `node-pty`/`bun-pty` adapter
  (which *does* expose pause/resume) is the documented fallback if we need true producer pausing
  or Windows support.
- Process exit is detected via the spawned process's `proc.exited`, not a terminal callback;
  teardown is `proc.kill()` then `terminal.close()`.

## Wire protocol

**One WebSocket per attached session** (not one multiplexed socket) — keeps flow control
independent and stops a noisy session from head-of-line-blocking the others. A separate
lightweight **management** channel (REST or its own WS) lists / creates / kills sessions.

Each session socket carries two logical channels, distinguished by a **1-byte prefix**:

- `0x01` **data** — an **opaque byte stream** (`Uint8Array`). Keystrokes up, PTY bytes down. Never
  `toString()`/decode at a frame boundary: batching + chunking will split multibyte UTF-8, so we
  pass raw bytes straight to `term.write(uint8)` (xterm.js buffers partial codepoints internally).
  ACK/seq accounting is **byte-based, not codepoint-based**. No JSON/base64.
- `0x00` **control** — JSON: `resize {cols,rows}`, `attach {sessionId,lastSeq}`, `ack {bytes}`,
  `exit {code}`, `ping`/`pong`.

Resize is **debounced** client-side and applied-then-acked server-side (avoids resize storms
that desync xterm and the PTY). **Source of truth on attach:** the running PTY's current size
wins — the server pushes it on `attach`, the client fits to it, and only then may the *focused*
client issue a new `resize`.

## Multi-session

One site manages many concurrent agent sessions.

- `SessionManager` owns N PTY sessions keyed by ID; the UI shows a session list / tabs.
- **Lazy attach** — only the focused tab holds a live WebSocket (and, when WebGL is opted into,
  a GL context — browsers cap WebGL contexts ~16/page; the default DOM renderer uses none).
  Background sessions keep running server-side; on re-focus the client re-attaches and the server
  replays from the ring buffer.
- **Detached draining** — a detached session's PTY keeps producing (it can't be paused), so the
  ring buffer is its only sink. The buffer is bounded per session (oldest bytes dropped) with a
  total memory cap across sessions; a detached *fast* producer therefore loses old scrollback by
  design — acknowledged, not a bug.
- New session = management call → spawn PTY → open a session WebSocket.
- **Limits & GC** — a max-concurrent-sessions cap; an idle-GC timer that reaps sessions
  (`proc.kill()` → `terminal.close()`); per-session memory ceiling. Without these, tmux-like
  persistence + lazy attach makes orphaned sessions the default state.

> **Transport caveat** — "one WebSocket per attached session" only scales because lazy attach
> keeps ~one live socket; HTTP/1.1 caps ~6 connections/origin. If we ever attach several at once,
> serve over **HTTP/2** (one connection, ~100 streams) so the per-host limit is moot.

## Session persistence

PTY lifecycle is **independent of the socket** (tmux-like). Closing the tab does not kill the agent.

- Each session has a **bounded** scrollback ring buffer and **monotonic sequence numbers**.
- On reconnect the client sends `lastSeq`. Replay is **not lossless**: if `lastSeq` is older than
  the buffer's floor, the server sends a fresh snapshot (`@xterm/addon-serialize`) plus a
  *"scrollback truncated"* marker instead of a byte replay; otherwise it replays bytes after
  `lastSeq`. (Never advertise lossless replay — the ring drops old data under load.)
- Reconnect uses exponential backoff, capped (~10–15 tries / 2–5 min).
- Start in-memory; keep the `SessionManager` interface durable-ready (tmux/persisted buffer later).

## Performance (design defaults)

Lag comes from rendering, producer-overwhelm, and input latency — rarely the network. Fixes:

1. **Renderer** — the **DOM renderer is the default**: real `<span>` text, immune to the
   canvas-readback poisoning (privacy extensions, Brave farbling, Chrome fingerprint-defense
   flags) that paints WebGL/Canvas glyphs as black blocks, and fast enough for passthrough TUI.
   GPU rendering is opt-in via `?renderer=webgl` (`@xterm/addon-webgl`, up to ~9× faster *frame
   rendering* via a GPU glyph atlas — a render-rate win, distinct from the write-throughput limit
   in (2); Canvas fallback + `onContextLoss` handling). `?renderer=auto` probes for canvas
   tampering and takes WebGL only when the canvas is clean.
2. **Flow control (critical)** — `term.write()` sustains only ~5–35 MB/s on the main thread;
   fast producers overflow the buffer and freeze keystrokes. The PTY **cannot be paused**
   (§PTY backend), so backpressure is applied to the *socket*, not the producer:
   - Client runs the **write-callback ACK loop** — `term.write(bytes, () => ackBytes(n))` ACKs
     every X bytes once actually rendered; the server stops *sending* past a high-watermark of
     unacked bytes and resumes on catch-up.
   - Server also honors `Bun.serve` socket backpressure — `send()` returning `-1` and the `drain`
     event gate further sends; bytes the socket can't take stay queued in the ring buffer.
   The ring buffer (not the PTY) absorbs the slack and is bounded — see §Session persistence for
   what happens when it overflows.
3. **Coalesce output server-side** — batch PTY `data` on a ~5–16 ms timer or size threshold;
   one WS frame per batch, not per event, and `cork()` the sends. Composes with flow control.
4. **Wire hygiene** — binary frames only, `TCP_NODELAY` (no Nagle), `permessage-deflate` off by
   default (revisit only for bulk output over a real network).
5. **Local echo / typeahead** — render keystrokes in dimmed text before confirmation, reconcile
   against real output (Mosh overlay). Auto-enable above ~30 ms latency. For remote use.
6. **Bounded scrollback** — deliberate `scrollback` cap; snapshot via `@xterm/addon-serialize`
   for reconnect instead of replaying raw megabytes.

**Targets:** <50 ms keystroke-to-echo; no freeze on a 100 MB output dump.

## Focus & browser keyboard extensions

iagent is a terminal living inside a web page, so **two keyboard owners compete for the same
keystrokes**: the focused xterm (where every key — `j`, `f`, `/`, `i` included — is a raw byte for
the PTY) and any page-level Vim extension the user runs (Surfingkeys, Vimium, Tridactyl), which
treats the page as a *document* to navigate. The rule: **the terminal owns the keyboard only while
it is focused; the extension owns it while the terminal is blurred — and re-entry into the terminal
must be discoverable by the extension.**

- **Caveat — a new session wastes its first keystroke.** When a new session auto-focuses
  (`term.focus()` on attach) and the user types, Surfingkeys' anti-focus-hijack heuristic fires:
  because xterm's textarea is *off-screen* (`left:-9999em`, so `isElementPartiallyInViewport` is
  false) **and** *newly created* (its subtree was just added to the DOM), Surfingkeys **blurs it and
  consumes that first key as a Normal-mode command** instead of entering Insert mode
  (`normal.js` stealFocus path; the `newlyCreated` flag is set on every added node by its
  `MutationObserver`). The user recovers by pressing `i`. Confirmed in source — it is *not* an
  `isEditable` visibility filter (that returns true for the textarea) nor the `isTrusted` gate; it is
  specifically off-screen + newly-created. Same family of cause as `f`/`i` re-entry (the hidden
  textarea), fixed the same way — the per-origin config (below) enters Insert mode on terminal focus
  (a synthetic `mousedown` → `insert.enter`). The app must still **never add an app-wide `keydown`
  capture** to brute-force this — it would swallow keys the extension needs while the terminal is
  *blurred*.
- **The break is re-entry after `Esc`.** `Esc` returns the extension to normal mode and blurs the
  textarea. The user then expects `f` (follow/hints) or `i` (go to edit box) to put focus back — and
  both fail. Root cause: xterm styles its textarea `opacity:0; left:-9999em; width:0; height:0;
  z-index:-5` (`@xterm/xterm/css/xterm.css`), and extensions enumerate hint/edit targets by
  visibility + non-zero geometry. The only "input" on the page is invisible to them, so there is **no
  element to land on** and the user is stranded on the mouse.

**Decision — who owns `Esc` and `Tab`.** `Esc` is overloaded: the agent needs it (interrupt,
dismiss, clear the prompt) and the extension uses it to exit insert mode → blur. The browser hands
the keystroke to whoever grabs it first, and the extension's document-capture listener wins, so by
default `Esc` blurs the terminal and never reaches the agent. We resolve this by *ownership*, not by
racing the extension from inside the page (which we'd lose):

- **Focused ⇒ the terminal owns the whole keyboard, `Esc` included.** The extension must be told
  *not* to trap `Esc` in insert mode on the iagent origin (see snippet). This is the one piece the
  app cannot enforce itself — a content script's capture listener fires before any in-page handler.
- **`Tab` is the deliberate "leave" gesture.** Plain `Tab` is intercepted in xterm's
  `attachCustomKeyEventHandler` (`terminal.ts`) — `preventDefault()` + `term.blur()` *before* it
  becomes a `\t` byte — handing control back to the extension's normal mode. Explicitly **not `Esc`**
  (the agent's) and **not `Ctrl-Q`** (that is XON `0x11` to the tty *and* the browser-quit shortcut
  on Linux, which a content script can't reliably override). Trade-off: while focused the agent no
  longer receives a literal `Tab`; `Shift+Tab` is left untouched (it stays Claude Code's mode-cycle),
  and every other key — `Esc` among them — passes straight through.

**Rule — own the re-entry affordance; do not hack xterm internals.**

- The terminal panel exposes a **visible, focusable, hint-discoverable** re-entry target:
  `tabindex="0"` + `role="textbox"` on `.terminal-host`, a `click`/`focus` handler that calls
  `term.focus()`, and a visible focus ring. A real, on-screen, non-zero-area, focusable element is
  reliably hinted by `f` and reachable by native `Tab`; the hint (or a click, or `Tab`+`Enter`) then
  forwards focus into the hidden textarea via `term.focus()`.
- **Do not** restyle `.xterm-helper-textarea` to make `i` discover it — giving the textarea real
  geometry breaks xterm's IME/cursor positioning and is fragile across `@xterm` releases. `i`
  (editable-only detection) is not a reliable re-entry path here; `f`, click, and `Tab` are.

**Be friendly to Surfingkeys (and siblings) — ship a per-origin snippet.** Because the extension's
mode can't be driven from page code, the README documents a drop-in `~/.surfingkeys.js` for the
iagent origin that must do three things:

1. **Re-entry key** — map a key (e.g. `t`) to `.focus()` the terminal; a mapped callback can focus
   the hidden textarea *programmatically* even though hints can't *see* it (below).
2. **Auto-insert on terminal focus** — on `focusin` of `.xterm-helper-textarea`, dispatch a synthetic
   `mousedown` (Surfingkeys' mousedown handler runs `insert.enter`, bypassing the first-keystroke
   blur) so a freshly auto-focused session is typable without pressing `i`.
3. **Don't exit insert on `Esc`** — `iunmap('<Esc>')` for the origin, so in Insert mode `Esc`
   propagates to the textarea → the agent (the terminal owns it while focused).

> Source-verified against Surfingkeys (`normal.js`, `insert.js`, `api.js`); the working snippet lives
> in the README. NB: `Normal.passThrough()` is the *wrong* lever — it exits on `Esc`, so it would eat
> the very key we are reserving for the agent. Re-verify against the installed version before relying
> on it; extension internals shift between releases.

The re-entry mapping itself is straightforward:

```js
// ~/.surfingkeys.js — make iagent friendly
const onIagent = /^https?:\/\/(localhost|127\.0\.0\.1)/;
// One key to drop back into the terminal (works regardless of textarea visibility):
mapkey('t', 'iagent: focus terminal', () => {
  (document.querySelector('.terminal-host') || document.querySelector('.xterm-helper-textarea'))?.focus();
}, { domain: onIagent });
// Optional: stay out of the way entirely on this origin.
// unmapAllExcept(['t'], onIagent);
```

> The app guarantees the **structural** half — a focusable `.terminal-host` that `f`/`Tab` can target
> and that forwards to `term.focus()`; the extension config is the **ergonomic** half — one re-entry
> key, or a per-site passthrough. Neither side fights the other: the terminal never globally swallows
> keys, and the extension is told where the terminal is.

## Security

This is effectively **remote code execution as a service** — a browser piped into an agent that
runs arbitrary shell commands.

- Bind to **localhost** only — anything that can reach the port is already on the machine, so
  there is no auth token. Do not expose the port publicly; exposing it beyond localhost would
  require adding `wss://` (TLS) + a real auth layer first.
- **Origin allowlist** on the WS handshake + REST (exact match) — CSRF defense for browser clients;
  non-browser clients (curl) omit Origin and are allowed.
- **Per-session authorization** — the handshake authenticates a *connection*; it does not entitle
  it to every session. Bind each `sessionId` to an owner (set the principal in `ws.data` at
  `server.upgrade()`) and authorize every `attach {sessionId}` against it — otherwise any
  client can hijack any running agent (a live shell). State single- vs multi-tenant explicitly;
  default here is single-user/localhost.
- Idle-session timeouts; run the agent as a restricted user / container with a working-dir jail.

## Roadmap

1. **Pure passthrough** (now) — faithfully render the agent's native TUI in xterm.js. The agent's
   UI *is* our UI. Simplest and most robust.
2. **Structured/hybrid** (later) — side-channel (agent SDK / headless mode) surfacing tool-call
   approvals, file diffs, and a chat-style view as real DOM. Layered on after passthrough works.

## Decisions

- **Frontend:** Svelte 5 (best perf vs React for the app shell).
- **Sessions:** multi-session — one site manages many agents; one WS per attached session + lazy attach.
- **First agent:** Claude Code, with a pluggable spawn command so Codex/others slot in later.
- **Browser Vim extensions:** the terminal owns keys only while focused (never a global key
  capture); expose a visible, hint-discoverable focusable affordance for re-entry after `Esc`, and
  ship a Surfingkeys per-origin snippet — see §Focus & browser keyboard extensions.
