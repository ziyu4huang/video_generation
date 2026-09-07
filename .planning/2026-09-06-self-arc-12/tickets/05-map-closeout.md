# Ticket 05 — Map close-out (separate docs PR)

Status: open · Phase 3 · AFTER the implementation PR merges

## Work

1. Flip `.planning/2026-09-06-self-arc-12/map.md`: `status: done`; add
   **Shipped-as** (implementation PR number + squash sha, catalog doc path,
   source/deployed receipt paths from t04 — cite `output/...` paths as evidence,
   they are scratch and stay uncommitted); resolve fog-of-war items with measured
   outcomes; check every ticket.
2. Add reciprocal `Absorbs-into`/`Builds-on` back-link lines to the maps cited in
   this map's Cross-effort links (arc-8, arc-9, arc-10, arc-11,
   subagent-tui-cc-parity-2) — links live on BOTH maps.
3. Verify merge through the devops chain (`gh ship` squash; never `--auto`),
   redeploy, and confirm the deployed tree is the receipted one (t04's deployed
   receipt must have run against the post-merge deployment, else re-run it).
4. Write the successor next-goal per `session-closeout-sop`
   (`output/next-goal-<ts>.md`, strict v2) BEFORE reporting done — hands-off rule.

## Done when

Map done w/ Shipped-as; back-links present on all five cited maps; successor
next-goal written; docs PR merged; main healthy (`main-health` green).
