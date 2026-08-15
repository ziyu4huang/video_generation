> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — Final state: gate the 5 remaining ungated heavy tools

## Destination

Reach `qa --strict` green by locking the **gate-vs-always-on** decision for each of the 5 still-ungated heavy tools (`subagents`, `sweep_branches`, `memory_supersede`, `await_pr_merge`, `wayfind_effort`), applying each declaration to its tool definition, and verifying coverage passes (qa `coverage.ungated.length === 0`). When `bun run qa --strict` reports `✅ PASS`, the map is done.

## Notes

- **Domain:** tool-gating QA coverage, `bun-apps/pi-agent-ext-tool-gate/`. Gating authority = `buildEffectiveGates()` in `extensions/tool-gate.ts`, which reads owner-declared `gating` via `getAllToolDefinitions()`. QA harness = `bun run qa --strict` (`qa/run.ts` + `qa/coverage.ts`); **green** = `coverage.ungated.length === 0` (the `--strict` coverage branch is skipped). Current red: `5 ungated heavy tool(s) (subagents, sweep_branches, memory_supersede, await_pr_merge, wayfind_effort) — add a gate or confirm always-on`.
- **Skills every session should consult:** `grilling`, `domain-modeling` (one HITL decision per tool).
- **Execution is carried into this map** (override of Wayfinder's planning-by-default): the destination is a *green state*, not merely a set of decisions — so applying each decision and verifying is in-scope, captured by the closure ticket (06).
- **Standing preferences:** one decision per ticket; prefer mirroring an existing sibling's gate where the tool's shape matches (e.g. plural `subagents` vs the already-gated singular `subagent`); only mark `core: true` (always-on) when the tool is genuinely safe to fire unrestricted.
- **Fact freshness:** charted on the current working tree (branch `video_generation__tool_gate`, 53 ahead / 1 behind `origin/main`). The behind-1 commit (`e411f7fa`, overlay-rendering fix in core-task/picker) is orthogonal to this gating domain, so charting facts are fresh; the rebase/merge reconcile is deferred to a pre-PR step (see Out of scope).

## Decisions so far

- [subagents — mirror singular's keyword gate](tickets/01-subagents-gate-or-alwayson.md) — gate the plural fan-out with the singular tool's keyword set (`gating: { keywords: ["workflow", "pipeline", "orchestrate", "fan-out", "fan out", "parallel agent", "multi-step"] }`); not always-on. Tickets 02–05 still open.
- [sweep_branches — keyword gate (devops)](tickets/02-sweep-branches-gate-or-alwayson.md) — gate destructive branch-sweep with devops keywords (`["sweep", "branch", "branches", "cleanup", "prune", "delete-branch", "devops"]`); sets devops posture for ticket 04.
- [memory_supersede — keyword gate](tickets/03-memory-supersede-gate-or-alwayson.md) — gate irreversible memory supersede with memory/supersede keywords (`["memory", "supersede", "superseded", "retire", "replace", "replacement", "correction", "overwrite"]`).
- [await_pr_merge — keyword gate (devops)](tickets/04-await-pr-merge-gate-or-alwayson.md) — gate the PR-merge wait with devops keywords (`["pr", "pull-request", "merge", "merged", "await", "wait", "poll", "devops"]`); consistent posture with ticket 02.
- [wayfind_effort — core: true (always-on)](tickets/05-wayfind-effort-gate-or-alwayson.md) — lightest/routine effort bookkeeping; owner-declared always-on (`gating: { core: true }`).
- [06 — apply declarations + verify qa green](tickets/06-apply-declarations-verify-qa-green.md) — `qa --strict` ✅ PASS, 0 ungated / 26 gated-heavy / 52.1% savings. The 5 declarations alone weren't sufficient; ticket 07's harness wiring was also required.
- [07 — wire omitted registrars into qa/evaluate.ts](tickets/07-wire-omitted-registrars-into-qa-evaluate.md) — added devops/wayfind/memory_supersede to the capture list (reversed the deliberate memory_supersede omission) + wayfind package.json exports + 6 probes; the 4 tools' source gates now recognized → qa green.
- [08 — matchIntent workflow gate count](tickets/08-matchintent-workflow-gate-count.md) — updated the workflow-intent test to expect 5 gates (plural `subagents` now co-fires alongside the singular tool).
- [09 — sanctioned-savings prose drift](tickets/09-sanctioned-savings-prose-drift.md) — updated the pinned savings claim ~8,050→~9,800 (CLAIMED_SAVED_TOK + SANCTIONED_PROSE_TOK + README + pinning test) to reflect real 9,791 tok/req savings; prose-lock passes.

## Not yet specified

<!-- Frontier clear. All 9 tickets closed; `qa --strict` ✅ PASS (0 ungated) and the full `bun test` suite is green (280 pass / 0 fail). No fog remains — only the cross-repo followups + git reconcile noted below. -->

## Out of scope

- **FOLLOWUPS #5** — true upstreaming of `gating` into `@earendil-works/pi-coding-agent` (cross-repo PR). Deferred from Path B; separate cross-repo effort. Recorded in `.planning/2026-08-02-taxonomy-gating-field-migration/FOLLOWUPS.md`.
- **FOLLOWUPS #3** — rolling `gating` out to the ~9 mirrored extensions. Separate rollout effort.
- **Git reconcile** — rebase/merge of behind-1 commit `e411f7fa` (overlay rendering; conflict-likely on a 53-commit rebase). Deferred to a pre-PR step; orthogonal to this map.
