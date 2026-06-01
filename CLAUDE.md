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

## Code style

Keep comments sparse and high-value. Write code clear enough to read on its own; reserve comments for the non-obvious **why** — an invariant, a gotcha, a workaround, or a design decision the code can't express (the `SIGWINCH` workaround in `pty.ts` is the bar). Don't narrate what the code does or restate the next line in prose. When a comment only describes the code, delete it and make the code clearer instead.

## Testing notes

Tests live in `packages/server/test/*.test.ts` and alongside source as `packages/shared/src/*.test.ts`, using `bun:test`. `Session` and the WS path are tested with a **fake `Pty` and fake `SessionSocket`** injected via `SessionDeps` (`spawnPty`) — no real terminal spawns. When changing flow control or framing, exercise it through those fakes the same way `session-flow-control.test.ts` does.
