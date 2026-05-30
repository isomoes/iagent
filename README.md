# iagent

A web UI that hosts a terminal coding agent (Claude Code / Codex CLI). The agent's TTY lives
on the server (`Bun.Terminal`), its renderer lives in the browser (`@xterm/xterm` + WebGL), and a
WebSocket is the wire. See [`ARCH.md`](./ARCH.md) for the full architecture.

## Layout

A Bun-workspaces monorepo:

| Package           | Role          |
| ----------------- | ------------- |
| `@iagent/shared`  | Wire protocol + REST DTOs + config, consumed as raw TS by both sides |
| `@iagent/server`  | PTY host + WebSocket gateway (`Bun.serve`, `Bun.Terminal`) |
| `@iagent/client`  | Browser UI (Vite + Svelte 5 + xterm.js) |

## Requirements

- **Bun ≥ 1.3.5** (package manager + runtime + bundler + test runner; `Bun.Terminal` needs ≥ 1.3.5).
- POSIX (Linux/macOS) — `Bun.Terminal` is POSIX-only.

## Install

```sh
bun install
```

## Configure

```sh
cp .env.example .env
# edit .env — at minimum set IAGENT_TOKEN (and VITE_IAGENT_TOKEN to match) before exposing.
```

## Develop

Run the two dev servers in separate terminals:

```sh
bun run dev:server   # Bun.serve on http://127.0.0.1:4517 (REST + /ws/:id), --watch
bun run dev:client   # Vite on http://localhost:5173, proxies /api and /ws -> 4517
```

Then open http://localhost:5173.

## Ports

| Port | What |
| ---- | ---- |
| 4517 | Server: REST (`/api/sessions…`) + data WebSocket (`/ws/:sessionId`) |
| 5173 | Client: Vite dev server (proxies `/api` and `/ws` to 4517) |

## Build

```sh
bun run build        # vite build of the client into packages/client/dist
```

## Typecheck

```sh
bun run typecheck    # tsc --noEmit (shared/server) + svelte-check (client)
```

## Test

```sh
bun test
```
