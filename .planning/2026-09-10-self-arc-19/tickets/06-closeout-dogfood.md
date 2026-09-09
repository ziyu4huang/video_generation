# t06 — Closeout: ONE PR through the devops chain, dogfooding t03 + t02

## Goal

Land t01–t05 (+ map + tickets + evidence) as ONE implementation PR through
the devops chain; this arc's own review gate dispatches through arc-review.ts
(t03 dogfood) and its successor's LATEST repoint goes through
repoint-next-goal.ts (t02 dogfood) — the tools prove themselves on their
authoring arc.

## Steps

1. **Pre-PR**: all package gates green in the branch worktree (wayfind,
   devops, subagent — each via its canonical `bun run test`, script names
   resolved per package). Full devops chain per the devops-workflow skill:
   local-ci change-scoped → PR (traceability).
2. **Review gate (dogfood t03)**: dispatch arc-review.ts from the BRANCH with
   a review prompt = this PR's diff + map; harvest-verify per t03; receipts
   to `evidence/` (committed pre-merge or noted pending). Review findings are
   fixed BEFORE merge — the gate is real, not ceremonial.
3. **Merge**: `merge-pr-after-ci` (never `--auto`, never waiting on remote
   CI) → `verify-merge` FULL-SCOPE — the #2243 lesson: a rebase relocation
   deleting an already-merged map was caught ONLY by full-scope verify; this
   arc literally ships the ledger, so a dropped `.planning/` file here would
   be the bitterest possible irony. Verify the ledger + evidence dir survived
   the merge byte-identical.
4. **Redeploy decision**: ext src/ gained only test-imported modules
   (arc-ledger.ts, repoint-next-goal.ts) — deployed bundles EXPECTED
   unchanged; assert via the chain's iff-src-changed rule (deploy receipt or
   recorded no-op). Schema-cost +0 asserted (no tool descriptions touched).
5. **Sync + sweep** per the devops chain; post-run review.
6. **Successor**: write the next goal strict v2 (queue head format;
   `validate-next-goal.ts` must pass on it), then repoint LATEST VIA
   `bun .../repoint-next-goal.ts <successor-file>` — the tool's first real
   write is its author's own close-out. Receipt the repoint JSON (it stays
   scratch under output/, per convention).
7. **Map done**: all tickets [x], `last:` updated, `## Shipped-as` section
   appended (what actually shipped vs planned — including any t05 decision
   summary row), status: done; arc-ledger entry updated: `mergedPr` filled,
   status stays as the map's. Memory update per session-closeout-sop.

## Done when (the queue head's boxes + the user addition)

- [ ] Ledger guard merged and RED on a synthetic duplicate-claim fixture
- [ ] Pointer tooling merged; the arc's own close-out uses it
- [ ] Permanence convention adopted by this arc's evidence (+ arc-17 JSON migrated)
- [ ] Check-script decision recorded (adopted or rejected, with per-class rationale)
- [ ] arc-review.ts merged and used for this arc's review gate
- [ ] Successor written (strict v2, validated, LATEST repointed via the new tooling)

## Out of scope

- Anything in the ranked-but-queued trio (independent receipt validator,
  qualify.ts trigger, retry helper) — they stay queued behind this arc.
