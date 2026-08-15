# 06 — Build the autocommit hook

---
type: task
status: closed
claimed: wayfinder-session
built: 2026-08-01 (commits 6723c9e8 + 15b2b593 on video_generation__superpowers)
blocked by: 01 (Opt-in contract), 02 (Trigger event), 03 (Commit content & message),
04 (Abort conditions), 05 (Topology & conflict)
---

## Question

Implement the hook per the five design decisions (01–05): on the chosen lifecycle event, if
the effort opted in (01), stage **only** `.agents/memory/MEMORY.md` (03) and `git commit`
on the current branch (05), guarded by the abort set (04), with the batch rule from 02.

## What to build

- The hook lives in `pi-agent-ext-hermes-memory` (it owns the write path + already hooks the
  lifecycle events) — or a thin dedicated extension if coupling is undesirable.
- **Reuse, don't reinvent** the git helper in `pi-agent-ext-subagent/src/git-scope.ts` /
  `superpowers.ts`.
- Wire the concrete decisions: opt-in via repo-local `.agents/memory/config.json`
  `autoCommitProjectMemory` (01, narrow-overlay loadConfig); `message_end` + ~20s trailing
  debounce, changed-gate (02); stage `.agents/memory/MEMORY.md` only with fixed message
  `docs(memory): auto-update project memory` (03); the best-effort guard set from 04
  (skip+log / defer+re-arm / auto-track untracked, never `-A`); suppress on protected/main
  (05).
- **§-union merge driver (05):** ship a small driver script (split on `§`, union by trimmed
  content, dedup) + committed `.gitattributes` (`.agents/memory/MEMORY.md merge=pi-memory`);
  the hook self-configures `git config merge.pi-memory.driver` idempotently on first run
  (per-clone config isn't committed).
- **F3 (commit author/identity) — settle during build:** default to the current git user
  config (no special agent identity); revisit only if a bot-identity convention is wanted.
- `tsc` clean; no new deps unless justified.

## Acceptance

- [x] Hook registered on the event from 02; gated by the opt-in from 01.
- [x] Stages the explicit MEMORY.md path only (never `-A`); honors every abort condition
      from 04.
- [x] Commits on the current branch per 05; emits the message template from 03.
- [x] Seeds + self-configures the §-union merge driver (`.gitattributes` + git-config);
      suppresses commit on protected/main; commit-author identity settled (clears F3).
- [x] `tsc` clean; existing hermes-memory tests still pass; guard-conditions unit-tested.

## Resolution

**Built & independently verified (2026-08-01).** Built via an isolated TDD implementer
(tier medium, watchdog L2). The watchdog soft-gate returned no adversarial findings, so I
verified independently (evidence below). Two scoped commits on `video_generation__superpowers`:
`6723c9e8 feat(hermes-memory): autocommit project memory to git` +
`15b2b593 chore(memory): ship section-union merge driver gitattributes + opt-in sample`.

**Files (15, all in-scope; the effort dir was NOT swept into a commit):**
- New: `src/{merge-union.ts` (§-union pure fn), `commit-guards.ts` (pure guard-classifier
  → commit/skip/defer/suppress), `git-ops.ts` (never-throws GitOps + realGitOps + driver
  self-config helpers)}`, `src/handlers/commit-project-memory.ts` (`message_end` + ~20s
  trailing debounce → `runCommitCycle`; defer re-arms), `scripts/pi-memory-merge.mjs`
  (deps-free driver entry), `.agents/memory/{.gitattributes, config.sample.json}`
  (**this repo is NOT opted in** — capability shipped only).
- Changed: `src/{config.ts` (repo-local narrow overlay `applyRepoLocalProjectMemoryOverlay`,
  `loadConfig(configPath?, cwd?)`), `constants.ts` (message / 20_000ms debounce / `pi-memory`
  driver name), `types.ts` (`autoCommitProjectMemory?: boolean`), `index.ts` (overlay applied
  + `setupCommitProjectMemory` called, gated on in-repo project file)}`, `tests/config.test.ts`.
  New tests: `merge-union`, `commit-guards`, `handlers/commit-project-memory`.

**Verified independently (evidence, not the implementer's self-report):**
- `bun run --cwd bun-apps/pi-agent-ext-hermes-memory check` (`tsc --noEmit`) → exit 0.
- `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )` → **941 pass / 0 fail** (57 new:
  overlay 8 + §-union 10 + guard-classifier 19 + commit-path 12 + debounce 8).
- Contract spot-checks: never-throws enforced **3-layer** (`gitText`/`gitOk` try/catch →
  `runCommitCycle` try/catch → promise `.catch`); `stage = git add -- <path>` and
  `commit = git commit -m <msg> -- <path>` (**pathspec-limited** — a pre-staged unrelated
  file is NEVER swept in, exceeds spec); opt-in default `false` + the no-op gate runs
  BEFORE the `message_end` handler is registered (zero behavior change for non-opted-in
  repos); the overlay uses the same `resolveProjectStoreDir` as MEMORY.md (consistency);
  the merge-driver self-config is idempotent + best-effort (falls back to a normal merge).
- F3 resolved: the commit uses no `--author` → defaults to the current git user config.

**Concerns (from the implementer, assessed acceptable):**
1. consolidation-in-flight detection wires to the `PI_HERMES_CONSOLIDATING` env signal + an
   injectable predicate (consolidation runs in a child process, so the main process's env is
   the documented best-effort signal) — richer detection injectable later without rework.
2. `.gitattributes` shipped in this non-opted-in repo is neutral (git silently falls back to a
   normal merge until the driver is configured), exactly as ticket 05 specified.

**End-to-end durability is ticket 08 (acceptance test).** 06 = build + unit-verified; 08 =
prove the full write → debounce → commit → merge → next-session re-sync round-trip in a real
repo. After 08, the destination is reached (modulo a repo actually opting in to deploy).
