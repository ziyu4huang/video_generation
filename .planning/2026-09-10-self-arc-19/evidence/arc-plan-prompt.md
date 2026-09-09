# self-arc-19 plan request — loop-integrity: the self-develop arc improving ITS OWN metadata tooling

You are planning self-arc-19 (branch `self-arc-19-loop-integrity`, already created off origin/main — the arc number is CLAIMED). This arc was DECIDED by the previous session's self-reflection pass over full evidence; the decision is pre-approved — execute the design space, do not re-litigate the charter. READ BUDGET: at most ~12 reads total, then WRITE the plan.

## Goal (decided, verbatim charter)

"Move the loop's metadata integrity from discipline to tooling." Today the loop's own
bookkeeping (arc numbers, queue pointers, load-bearing receipts) is held together by
agent discipline; 2026-09-10 alone produced THREE fresh instances of one structural
failure class: (1) dual arc-18 number claims — 4th collision in the series; (2) a
rebase's add/add relocation that git-rm'd an ALREADY-MERGED planning map from main
(restored byte-identical via #2243; caught only by verify-merge full-scope);
(3) a stale byte-duplicate goal file surviving in the queue with a pointer naming
the wrong one (found by the deep-exploration pass).

## Required input reads (2 files, then repo recon within budget)

1. `output/next-goal-20260910-040000.md` — the queue head: charter + 4 tickets
   (t-ledger / t-pointer / t-permanence / t-remainder) + done-when boxes.
2. `output/explore-selfarc-deep/plan.md` — the exploration report; its ranked six
   structural fixes ①machine-checked arc ledger ②queue-pointer write-time validation
   ③receipt-permanence tier ④independent receipt validator ⑤qualify.ts trigger
   ⑥retry helper. Fixes ①②③ ARE this arc (④⑤⑥ stay ranked-queued, NOT in scope).

## A fifth ticket the USER added this session (directive, not negotiable in scope)

- **t-reviewer**: the arc loop's quality gate is asymmetric — the PLANNER runs on
  zai/glm-5.3 (arc-plan.ts, double-pinned), but the REVIEWER dispatched at review
  time rides the harness's builtin flash model. Add a reviewer-dispatch twin:
  `arc-review.ts` in `bun-apps/s2-agent-ext-subagent/scripts/` mirroring arc-plan.ts
  (spawnSubagent, model double-pinned zai/glm-5.3, writes plan-style receipt with
  model/usage/elapsed, exit 1 on failure), so the reviewer subagent runs the SAME
  big model. reviewer-harvest.ts's pi-harness fallback (PR #2170) already harvests
  s2-agent-dispatched reviewers — verify that path, don't re-implement. NOTE: a new
  top-level script under s2-agent*/scripts/ needs its path added to the allowlist in
  s2-agent-ext-devops/tests/scripts-dir-contract.test.ts (one line). Dogfood: this
  arc's own review gate dispatches through arc-review.ts.

## Recon already known (verified; spend reads on what you can't trust)

- validate-next-goal.ts lives at `bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts`
  (logic `src/validate-next-goal.ts`, pinned by `tests/validate-next-goal.test.ts`).
  t-pointer extends or wraps it — one command that validates the target, deletes
  byte-duplicate stale goal files, and verifies frontmatter dates vs filename.
- Planning maps: `.planning/<date>-self-arc-*/map.md` with frontmatter `status:`.
  Arc numbers are claimed AT MERGE (series convention); collisions so far caught by
  luck (4 collisions: arc-14→16 renumber ×2, dual arc-18, audit-gate-fidelity note).
- Ledger precedent: guard tests like devops `tests/artifact-leak.test.ts` and
  `tests/scripts-dir-contract.test.ts` (repo-root invariants as bun tests).
- The arc-17 audit result JSON (`output/self-arc17-audit-result.json`) is
  load-bearing scratch referenced by committed maps — t-permanence's concrete
  specimen. hermes-memory is the completed check-script specimen for t-remainder
  (19 packages still lack a real biome `check` script — decision: adopt-or-reject
  per class with recorded rationale, NOT a 19-package fix spree).
- sv-analyzer wasm test skip loudness: same loud-skip convention hermes just
  shipped (tests/store/surreal/_helpers.ts localDescribe pattern).

## Constraints (hard)

- Children/planner/reviewer LLM = zai/glm-5.3, never flash.
- One implementation PR through the devops chain; map + tickets ride it in
  `.planning/2026-09-10-self-arc-19/`.
- Red-bar proof for the ledger guard: synthetic duplicate-claim fixture turns CI
  red BEFORE the fix is trusted green.
- output/ is scratch — never commit it (t-permanence's committed tier is the
  exception pattern: `.planning/<effort>/evidence/`, size-capped).
- Schema-cost +0 does not bind here (no s2-agent tool descriptions touched), but
  spawn-tool catalog snapshots must stay deterministic if you touch registry code.
- Keep the arc SMALL: tickets rank t-ledger → t-pointer → t-reviewer as the
  tooling core; t-permanence adopts the convention for THIS arc's own evidence;
  t-remainder is a recorded decision, not a code sweep.

## Your task

Produce `.planning/2026-09-10-self-arc-19/map.md` + tickets with an Execution order
line. Definition of done (from the queue head, plus the user addition): ledger guard
merged and RED on a synthetic duplicate-claim fixture; pointer tooling merged and
USED for this arc's own close-out; permanence convention adopted by this arc's
evidence; check-script decision recorded with per-class rationale; arc-review.ts
merged and used for this arc's review gate; successor written (strict v2, validated,
LATEST repointed VIA the new pointer tooling).
