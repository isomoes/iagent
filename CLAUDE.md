# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

iagent hosts a terminal coding agent (Claude Code / Codex CLI) in a web UI: the agent's **PTY lives on the server** (`Bun.Terminal`), its **renderer lives in the browser** (`@xterm/xterm`), and **one WebSocket per attached session** is the wire. Read [`docs/ARCH.md`](./docs/ARCH.md) before non-trivial work — it is the canonical design rationale (flow control, persistence, focus model, security) and the source files implement it closely. [`README.md`](./README.md) covers running, env vars, and the Surfingkeys/Vimium keyboard snippet.

## Commands

Everything runs under **Bun ≥ 1.3.5** (package manager + runtime + bundler + test runner). `Bun.Terminal` is POSIX-only, so there is no Windows path.

```sh
bun install
bun run dev          # server (:4517) + client (:5173 Vite) together — develop here, open :5173
bun run dev:server   # Bun.serve --watch only
bun run dev:client   # Vite only (proxies /api and /ws -> 4517)
bun run typecheck    # tsc --noEmit (shared/server/cli) + svelte-check (client), across all packages
bun run build        # vite build of the client -> packages/client/dist
bun test             # Bun's test runner
```

Run one test file or one test by name:

```sh
bun test packages/server/test/ring-buffer.test.ts
bun test -t "high watermark"          # filter by test name substring
```

Build the publishable CLI artifact (bundles server+shared into one file, copies the client build next to it):

```sh
bun run --filter '@isomoes/iagent' build      # -> packages/cli/dist (iagent.js + public/)
cd packages/cli && npm pack --dry-run         # inspect exactly what would publish
```

**Releasing is tag-driven**: add a `## X.Y.Z` section to `CHANGELOG.md`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. Two workflows fire on the tag — `release.yml` (GitHub Release) and `publish.yml` (npm via OIDC trusted publishing). All four packages share one version, bumped in lockstep at release (the publish workflow stamps it; `package.json` versions in-repo may lag a tag). See README §Releasing.

## Layout & a hard convention

Bun-workspaces monorepo, four packages:

| Package | Role |
| --- | --- |
| `packages/shared` (`@iagent/shared`) | Wire protocol + REST DTOs + config — the contract both sides import |
| `packages/server` (`@iagent/server`) | PTY host + WS gateway + REST (`Bun.serve`, `Bun.Terminal`) |
| `packages/client` (`@iagent/client`) | Browser UI (Vite + Svelte 5 + xterm.js) |
| `packages/cli` (`@isomoes/iagent`) | The published `npx`-able bin; bundles server+shared+client into one process |

`@iagent/shared` is **consumed as raw TypeScript, with no build step** — its `exports` point straight at `./src/index.ts`. The server runs it through Bun; Vite transpiles it in-tree (`optimizeDeps.exclude`). So editing `shared` immediately affects both sides with no rebuild, and a type change there is a cross-cutting contract change.

Two conventions that will bite if missed:
- **Relative imports use `.js` extensions on `.ts` files** (`import { startServer } from './index.js'`). `moduleResolution: bundler` requires it; the file is really `.ts`.
- `tsconfig.base.json` sets `strict`, `verbatimModuleSyntax` (type-only imports must be `import type`), `noUncheckedIndexedAccess` (indexing yields `T | undefined`), and `noEmit`. New packages extend it.

## Architecture — the parts that span files

**The wire protocol (`packages/shared/src/protocol.ts`) is the spine.** Every session-socket frame is one binary message: `byte[0]` is a channel prefix (`0x01` DATA, `0x00` CONTROL), the rest is payload. The single most important rule across the whole codebase: **DATA bytes are opaque and are NEVER decoded as text at a frame boundary** — batching/chunking can split a multibyte UTF-8 codepoint, so raw bytes go straight to `term.write(Uint8Array)` / `pty.write`. seq and ACK accounting are **byte-based and absolute**, never codepoint-based. `decodeFrame`/`encodeData`/`encodeControl` are the only places framing is touched.

**The PTY cannot be paused.** `Bun.Terminal` (behind the `Pty` interface in `packages/server/src/pty.ts`) is push-only: write/resize/close + a `data` callback, no `pause()/resume()`. Process exit is detected via `proc.exited`, not a terminal callback. The `Pty` interface is a deliberate seam — a future `node-pty` adapter (Windows / true pausing) slots in without touching `Session`/`SessionManager`.

**Because the producer can't be throttled, backpressure lives downstream — this is the core of `Session` (`packages/server/src/session.ts`).** PTY output always lands in a bounded scrollback **ring buffer** (`ring-buffer.ts`) first; the ring is both the only sink for a detached session and the throttle for an attached one. A coalescing timer (`batchMs`/`batchBytes`) flushes the unsent ring suffix as one DATA frame, gated by (a) a byte-based high/low watermark on un-acked bytes and (b) `Bun.serve` socket backpressure (`send()` returns `-1` → wait for the `drain` event). The client closes the loop: it ACKs cumulative **rendered** bytes via the xterm write-callback (`ws-client.ts` `noteRendered`), never bytes merely received. Under overflow, oldest scrollback is dropped by design — replay is **not lossless**.

**Sessions outlive sockets (tmux-like).** Closing the tab detaches but keeps the PTY running. **Lazy attach**: at most one live WebSocket per session; the focused tab attaches, background sessions keep draining into their ring. On reconnect the client sends `lastSeq`; if the ring floor passed it, the server replays a client-pushed `@xterm/addon-serialize` snapshot + a `truncated` marker instead of raw bytes (the **server has no terminal model of its own** — the snapshot string originates from the client). `SessionManager` (`session-manager.ts`) owns sessions by id and enforces three limits: `maxSessions`, a cross-session ring-memory ceiling, and idle-GC that reaps detached/dead sessions but never an attached (actively-viewed) one.

**Auth is single-user/localhost (`auth.ts`).** Binds to localhost only, so there is no token — but there are two gates: an exact-match **origin allowlist** (CSRF defense; absent Origin = non-browser, allowed) and **per-session ownership**, re-checked on every `attach` frame (the handshake authenticates a connection, not entitlement to every session). The fixed principal is `'local'`. This is effectively RCE-as-a-service — do not widen the bind address without adding TLS + real auth first.

**One process, one origin (the CLI).** `packages/server/src/index.ts` (`startServer`) is a pure library — no side effects on import — so `packages/cli/src/cli.ts` can point `IAGENT_PUBLIC_DIR` at its bundled client build and serve UI + REST + WS from a single `Bun.serve`. `main.ts` is the thin `bun start` runner. `build.ts` bundles server+shared into one Bun-target file with a `#!/usr/bin/env bun` shebang; the published package has **zero runtime deps** beyond Bun.

**Client (`packages/client/src`).** Svelte 5 app shell + an xterm wrapper (`lib/terminal.ts`) and the WS client (`lib/ws-client.ts`). The **DOM renderer is the default on purpose** — privacy/anti-fingerprint tooling (Canvas Blocker, Brave farbling, Chrome fingerprint-defense) poisons canvas readback and paints WebGL/Canvas glyphs as black blocks; `?renderer=webgl|canvas|auto` opts into GPU rendering (`auto` probes for canvas tampering first). The app version is inlined at build time as `__APP_VERSION__` (`'dev'` under the Vite dev server, the package version in a real build) — see `vite.config.ts` and `StatusBar`.

**Keyboard ownership** (see ARCH §Focus, and the README snippet): a terminal living in a web page means xterm and any page-level Vim extension compete for keys. The rule — the terminal owns the whole keyboard **only while focused** (`Esc` included, so the agent gets it); `Tab` is the deliberate "leave" gesture, intercepted in `terminal.ts`'s `attachCustomKeyEventHandler` before it becomes a `\t`. The app **never installs an app-wide keydown capture**; re-entry works through a visible `.terminal-host[role=textbox]` affordance. Don't break either invariant.

## Testing notes

Tests live in `packages/server/test/*.test.ts` and alongside source as `packages/shared/src/*.test.ts`, using `bun:test`. `Session` and the WS path are tested with a **fake `Pty` and fake `SessionSocket`** injected via `SessionDeps` (`spawnPty`) — no real terminal spawns. When changing flow control or framing, exercise it through those fakes the same way `session-flow-control.test.ts` does.
