# Changelog

All notable changes to this project are recorded here.

Format per entry: `<type>: <commit message> (@who) <hash>`
Entries are grouped by package version.

## 0.1.2

- ci: Cut the GitHub Release only after a successful publish (@isomoes) 9925a83
- fix: Fix publish workflow; stamp cli version with `npm pkg set` (@isomoes) 914882f

## 0.1.1

- docs: Add @isomoes/iagent package README for the npm page (@isomoes) cf4bd04
- chore: Pin @isomoes/iagent publish registry to npmjs.org (@isomoes) 6a30ffe
- feat: Publish @isomoes/iagent as an npx-runnable CLI (@isomoes) b300ef7
- docs: Add CHANGELOG.md grouped by package version (0.1.0) (@isomoes) afc9a47

## 0.1.0

- feat: Add concurrent `bun run dev` for server + client (@isomoes) e5c8d10
- chore: Move arch.md to docs folder (@isomoes) 437e059
- feat: Tab-leave moves focus to a non-editable element for Surfingkeys (@isomoes) c753ad3
- feat: Scroll terminal scrollback with Shift/Ctrl+Up/Down (@isomoes) 5a76eef
- feat: Share keyboard with page-level Vim extensions; Tab leaves, host re-entry (@isomoes) 963cf97
- fix: Default to DOM renderer; canvas poisoning blacked out glyphs (@isomoes) cb87c30
- fix: Fix terminal remount storm on session (re)attach (@isomoes) 49b9b47
- security: Drop auth token for localhost-only model; size PTYs to viewport (@isomoes) c2532dc
- feat: Implement iagent MVP — Stage 1 pure passthrough (@isomoes) e587990
- docs: Add architecture overview (@isomoes) ee97a3b
