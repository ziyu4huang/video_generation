type: research
claimed: charting-research-pass
closed: 2026-08-07

## Question

Map every consumer of the three repo-sync shell scripts so their removal is safe and every caller gets updated:
- `scripts/sync-repo.sh`
- `scripts/git-remote-main-sync.sh`
- `scripts/safe-sync.sh`

For EACH script, find and report every caller/reference across: `scripts/` (setup.sh, setup-offline.sh, repo-deps, any .sh) and any `bash scripts/...` invocation; `.github/workflows/` (CI is disabled — `ci.yml.disabled` — but check for references); `docs/` (incl. `docs/agents/learnings.md` `[convention]` entry, READMEs, CONTEXT.md files); `bun-apps/*/` (package.json scripts, any TS/JS spawning them); `CLAUDE.md` / `AGENTS.md` / root docs; shell configs `~/.zshrc`, `~/.bashrc`, `~/.profile` (is `safe-sync` sourced? aliases?); and any other repo file (grep the whole tree, excluding node_modules).

Output: a consumer map — for each script, the list of callers with file:line, a one-line note on what the caller does, and a removal-impact verdict (safe to remove / must update caller / blocks removal). Also flag which script FLAGS/behaviors appear actually unused (informs the parity scope of ticket 02).

## Resolution

**Closed 2026-08-07 (charting research pass).** Verdict: **removing all three scripts is SAFE** — zero active code consumers.

- **No code consumers**: no `scripts/*.sh`, no `package.json` scripts, no TS/JS `spawn`/`execSync`, no `.github/workflows`, no Python callers reference any of the three.
- **`safe-sync` is NOT sourced** in `~/.zshrc`/`~/.bashrc`/`~/.profile`/`~/.config/zsh/*` → no manual/interactive workflow to preserve (the "agent tool only" choice is clean — nothing breaks).
- **Doc consumer (must update in ticket 03)**: `docs/agents/learnings.md` `[convention]` entry (~lines 48-53) references all three.
- **Test consumer**: `scripts/sync-repo.test.ts` tests the bash script → port to test the TS tool, or delete (ticket 02/03).
- **`safe-sync.sh`** is a wrapper around `sync-repo.sh` (internal — goes away with the scripts).
- **External (out of repo scope)**: `vaults_root/pi-agent-vault/Zettelkasten/knowledge-graph/*` knowledge cards reference `sync-repo.sh --full` — personal vault, optional update, not a repo PR concern.

**Flags to KEEP in the TS port (actually used)**: `--full`, `--pull`, `--rebase`, `--dry-run`, default-rebase mode, `--detect-default-branch` (internal).
**Flags safe to DROP (no consumer)**: `sync-repo.sh` `--remote` / `--branch` / `--no-submodules` / `--depth`; `git-remote-main-sync.sh` `--local` / `--merge` / `--remote` / `--base`.

→ Refines tickets 02 (flag scope) and 03 (concrete consumer list). No removal blockers.
