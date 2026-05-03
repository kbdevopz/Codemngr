# Codemngr — Multi-Account Coding-Agent GUI

> **Status**: Planning + initial fork. Source code in this branch is T3 Code (forked 2026-05-03) plus a small rebrand commit. Implementation work has not started.
>
> **Branch**: `claude/codemngr-multi-account-setup-msneX`
> **Origin**: `https://github.com/kbdevopz/codemngr`
> **Upstream**: `https://github.com/pingdotgg/t3code` (T3 Code — fork base)
> **Inspiration (not vendored)**: `https://github.com/MikeVeerman/jean-claude` (multi-account CLI)

---

## 1. Goal

Build a desktop GUI at **codemngr.com** that does what T3 Code does (multi-pane GUI for coding agents — Claude Code, Codex/OpenAI, OpenCode, Cursor) **plus first-class multi-account support**. The user has separate AI subscriptions billed to different parties:

- **Cogwheel.tech** (employer)
- **PremierStudio.ai** (second employer)
- **Midwest Machinery** (client)
- **Personal** (side projects)

Mixing them across projects is a billing/compliance/trust-boundary problem. Codemngr makes "this project uses *that* account" the core abstraction — every session in a project automatically uses the right credentials, with multiple accounts running **simultaneously** in different panes.

Differentiator vs. T3 Code: explicit multi-account UI and lifecycle. Differentiator vs. Jean Claude: GUI, multi-provider (Claude + OpenAI to start), shared-settings model, and detection of existing logins.

---

## 2. Key Findings From Reference Research

The pre-implementation research (cloned both repos, deep-dived their code) produced two findings that materially shrink the scope of this fork.

### 2.1 T3 Code already has multi-account architecture — it's just not exposed in the UI

T3 Code's provider layer was built around a `ProviderInstance` abstraction, not "the singleton Claude account." The architecture supports any number of instances per driver, each with its own config directory. Currently the settings hydration only synthesizes one instance per driver from legacy `providers.<kind>` config blobs (backward compat), but the registry, drivers, and runtime all handle multi-instance natively.

**Evidence (file:line):**
- `packages/contracts/src/providerInstance.ts:114-138` — `ProviderInstance` carries its own `homePath` / `shadowHomePath` per instance
- `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts:71-102` — current single-instance synthesis (the place that needs to change to enable multi-account UI)
- `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts:100-196` — registry materialization, fully multi-instance
- `apps/server/src/provider/ProviderDriver.ts:117-155` — unified driver interface

**Implication**: We do **not** rip out and rebuild T3's provider layer. We surface the multi-instance capability in the UI and add an "Add Account" lifecycle flow.

### 2.2 Jean Claude doesn't actually use symlinks for account swapping

Common assumption (and my own initial assumption): Jean Claude swaps `~/.claude` via symlinks. **Wrong.** It uses the `CLAUDE_CONFIG_DIR` environment variable — exactly the same mechanism T3 Code's `ClaudeProvider` uses internally. Each profile is a separate directory (`~/.claude-work`, `~/.claude-personal`); a shell alias sets `CLAUDE_CONFIG_DIR` per-profile.

**Evidence (file:line):**
- `src/lib/profiles.ts:187-189`:
  ```ts
  export function getShellAliasLine(profile: Profile): string {
    return `alias ${profile.alias}='CLAUDE_CONFIG_DIR="${profile.configDir}" claude'`;
  }
  ```

Jean Claude *does* use symlinks, but only **inside** profile dirs to share `settings.json`, `hooks/`, `agents/`, `skills/`, `plugins/`, `keybindings.json` between profiles — so config travels but credentials don't. That's a useful pattern we can adopt.

**Implication**: The two reference projects converge on the same mechanism. We pick `CLAUDE_CONFIG_DIR` (and `CODEX_HOME` for Codex) per process spawn — multiple accounts can run at the same time, no swap required.

### 2.3 How T3 Code detects existing accounts on launch

This was the user's specific question. Per-provider:

| Provider | Detection method |
|---|---|
| **Claude** | (1) Probe `claude --version` (binary check). (2) If installed, spawn a Claude Agent SDK session that reads `init.account` → returns email, subscriptionType, tokenSource. Cached per `(binaryPath, homePath)`. Code: `apps/server/src/provider/Layers/ClaudeProvider.ts:445-625`, `apps/server/src/provider/Drivers/ClaudeHome.ts:8-27`. |
| **Codex (OpenAI)** | Spawn `codex app-server` subprocess with `CODEX_HOME` env set, request `account/read` over IPC → returns account type (`apiKey` vs `chatgpt`), email, planType. Code: `apps/server/src/provider/Layers/CodexProvider.ts:245-495`. |
| **Cursor** | ACP protocol session, async background probe. |
| **OpenCode** | Spawns `opencode` server, HTTP probe; 401/403 → unauthenticated. |

The mechanism is **per-instance**, so once we expose multi-instance config in the settings, detection works per-account out of the box.

---

## 3. Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Fork base | T3 Code | Modern Effect-based monorepo; already multi-instance under the hood; Tauri/Electron desktop already wired up; supports Claude + Codex + Cursor + OpenCode out of the box. |
| Multi-account mechanism | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` per process | Allows parallel sessions. Same approach Jean Claude landed on independently. Better than symlink swap (single-active limitation). |
| Account directory layout | `~/.codemngr/accounts/<provider>/<name>/` | Namespace by provider so we don't collide with anything in `~/.claude` / `~/.codex`. Each account is a self-contained config home. |
| Existing-account detection | Reuse T3's per-instance probe; on first launch scan default homes (`~/.claude`, `~/.codex`) and offer to import as the first account. | T3 already has the probe. We just call it against multiple homes. |
| Adding a new account | UI button → create new `homePath` dir → spawn `claude /login` (or `codex login`) in subprocess scoped to that dir → register as new `ProviderInstance`. | Minimal new code. Reuses Claude's / Codex's own login flow. |
| Shared settings between accounts | Optional Jean-Claude-style symlinks for `settings.json`, `hooks/`, `agents/` etc. between profile dirs. | Lets users share configuration without sharing credentials. |
| Cross-PC sync (v2) | Sync only the metadata (account names, labels, project→account assignments, optional shared settings) via codemngr.com backend. Never sync OAuth tokens. | OAuth tokens are device/session-bound; syncing them is a security and reliability footgun. List of accounts syncs; user logs in once per machine. |
| Delivery | Desktop app (Tauri or Electron — T3 already has `apps/desktop`); codemngr.com is the marketing/download site. | Filesystem and CLI subprocess access required; pure web won't work. |
| First-class providers | Claude (Anthropic) + Codex (OpenAI). Cursor and OpenCode inherited from T3 but not the focus. | User scoped down to those two on day one. |

---

## 4. Plan Of Work

### Phase 0 — Done
- [x] Clone T3 Code and Jean Claude as references
- [x] Deep-dive both architectures (this document captures findings)
- [x] Fork T3 Code into this repo with proper attribution
- [x] Set `upstream` remote to `pingdotgg/t3code` for future merges
- [x] Rebrand root package → `@codemngr/monorepo`, README rewritten, `reference/` gitignored
- [x] `bun install --ignore-scripts` succeeds (Effect's `effect-language-service patch` step OOMs in the cloud env but is unrelated to the fork; will run fine on a workstation with Node 24.13.1)

### Phase 1 — Get the fork building & running locally on the MacBook
1. Bootstrap the remote (first push from MacBook — see Section 5).
2. Install Node 24.13.1 and Bun 1.3.9 via mise (`.mise.toml` already pinned).
3. `bun install` (this time with scripts — the patch step needs a real workstation).
4. `bun run dev` → confirm T3's existing UI launches and detects whatever Claude/Codex login is on the machine.
5. Smoke-test: open a project, run a Claude session in one pane, confirm the account it picks up matches `~/.claude`.

### Phase 2 — Multi-account: surface what's already there
**Goal**: Let the user create and switch between multiple Claude accounts via the UI without writing any new provider code.

1. **Settings model**: extend the user-facing settings UI so each provider can list multiple instances. The schema (`ProviderInstanceConfigMap`) already supports this — change `ProviderInstanceRegistryHydration.ts` to stop synthesizing a single legacy entry when multiple are configured.
2. **Account list UI**: per provider, show all configured instances with their detected account info (email, subscription type) from the existing snapshot. Probably a new sidebar / settings tab.
3. **"Add Account" flow** (Claude first):
   - Prompt for a label (e.g. "Cogwheel", "Personal").
   - Create `~/.codemngr/accounts/claude/<slug>/`.
   - Add a new `providerInstances.claude.<slug>` entry with `homePath` set.
   - Spawn `claude /login` in a subprocess with `CLAUDE_CONFIG_DIR` set to that dir.
   - On success, refresh the snapshot — new account appears in the list.
4. **Same flow for Codex** with `CODEX_HOME` and `codex login`.
5. **Project → account binding**: each project's settings carries `{ provider, instanceId }`. When spawning a session for that project, pass `instanceId` to the provider service so it picks the right `ProviderInstance`.

### Phase 3 — Detection of existing accounts (first-run import)
1. On first launch, scan `~/.claude`, `~/.codex`, `~/.config/anthropic`, `~/.config/openai` — wherever Claude Code / Codex CLI store credentials.
2. For each one found, run T3's existing probe to get the account email/sub.
3. Show an import dialog: "We found these existing logins. Import as accounts?"
4. Importing copies (or symlinks — TBD) the existing dir into `~/.codemngr/accounts/<provider>/<auto-named>/`.

### Phase 4 — Shared settings (Jean Claude pattern)
1. UI to mark certain files (`settings.json`, `hooks/`, `agents/`) as "shared across these accounts."
2. Implementation: a "main" settings dir at `~/.codemngr/shared/`; per-account dirs symlink the shared items in.
3. Per-account override: user can promote a symlinked file to a real file (breaking the link for that account only).

### Phase 5 — Cross-PC sync (separate workstream)
1. codemngr.com backend (probably an Effect-based RPC server, mirroring T3's stack) for syncing metadata only.
2. Encryption: account metadata + project assignments encrypted with a user passphrase before upload.
3. Per-machine: still log in to each account once. The *list* of accounts to log into syncs.
4. OpenAI API keys (not OAuth) can optionally sync via the same encrypted vault.

### Phase 6 — Polish, branding, distribution
1. Rename remaining `@t3tools/*` workspace packages → `@codemngr/*` (mass rename; left to last to keep upstream merges easy until needed).
2. Replace T3 branding in the UI (logo, name, color scheme).
3. Marketing site at codemngr.com — fork or rebuild `apps/marketing/`.
4. Codesigning + distribution (Homebrew cask, winget, AppImage). T3 already has `dist:desktop:*` scripts in `package.json`.

---

## 5. Setting Up On The MacBook

The cloud environment can clone but cannot `git push` (no GitHub credentials wired up to the egress proxy). All actual development happens on the Mac. **Bootstrap script below** seeds `kbdevopz/codemngr` on GitHub with T3's full history + this PLAN.md + the rebrand commit, on the right branch, in one go.

### 5.1 One-shot bootstrap (run on Mac)

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Clone T3 Code (we're forking its full history)
git clone https://github.com/pingdotgg/t3code.git codemngr
cd codemngr

# 2. Re-wire remotes: origin -> our repo, upstream -> T3
git remote rename origin upstream
git remote add origin https://github.com/kbdevopz/codemngr.git

# 3. Branch off T3's main
git checkout -b claude/codemngr-multi-account-setup-msneX

# 4. Apply the rebrand (3 file changes)
#    Update root package.json name
sed -i '' 's|"name": "@t3tools/monorepo"|"name": "@codemngr/monorepo"|' package.json

#    Add reference/ to .gitignore
cat >> .gitignore <<'EOF'

# Upstream reference clones (T3 Code, Jean Claude) - kept locally for inspection, not tracked
reference/
EOF

#    Replace README
cat > README.md <<'EOF'
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
mise install   # installs pinned Node 24 + Bun 1.3.9
bun install
bun run dev
```

## Attribution

Codemngr is a fork of T3 Code by [T3 Tools Inc.](https://github.com/pingdotgg/t3code), used under the MIT License. The upstream is tracked as the `upstream` git remote so improvements can be merged in. See [LICENSE](./LICENSE) for the original copyright.

Multi-account design takes inspiration from Jean Claude by Mike Veerman, also MIT-licensed. Codemngr does not vendor Jean Claude's code; it adapts the `CLAUDE_CONFIG_DIR`-per-profile pattern within T3 Code's existing `ProviderInstance` architecture.
EOF

# 5. Commit the rebrand
git add package.json .gitignore README.md
git commit -m "fork(codemngr): rebrand from T3 Code as multi-account fork

Forked from pingdotgg/t3code (MIT) to add multi-account/multi-subscription
management as the primary feature. T3 Code's existing ProviderInstance
architecture already supports per-instance homePath/CODEX_HOME, so the
fork's job is to surface multi-account in the UI rather than rebuild
the provider layer.

- Rename root package @t3tools/monorepo -> @codemngr/monorepo
- Rewrite README with codemngr framing + attribution to T3 Code and
  Jean Claude (the two upstream inspirations)
- gitignore reference/ (local clones of T3 Code and Jean Claude kept
  for inspection, not tracked)"

# 6. Add PLAN.md (this file). Easiest: download from the cloud session,
#    or re-paste the contents. After this script runs, you'll need to
#    `git add PLAN.md && git commit -m "docs: add PLAN.md"`.

# 7. Push everything
git push -u origin claude/codemngr-multi-account-setup-msneX

# 8. Set up dev environment
mise install || echo "Install mise from https://mise.jdx.dev if you don't have it"
bun install

# 9. Smoke-test the dev server
bun run dev
```

### 5.2 After bootstrap

Once `kbdevopz/codemngr` has the branch with T3 + the rebrand + PLAN.md:

- Future Claude Code sessions (in the cloud or on your Mac) can clone and continue.
- `git fetch upstream && git merge upstream/main` pulls in T3 improvements.
- Phase 1 work begins on the Mac with `bun run dev`.

---

## 6. Open Questions

Things to decide before / during Phase 2:

1. **Account directory naming**: `~/.codemngr/accounts/claude/<name>/` vs `~/.codemngr/accounts/<name>/<provider>/` vs flat `~/.codemngr/<provider>-<name>/`? Leaning first option — provider as namespace.
2. **Shared-settings UX**: opt-in per-file (Jean Claude style) or opt-in per-account (clone-from-template)? Probably per-file, but mark a default template.
3. **OpenAI accounts**: API key vs ChatGPT login? T3's `CodexProvider` already handles both; user-side we just need to support both flows in "Add Account."
4. **Detection scope**: only scan default paths, or recursively look for any `.credentials.json` / `auth.json` files? Probably default paths only — minimize false positives.
5. **Project → account binding storage**: where? T3 stores project config in `.t3/` per-project. Option to keep that pattern (`.codemngr/account.json` in each project) vs central registry. Per-project is more portable but per-central is easier to manage.
6. **Domain**: is `codemngr.com` registered? Confirmed yes by user. Renewal auto? (Out-of-scope for code, but flagged.)
7. **License going forward**: keep MIT (T3's license)? That's the default and lowest-friction. Could go AGPL later if we want stronger copyleft, but MIT is fine for now.
8. **Branding identity**: Codemngr is a working name. Any alternative under consideration? (Leaving as-is unless the user raises it.)

---

## 7. Conversation Log (For Reference)

This is the verbatim Q&A that produced this plan. Useful when picking the work back up.

### 7.1 Initial brief (user)

> I want to build a project called codemngr.com — I own the domain — where I'm forking T3 Code's open source project for its UI and functionality `https://github.com/pingdotgg/t3code`, then `https://github.com/MikeVeerman/jean-claude` for it's functionality. What I want is to not only manage agents in a way like `https://www.conductor.build/` for example, but to have a nice UI like T3 Code, and then Jean Claude lets me manage multiple accounts. But unlike Jean Claude, I want to have all my AI subs inside of T3 type Code UI, but also multiple accounts! Because I have work accounts, personal accounts, and client accounts that all use different AI subs. For example, my work at Cogwheel.tech has a sub billed to Cogwheel, my work at PremierStudio.ai has a sub billed to Premier, my work at Midwest Machinery has a sub billed to them, then I have some for my own personal projects. I don't want to use a personal sub for work stuff, or a work stuff for work at some other place, etc. So I need a way to manage/merge them all.

### 7.2 Clarification round 1 (user)

> 1. The goal is to let them use their existing subs like T3 does. It even detects ones they already have on their machine, but it seems to lack the option to connect a new one. We can start with just Claude and OpenAI.
> 2. We don't want to pay for compute. Want it more like T3 — Electron or otherwise — because you'll need filesystem access. Our spin on it is multi-account support and using some of what Jean Claude does to keep it organized.
> 3. Not sure if the symlink approach like Jean Claude is best. Multi-PC support would be nice — people likely have a work computer and personal one.

### 7.3 Reference clone & deep dive

Cloned both repos into `reference/`. Two delegated explore agents produced the findings summarized in Section 2. The detection mechanism per provider, the multi-instance architecture in T3 Code, and the actual (env-var-not-symlink) account-swap mechanism in Jean Claude all came out of those explores.

### 7.4 Approach decision (user)

> Let's start by doing both repo clones — we can get a better idea. I'm particularly interested in how T3 automatically detected all the accounts I was logged into.

→ produced findings in Section 2.3.

### 7.5 Fork decision (user)

> I'm fine with a or b — whichever one you think is best.

→ chose option (a): fork T3 Code now. Findings already gave enough architectural clarity that further file-mapping in the abstract was premature.

### 7.6 Push blocker → plan-doc decision (user)

> Okay how about this — we just put together a robust plan with our conversation history all included along with the plan on what we're doing, and I'll clone this repo on a local machine since working on the cloud — then I have actual hardware to work with right? I can do it from my MacBook.

→ this document.

---

## 8. Quick Reference

| Thing | Where |
|---|---|
| T3 Code provider drivers | `apps/server/src/provider/Drivers/` |
| T3 Code provider layer (the multi-instance core) | `apps/server/src/provider/Layers/` |
| Provider contracts (the interface to extend) | `packages/contracts/src/provider*.ts` |
| Multi-instance hydration (where to enable multi-account UI) | `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts:71-102` |
| Claude detection logic | `apps/server/src/provider/Layers/ClaudeProvider.ts:445-625` |
| Codex detection logic | `apps/server/src/provider/Layers/CodexProvider.ts:245-495` |
| Desktop shell (Electron) | `apps/desktop/` |
| Web UI | `apps/web/` |
| Marketing (becomes codemngr.com) | `apps/marketing/` |
| Reference clone — T3 Code | `reference/t3code/` (gitignored) |
| Reference clone — Jean Claude | `reference/jean-claude/` (gitignored) |
| Tooling pins | `.mise.toml` (Node 24.13.1, Bun 1.3.9) |
