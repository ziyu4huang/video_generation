# Design — Migrate `docs/agents/` into `s2-agent-ext-devops` skills

Date: 2026-08-29
Status: approved (user, this session)
Scope: agent-facing operational docs; no behavior change; doc + comment + one diagnostic-string change.

## Problem

`docs/agents/` (6 files, 425 lines) is a folder agents only read when a doc
path is explicitly cited. Skills are this repo's agent-facing surface —
routed via the `using-s2-agent-skills` front-door gates, discovered by
`list-ext-skills.ts`, bundled by deploy. Content living in `docs/agents/`
is invisible to that machinery.

## Decisions

- **D1 — All six files become ext skills** under
  `bun-apps/s2-agent-ext-devops/skills/<name>/SKILL.md` (user choice over a
  mixed skills+docs split and over a plain package-docs move). Even the two
  non-procedural files (append-only log, data table) take skill shape so
  everything shares one discovery + routing path.
- **D2 — Delete + full sweep**: `docs/agents/` is removed; every in-repo
  reference is repointed in the same PR. Grep-clean is an acceptance gate.
  The `vaults_root/study-news` submodule's prose references are out of scope
  (separate repository; historical study notes).
- **D3 — Faithful migration**: bodies move byte-identical except (a) skill
  frontmatter added, (b) intra-folder cross-refs repointed, (c) repo-relative
  paths kept repo-relative. No content rewrite, no history editing —
  `learnings.md` stays a dated append-only log (old tool names in its dated
  entries are history, not errors).
- **D4 — No ADR**: trivially reversible (move files back); recorded here
  instead.

## Skill mapping

| Old file | New skill dir | Description (trigger-oriented) |
|---|---|---|
| `domain.md` | `skills/domain-docs/` | read before exploring domain docs / writing `CONTEXT.md` / citing `ADR-<context>-NNNN` |
| `extension-naming.md` | `skills/extension-naming/` | naming or renaming any tool/extension/skill — rename checklist + append-only history |
| `issue-tracker.md` | `skills/issue-tracker/` | GitHub issue/PRD ops via `gh`; wayfinder map/child/frontier ops; triage label↔role mapping |
| `learnings.md` | `skills/learnings/` | consult when hitting s2-agent toolchain quirks (commitScope false-positives, skill precedence, hand-rolled-git incidents) |
| `session-closeout-sop.md` | `skills/session-closeout-sop/` | hands-off close-out runbook; command-exact twin of `self-reflect-next-goal` (the authoritative spec), cross-linked both ways |
| `shared-state-index.md` | `skills/shared-state-index/` | before changing shared config/resolution consumed by >1 package — vault root, MLX models dir, venv, bun workspace, sibling forks |

Name-collision check (2026-08-29): 58 existing skill names, only
`domain-modeling` (wayfind) is near — `domain-docs` is distinct.

## Reference sweep (complete list — final, post-full-grep)

An md-only grep initially missed `.ts` comment refs; the final sweep grepped
all source extensions. Comment-only ref updates (all `extension-naming.md` →
the skill path) also landed in: `s2-agent-ext-subagent` ×7,
`s2-agent-ext-hermes-memory` ×4, `s2-agent/src/{registry-config,
static-extensions-gen,static-extensions}.ts` (codegen source + generated,
verified consistent via `regen:static`), `s2-agent-ext-tool-gate` ×2,
`perf-harness` ×1.

Originally listed:
- root `CLAUDE.md` ×4 (extension-naming history line, Issues bullet, Session
  close-out bullet, Domain docs bullet)
- `.claude/skills/using-s2-agent-skills/SKILL.md` — route-first gate table
  gains rows for the six skills (this is the piece that actually reroutes
  agent behavior away from `docs/agents/`)
- `bun-apps/s2-agent-ext-devops/src/oneshot-smoke.ts` ×2 (doc comment +
  `BOOT_HANG_DIAGNOSTIC` string) + `tests/oneshot-smoke.test.ts` ×1
  (assertion updated in lockstep — test-pinned string)
- `bun-apps/s2-agent-ext-ultracode` comment-only refs ×6
  (`extensions/ultracode.ts` ×2, `src/web-tools.ts` ×1,
  `src/workflow-tool.ts` ×1, `src/workflow-editor.ts` ×2) +
  `tests/workflow-tool.test.ts` ×1
- `bun-apps/s2-agent-ext-wayfind/skills/triage/SKILL.md` ×1
- `bun-apps/s2-agent-ext-research-tool/CONTEXT.md` ×1
- `bun-apps/s2-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md` ×1
- `bun-apps/tests/adr-citation.test.ts` ×1 (comment)

## Skill-shape fallout (no-bash-skills guard)

Converting docs to ACTIVE SKILL.md files brought their `.sh` mentions under
`test:no-bash-skills`'s docs seal (docs previously at `docs/agents/` were never
scanned). Two fixes inside the migrated content:

- `shared-state-index`: a bare `setup-repo-deps.sh` mention (drift-risk column)
  now carries the full `scripts/` prefix so it resolves on disk.
- `learnings`: the `dedup.sh` mention (a BANNED_TOOLS name — no history relief
  on the docs surface) was reworded to describe the deleted pre-Bun-port
  launcher without naming it.

## Verification

1. `bun .claude/skills/using-s2-agent-skills/list-ext-skills.ts skills` —
   six new skills present and resolvable (58 → 64).
2. `cd bun-apps/s2-agent-ext-devops && bun run typecheck && bun test` —
   oneshot-smoke assertion green with the new path.
3. `run_local_ci` over changed packages (devops, ultracode, wayfind,
   research-tool, superpowers) — green.
4. `grep -rn "docs/agents"` over the repo → only `.planning/` history and
   the `vaults_root/` submodule.

## Ship

Single flat PR (branch `migrate-docs-agents-to-devops`): artifacts + skills +
sweep in one reviewable diff; squash-merge via the devops chain
(`merge-pr-after-ci-cli`), `verify-merge-cli` scope CLEAN.
