---
effort: 2026-08-12-subagent-cluster-reconciliation
created: 2026-08-12
last: 2026-08-12
status: active
---

# Subagent Cluster Reconciliation

**Status:** active (this reconciliation pass). Dispositions executed in this pass; carve-outs and branch cleanup tracked as next steps (out of scope here).

**Supersedes / relates:** Mirrors the `kp-cluster-reconciliation` pattern (commit `802bcc87`, "chart wayfinder map — unify unfinished KP-cluster efforts"). Reconciles the **subagent × tool-gate × core-task × wayfind × superpowers** (`pi-agent-ext-*`) cluster to a single coherent state.

## Destination

Reconcile the subagent / tool-gate / core-task / wayfind / superpowers cluster (`pi-agent-ext-*`) to one clean state so planning for new work can proceed from a true baseline: archive the done-but-untracked efforts, flip the stale `.planning` status stamps to match shipped reality, and record the still-genuinely-open backlog as explicit tracked next steps. **This pass is docs/planning-only — no code, no branch deletion.** Cleanup first; build and branch pruning are out of scope here.

## Why

The `pi-agent-ext-*` cluster accumulated shipped-but-untracked efforts (tool-split shipped via #1207, wayfind-port-new-skills shipped via #1138+#1176, spawn-seam resolved-with-deferrals via #1127/#1129/#1132/#1133/#1135), stale `.planning` status lines that still read `Draft`/`Approved`/`active` long after their work merged, and ~59 pre-squash relic branches plus one branch carrying real unmerged work (`fix/core-task-gate-ask-user-todo`) and one dead WIP branch (`wip/preserve-subagent-workflow-files-pre-orphan`). Before planning new work in this cluster, reconcile to a single coherent state: archive the done, de-stale the shipped, and write the still-open backlog as explicit tracked next steps. This mirrors the repo's prior `kp-cluster-reconciliation` pass (commit `802bcc87`).

## Audit — Efforts reviewed (5)

| Effort | Reality | Disposition |
|---|---|---|
| `2026-08-09-subagent-efficiency-guardrails` | PARTIALLY-DONE: only #05 shipped (#1158); #01–04 OPEN (real backlog, design decisions pending; depends on spawn-seam) | KEEP — real backlog |
| `2026-08-10-subagent-tool-split` | DONE (#1207); 28 plan checkboxes never flipped | ARCHIVE (this pass) |
| `2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task` | resolved-with-deferrals: #1/#2 shipped (#1127/#1129), #3 stg1–3 shipped (#1132/#1133/#1135), #3 stg4 (goalState) DEFERRED, #5 reverted (#1142→#1145) | ARCHIVE (this pass); carve stage-4 into a future dedicated effort |
| `2026-08-10-improve-subagents-batch-tui` | READY-TO-PLAN (spec approved #1178; no plan/impl) | KEEP — independent, needs a plan |
| `2026-08-08-wayfind-port-new-skills` | DONE (Batch 1 #1138, Batch 2 #1176); all tickets closed | ARCHIVE (this batch) |

## Audit — Branches (~60 keyword-matched)

- ~59 are **pre-squash relic pointers** — their content already lives on `main` (verified via `git cherry` / `git log`), so they carry no unmerged work.
- Exactly **1 carries real unmerged work:** `fix/core-task-gate-ask-user-todo` (tracked next-step #4 — rebase onto main → typecheck+test on `pi-agent-ext-tool-gate` → PR).
- **1 is dead WIP:** `wip/preserve-subagent-workflow-files-pre-orphan`.
- **Branch deletion is DEFERRED** (out of this pass — no branch deletion in a docs-only reconciliation PR; see tracked next-step #5).

## Audit — Stale statuses

Eight efforts in `.planning/` carry status stamps that lag their shipped reality:

1. `2026-08-10-superpowers-tighten-and-document/spec.md` — shipped #1235, status still `Draft`.
2. `2026-08-11-superpowers-bootstrap-trim/plan.md` — shipped #1241, status still `active`.
3. `core-runtime-extraction/spec.md` — shipped #1251, status still `Approved (design — pending implementation plan)`.
4. `2026-08-09-subagent-workflow-tsconfig-strictness/spec.md` — shipped #1165, status still `Approved design — pending implementation.`
5. `2026-08-09-subagent-tui-toolcall-pairing/spec.md` — shipped #1161, status still `proposed`.
6. `2026-07-31-core-task-quota-retry/spec.md` — shipped #969, status still `Design approved; ready for implementation plan`.
7. `2026-07-31-core-task-length-continue/spec.md` — shipped #966, status still `Design approved; ready for implementation plan`.
8. `2026-08-02-core-task-review/` — shipped whole (#1262 closed the effort). **NOTE:** this item was stale relative to the worktree's snapshot base (`0156022f`), where the effort's own status + 5 ticket frontmatters (#12, #10, #08, #14, #16) still read `open`. During the pre-merge rebase onto current `origin/main`, it was discovered that **#1262 had already landed on main** (between `0156022f` and `2abb0e28`) and **already closed the entire effort**: map frontmatter is `status: complete`, and tickets #08/#10/#12/#14/#16 are already `status: closed` with `resolved:` evidence lines. So #8 required **no edit this pass** — verified already-done; only items 1–7 were flipped.

## Dispositions executed in this pass

- [x] Archive 3 done efforts → `.planning/done/` (tool-split, wayfind-port-new-skills, spawn-seam). See [ticket 01](tickets/01-archive-done-efforts.md).
- [x] Close the spawn-seam effort + record the stage-4 goalState deferral (no home yet → tracked next-step #1). See [ticket 02](tickets/02-close-spawn-seam-defer-stage4.md).
- [x] Flip 7 stale `.planning` statuses (items 1–7) to Done with cited shipping PRs. See [ticket 03](tickets/03-fix-stale-planning-statuses.md).
- [x] Verify `2026-08-02-core-task-review` (item 8) — already closed on `origin/main` by #1262 (map `status: complete`; tickets #08/#10/#12/#14/#16 already `status: closed`); **no edit needed this pass** (found during pre-merge rebase). See [ticket 03](tickets/03-fix-stale-planning-statuses.md).

## Tracked next steps (out of this pass's scope)

1. **Carve spawn-seam stage-4 (goalState session-isolation) into a dedicated effort.** The goalState slice of ticket #3 was deferred when spawn-seam archived; it needs its own home + design.
2. **Fold guardrails #01–04 onto a canonical `subagent-runtime` map with blocking edges.** Dependency chain: stage-4 isolation → safe `session_start` in children → unlocks guardrails correctness (efficiency-guardrails #01–04 depend on correct child seeding/isolation).
3. **Write the implementation plan for `improve-subagents-batch-tui`.** READY-TO-PLAN (spec approved #1178); independent of the isolation work.
4. **Ship `fix/core-task-gate-ask-user-todo`.** Rebase onto `main` → `pi-agent-ext-tool-gate` typecheck+test → PR. The one branch carrying real unmerged work.
5. **Delete ~59 stale-pointer branches (local + origin) + the dead `wip/preserve-subagent-workflow-files-pre-orphan` branch.** Branch deletion is a separate, deliberately-isolated pass (not a docs PR).
6. **(Optional) archive the 8 status-flipped efforts into `.planning/done/`** for consistency with the 3 archived this pass (the status flips already record them as done/closed in place).

## Out of scope

- **Any code change** — this pass is strictly `.planning/` markdown.
- **Branch deletion / merging of code branches** — deferred to a dedicated pass (next-step #5); the primary worktree and its `main` ref are untouched.
- **Actual implementation** of the guardrails, stage-4 goalState isolation, or the batch-tui plan — those are the next efforts this reconciliation unblocks.
- **Re-enabling remote CI / branch protection** — explicitly disabled by repo policy.
