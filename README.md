# Codemngr

A multi-account desktop GUI for coding agents (Claude Code, Codex, more to come).

Codemngr lets you manage multiple AI subscriptions side-by-side — work, personal, and client accounts — without symlink swaps, manual logouts, or env-var juggling. Each pane runs against the right account, automatically.

## Why

Most coding-agent UIs assume one account per machine. In practice, people have:

- A work sub billed to their employer (e.g. Cogwheel.tech)
- A separate sub for a second job or contract (e.g. PremierStudio.ai)
- Per-client subs (e.g. Midwest Machinery)
- A personal sub for side projects

Mixing them is a billing, compliance, and trust-boundary problem. Codemngr makes account-per-project the default — you pick which subscription a project uses, and every session in that project uses it.

## Status

Early development. Forked from [T3 Code](https://github.com/pingdotgg/t3code) (MIT) on 2026-05-03, with multi-account architecture as the primary focus. Concepts on credential-directory layout and shared-settings symlinks are inspired by [Jean Claude](https://github.com/MikeVeerman/jean-claude) (MIT).

## Local development

```bash
# Optional: install pinned dev tools via mise
mise install

bun install
bun run dev
```

## Attribution

Codemngr is a fork of T3 Code by [T3 Tools Inc.](https://github.com/pingdotgg/t3code), used under the MIT License. The upstream is tracked as the `upstream` git remote so improvements can be merged in. See [LICENSE](./LICENSE) for the original copyright.

Multi-account design takes inspiration from Jean Claude by Mike Veerman, also MIT-licensed. Codemngr does not vendor Jean Claude's code; it adapts the `CLAUDE_CONFIG_DIR`-per-profile pattern within T3 Code's existing `ProviderInstance` architecture.
