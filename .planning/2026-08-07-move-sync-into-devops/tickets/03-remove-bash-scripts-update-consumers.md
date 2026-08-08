type: task
closed: 2026-08-07

## Question

Remove the three bash scripts and update every former consumer (from ticket 01) to the new `sync_repo` tool:
- Delete `scripts/sync-repo.sh`, `scripts/git-remote-main-sync.sh`, `scripts/safe-sync.sh`.
- Update each consumer found in ticket 01 (e.g. `setup.sh`, `docs/agents/learnings.md` `[convention]` entry, any README/CONTEXT, shell configs if `safe-sync` was sourced) to reference the `sync_repo` devops tool instead.
- Verify no remaining references to the deleted scripts (grep the tree).
- Run `local_ci`/typecheck/tests green.

blocked by: 01 (consumer map — must know every caller before removing), 02 (the replacement tool must exist and be verified)

### Concrete consumer list (from ticket 01)

- `docs/agents/learnings.md` `[convention]` entry (~lines 48-53) → rewrite the table rows to reference the `sync_repo` devops tool.
- `scripts/sync-repo.test.ts` → delete (or it was ported in ticket 02).
- `scripts/safe-sync.sh` → delete (wrapper, not sourced anywhere).
- External (NOT in this repo — skip in the PR): `vaults_root/pi-agent-vault/Zettelkasten/knowledge-graph/*` knowledge cards.
- Final sweep: `rg 'sync-repo\.sh|git-remote-main-sync\.sh|safe-sync'` (exclude node_modules) must return nothing in-repo.

## Resolution

Closed 2026-08-07. PR [#1070](https://github.com/ziyu4huang/video_generation/pull/1070) merged (`61321205`): deleted `scripts/sync-repo.sh`, `scripts/git-remote-main-sync.sh`, `scripts/safe-sync.sh`, `scripts/sync-repo.test.ts`; rewrote `docs/agents/learnings.md` `[convention]` rows → `sync_repo` modes (full/rebase/pull); sharpened the `[tool-quirk]` commitScope entry with the PR #1068/#1069 root-cause cross-check; also dropped a stale `sync-repo.test.ts` ref in `scripts/ci-changed-packages.test.ts`. rg sweep clean (only "port of" descriptive comments + out-of-repo vault cards remain). 6 files (4 deletions, 2 modifications). Tests green.
