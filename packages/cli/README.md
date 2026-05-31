# @isomoes/iagent

A web UI that hosts a terminal coding agent (Claude Code / Codex CLI) — run it with one
command. The agent's TTY lives on the server (`Bun.Terminal`), its renderer lives in your
browser (`@xterm/xterm` + WebGL), and a WebSocket is the wire. This package bundles the
server **and** the pre-built UI into a single process that serves everything from one origin.

## Run it

```sh
npx @isomoes/iagent      # or: bunx @isomoes/iagent
```

Then open <http://127.0.0.1:4517>.

## Requirements

- **Bun ≥ 1.3.5** on your `PATH` — iagent is Bun-native (`Bun.Terminal` is POSIX-only, so
  Linux/macOS), and the bin runs under Bun even when launched with `npx` (its shebang is
  `#!/usr/bin/env bun`). No Bun yet? `npm i -g bun`, or see <https://bun.sh>.
- The agent CLI it spawns — by default `claude` (Claude Code). Override with `IAGENT_AGENT_CMD`.

## Configuration

All via environment variables (all optional):

| Env | Default | What |
| --- | --- | --- |
| `PORT` | `4517` | Port for the UI + REST + WS (one origin) |
| `HOST` | `127.0.0.1` | Bind address — localhost only; there is no auth (anything that reaches the port already has local RCE) |
| `IAGENT_AGENT_CMD` | `claude` | Agent command spawned in the PTY |
| `IAGENT_AGENT_ARGS` | – | Comma-separated agent args (e.g. `--dangerously-skip-permissions`) |
| `IAGENT_AGENT_CWD` | server cwd | Directory the agent starts in |

Example:

```sh
PORT=8080 IAGENT_AGENT_CMD=codex npx @isomoes/iagent
```

## Security

The server binds to **localhost only** and ships **no auth token** — by design it is
effectively RCE-as-a-service, so anything that can reach the port is assumed to already be
local. Do not expose it to a network you don't trust.

## How it works

`@isomoes/iagent` is a single Bun-target bundle of the iagent server + shared wire protocol,
with the Vite-built client baked in and served from the server's own origin. It therefore has
**zero runtime dependencies** — only Bun itself.

## Links

- Source & development docs: <https://github.com/isomoes/iagent>
- Architecture overview: <https://github.com/isomoes/iagent/blob/main/docs/ARCH.md>
