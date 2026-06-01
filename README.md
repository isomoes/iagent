# iagent

A web UI that hosts a terminal coding agent (Claude Code / Codex CLI). The agent's TTY lives
on the server (`Bun.Terminal`), its renderer lives in the browser (`@xterm/xterm` + WebGL), and a
WebSocket is the wire. See [`ARCH.md`](./ARCH.md) for the full architecture.

<img width="3814" height="2144" alt="iagent UI" src="https://github.com/user-attachments/assets/68fe4a0a-782a-471e-bb4a-c26f825e15b8" />

📺 Demo videos: [0.1.3](https://www.bilibili.com/video/BV1oKVd6XE3s/)

## Run it

The published CLI bundles the server **and** the pre-built UI into one process that
serves everything from a single origin:

```sh
npx @isomoes/iagent      # or: bunx @isomoes/iagent
```

Then open <http://127.0.0.1:4517>.

Requirements:

- **Bun ≥ 1.3.5** on your `PATH` — iagent is Bun-native (`Bun.Terminal` is POSIX-only),
  so the bin runs under Bun even when launched with `npx` (via its `#!/usr/bin/env bun`
  shebang). No Bun yet? `npm i -g bun`, or see [bun.sh](https://bun.sh).
- The agent CLI it spawns — by default `claude` (Claude Code). Override with `IAGENT_AGENT_CMD`.

All config is env vars (all optional):

| Env | Default | What |
| --- | --- | --- |
| `PORT` | `4517` | Port for the UI + REST + WS (one origin) |
| `HOST` | `127.0.0.1` | Bind address — localhost only; no auth (anything that reaches the port already has local RCE) |
| `IAGENT_AGENT_CMD` | `claude` | Agent command spawned in the PTY |
| `IAGENT_AGENT_ARGS` | – | Comma-separated agent args (e.g. `--dangerously-skip-permissions`) |
| `IAGENT_AGENT_CWD` | server cwd | Directory the agent starts in |

e.g. `PORT=8080 IAGENT_AGENT_CMD=codex npx @isomoes/iagent`.

## Layout

A Bun-workspaces monorepo:

| Package           | Role          |
| ----------------- | ------------- |
| `@iagent/shared`  | Wire protocol + REST DTOs + config, consumed as raw TS by both sides |
| `@iagent/server`  | PTY host + WebSocket gateway (`Bun.serve`, `Bun.Terminal`) |
| `@iagent/client`  | Browser UI (Vite + Svelte 5 + xterm.js) |
| `@isomoes/iagent` (`packages/cli`) | Publishable CLI — bundles the server + built client into one `npx`-able command |

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
# edit .env — all values have sane defaults. The server binds to localhost only.
```

## Develop

Run both dev servers concurrently with a single command:

```sh
bun run dev          # starts server + client together (interleaved output)
```

Or run them individually in separate terminals:

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

## Browser Vim extensions (Surfingkeys / Vimium)

iagent shares one keyboard between the terminal and a page-level Vim extension. The model:

- **Focused ⇒ the terminal owns every key, `Esc` included** (the agent needs `Esc` to interrupt/dismiss).
- **`Tab` toggles focus.** When the terminal is focused, `Tab` hands the keyboard back to the
  extension; when it's blurred, `Tab` returns focus to the terminal. `Shift+Tab` stays with the agent.
- **New sessions start blurred** — no auto-focus; `Tab` (or a click / `f` hint) enters the terminal.

Two Surfingkeys quirks need a one-time `~/.surfingkeys.js` for the iagent origin — both rooted in
xterm's input being a hidden, off-screen `<textarea>`:

1. **`Esc` was being eaten** (insert mode binds `Esc`→exit). Fix: `iunmap` it on this origin so `Esc`
   reaches the agent.

```js
// ~/.surfingkeys.js
const { iunmap } = api;
const onIagent = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

// (1) Esc belongs to the agent. iunmap only touches INSERT mode — which is
//     active only while an editable (here, the terminal) is focused — so Esc
//     still works normally in Surfingkeys when the terminal is blurred.
iunmap('<Esc>', onIagent);

```

> Re-entry is plain `Tab`: the visible `.terminal-host[role=textbox]` (`tabindex=0`) is the next tab
> stop after the leave-target, so `Tab` lands on it and its focus handler calls `term.focus()`. No
> if you reach for it, but `Tab` is the intended toggle.

> Verified against the Surfingkeys source (`normal.js` stealFocus heuristic + mousedown→`insert.enter`,
> `insert.js` `<Esc>` binding, `api.js` `iunmap` signature). Confirm against your installed
> version — internals can shift between releases. See [`ARCH.md` §Focus & browser keyboard extensions](./ARCH.md).

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

## Releasing & publishing

One action drives everything: **push a `vX.Y.Z` git tag.** Two independent workflows fire on
that tag:

| Workflow | Trigger | Does |
| -------- | ------- | ---- |
| [`release.yml`](./.github/workflows/release.yml) | tag `v*` | Creates the **GitHub Release**, body = the matching `## X.Y.Z` section of [`CHANGELOG.md`](./CHANGELOG.md) (auto-generated notes if that section is missing) |
| [`publish.yml`](./.github/workflows/publish.yml) | tag `v*` | Stamps the version onto `packages/cli`, builds it, and **publishes to npm** via OIDC trusted publishing — no `NPM_TOKEN`, provenance attached automatically |

They run on the tag (not on the release event) on purpose: a Release created by `release.yml`
with the default `GITHUB_TOKEN` would not re-trigger a `release:`-keyed workflow, so keying
publish off the tag keeps the chain working without a long-lived PAT.

The build ([`packages/cli/build.ts`](./packages/cli/build.ts)) bundles `@iagent/server` +
`@iagent/shared` into a single Bun-target `dist/iagent.js` (prefixed with the
`#!/usr/bin/env bun` shebang) and copies the Vite client build into `dist/public`. The
published package therefore has **zero runtime dependencies** — only Bun itself.

Cut a release:

1. Add a `## X.Y.Z` section to [`CHANGELOG.md`](./CHANGELOG.md) (it becomes the release body).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.

Inspect the artifact locally first:

```sh
bun run --filter '@isomoes/iagent' build   # -> packages/cli/dist
cd packages/cli && npm pack --dry-run       # exactly what would be published
```

**One-time npm setup** (Package → Settings → Trusted publishing on npmjs.com, after the
first manual `npm publish` so the package exists to configure):

- Repository: `isomoes/iagent`
- Workflow: `.github/workflows/publish.yml`
- Environment: _(leave blank)_
