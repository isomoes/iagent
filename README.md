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
# edit .env — all values have sane defaults. The server binds to localhost only.
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

## Browser Vim extensions (Surfingkeys / Vimium)

iagent shares one keyboard between the terminal and a page-level Vim extension. The model:

- **Focused ⇒ the terminal owns every key, `Esc` included** (the agent needs `Esc` to interrupt/dismiss).
- **`Tab` leaves** the terminal (handed back to the extension); `Shift+Tab` stays with the agent.
- **`f` / `i` / `Tab` return** focus to the terminal (the snippet remaps `i` to a one-tap focus).

Two Surfingkeys quirks need a one-time `~/.surfingkeys.js` for the iagent origin — both rooted in
xterm's input being a hidden, off-screen `<textarea>`:

1. **New sessions weren't typable until you pressed `i`.** Surfingkeys' anti-focus-hijack heuristic
   blurs a *newly-created, off-screen* input on the first keystroke (`normal.js`) — and xterm's
   textarea is exactly that. Fix: enter insert mode when it focuses.
2. **`Esc` was being eaten** (insert mode binds `Esc`→exit). Fix: `iunmap` it on this origin so `Esc`
   reaches the agent.

```js
// ~/.surfingkeys.js
const { mapkey, iunmap } = api;
const onIagent = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

// (2) Esc belongs to the agent. iunmap only touches INSERT mode — which is
//     active only while an editable (here, the terminal) is focused — so Esc
//     still works normally in Surfingkeys when the terminal is blurred.
iunmap('<Esc>', onIagent);

// (1) Auto-enter insert mode when xterm's textarea focuses, so a freshly created
//     session is typable immediately. The synthetic mousedown trips Surfingkeys'
//     insert.enter() (normal.js mousedown handler) WITHOUT the first-keystroke blur.
document.addEventListener('focusin', (e) => {
  if (onIagent.test(location.href) &&
      e.target?.classList?.contains('xterm-helper-textarea')) {
    e.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }
}, true);

// (3) Re-entry in ONE tap. The DEFAULT `i` is a hints command (press `i`, THEN a
//     hint key — two taps). On this origin the terminal is the only edit box, so
//     override `i` to focus it directly (-> .terminal-host's focus handler ->
//     term.focus() -> (1) enters insert mode). Tab leaves; `i` brings you back.
mapkey('i', 'iagent: focus terminal', () => {
  document.querySelector('.terminal-host')?.focus();
}, { domain: onIagent });
```

> Verified against the Surfingkeys source (`normal.js` stealFocus heuristic + mousedown→`insert.enter`,
> `insert.js` `<Esc>` binding, `api.js` `mapkey`/`iunmap` signatures). Confirm against your installed
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
