# self-arc-21 plan request — independent receipt validator: stop trusting the harness's own grades

You are planning self-arc-21 (branch `self-arc-21-receipt-validator`, already
created off origin/main; the arc number is CLAIMED in `.planning/arc-ledger.json`
— the first consumer of the arc-19 ledger procedure; do not renumber). The
effort dir `.planning/2026-09-10-self-arc-21-receipt-validator/` exists with a
seeded map — EXTEND it (tickets + Execution order + decisions), do not rewrite
its Destination/Context. READ BUDGET: at most ~12 reads total, then WRITE.

## Goal (queue head verbatim intent)

qualify.ts's sweep verdicts become re-derivable from primary evidence: an
independent validator re-grades each scenario receipt by reading the RAW
evidence (step-helper entries, model lines, settle markers, receipt counts)
WITHOUT consulting the harness's own pass/fail fields, and proves its teeth on
a self-graded-pass-but-actually-red fixture. "Grades become claims the tooling
can audit."

## Why this matters (the class, not the instance)

arc-17's fake-red incident (file2md stale install; hyperframes vendored-test
sweep — proven by #2237's executor re-runs) was grades without independent
re-derivation, one level up. Today qualify.ts's `pass` fields come from the
harness's own predicates; a sweep summary is trusted because it exists. The
deep-exploration report ranked this fix #4.

## Required input reads (≤3, then repo recon within budget)

1. `.planning/2026-09-10-self-arc-21-receipt-validator/map.md` — the seeded map
   (Context already holds the measured facts; extend, don't re-derive).
2. `bun-apps/s2-agent-ext-subagent/scripts/lib/qualify/summary.ts` — the pure
   aggregation whose `pass` fields the validator will re-derive from primary
   evidence (read its `isRed`/`buildSummary` contract).
3. One real receipt specimen: `ls output/qualify19-full/` then read ONE
   scenario receipt JSON + `summary.json` to fix the actual field shapes
   (Fog note: shapes must come from a real sweep, not memory).

## Known seams to design around (measured, this machine)

- Receipt field shapes differ per scenario (tui-drive scenarios vs rpc-pair
  probes: `rpc` fields carry model-ok/settled lines). The validator's schema
  must tolerate the union or dispatch per scenario type.
- The validator should be PURE (receipt dir in → re-graded verdicts out) for
  testability; NO live-agent re-run in this arc (that is a bigger arc — record
  as out-of-scope).
- Live sweep raw receipts are gitignored scratch: tests build fixture receipt
  dirs in temp dirs (the t02/t01 house pattern — see
  `bun-apps/s2-agent-ext-devops/tests/repoint-next-goal.test.ts` and
  `bun-apps/s2-agent-ext-wayfind/tests/arc-ledger.test.ts` for the two fixture
  idioms).
- Where it lives: the validator grades qualify (subagent package) receipts but
  the independent-grader convention + runnable entry pattern lives in devops
  (validate-next-goal / repoint-next-goal precedents). Your call on package —
  ground it in which package's gates the tests belong behind, and note that a
  new top-level script needs an allowlist line in
  `s2-agent-ext-devops/tests/scripts-dir-contract.test.ts`.

## The proof that matters (the red bar)

At least one fixture: a receipt dir whose SELF-graded pass says green but whose
primary evidence says red (e.g. model line shows flash, or a settle marker
absent, or a step-helper entry missing the dictated sentinel) — the validator
must REJECT it. Like arc-19's ledger canary, this fixture stays permanent: an
independent grader never seen disagreeing with a wrong self-grade has never
been seen working.

## Constraints (hard)

- Children/planner/reviewer LLM = zai/glm-5.3, never flash.
- ONE implementation PR through the devops chain; map + tickets + evidence
  ride it; evidence under `.planning/2026-09-10-self-arc-21-receipt-validator/evidence/`
  (the t04 convention: ≤256KB/file, text-only).
- Review gate VIA arc-review.ts (dogfood continues; its dispatch is
  unharvestable — receipted seam — the review.md + review-receipt.json ARE the
  verdict artifacts).
- Close-out successor written + repointed VIA repoint-next-goal.ts.
- No deployed-behavior changes expected (test/validator-only) — assert via the
  deploy receipt; if the ext shim bytes drift, run the full qualify sweep per
  the iff-src-changed rule (that sweep's receipts then become the validator's
  first REAL input).
- Keep the arc SMALL: re-grade from receipts; no qualify.ts rewrite, no new
  sweep lanes, no live re-run lane.

## Your task

Extend the seeded map with tickets + Execution order line. Definition of done
(from the queue head): ledger entry committed at branch time (DONE — a4ea2e29);
planner ran on GLM 5.3 with a receipt; validator merged and proven on the
wrong-self-grade fixture; PR merged through the chain with review via
arc-review.ts and verify full-scope; successor written and repointed via
repoint-next-goal.ts.
