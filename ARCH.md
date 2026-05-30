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
