# t04 — Close-out: docs PR, ledger merge, successor next-goal

Effort: 2026-09-10-self-arc-22-subagent-steer-deploy · map D5/D8
ONE docs close-out PR via the devops chain. Status: open

## Work

1. Map close-out in `.planning/2026-09-10-self-arc-22-subagent-steer-deploy/map.md`:
   - `status: done`; frontmatter `last` updated.
   - **Shipped-as** section: implementation PR number + squash sha; t03 receipt
     folders with their PASS lines and the pre-drive grep counts; schema-cost
     delta numbers (from t02's PR body).
   - **Loop findings** section: anything this arc's develop→deploy→drive loop
     surfaced (new learnings or closed ones), receipted.
   - Context amended with the stale-serve mechanism t01 pinned (ticket 01 item 1).
2. Ledger: fill `mergedPr` (and keep `status: "done"`) on entry 22 in
   `.planning/arc-ledger.json` — the wayfind guard (`tests/arc-ledger.test.ts`)
   must stay green.
3. Reciprocal back-links: add `Builds-on: 2026-09-10-self-arc-22-subagent-steer-deploy`
   one-liners to the linked maps' Cross-effort sections (arc-19-subagent at minimum).
4. Ticket checkboxes flipped; effort dir fully tracked (`.planning/` is durable —
   committed and pushed, per repo rules).
5. **Successor next-goal** (strict v2, per session-closeout-sop /
   self-reflect-next-goal): write `output/next-goal-<ts>.md` BEFORE reporting done —
   the queue head after this arc (candidates from this map's Fog of war: pi session
   tool-phase seam quality, marker-selection robustness, anything t03 surfaced).
   Hands-off rule: no "done" without the successor artifact.

## Done when

Docs PR merged (docs-only: package gates scope noted — arc-20's lesson); ledger
entry complete; back-links present; successor next-goal written and noted in the
report; this worktree's branch swept per the devops workflow.

## Risks

- Docs-only PRs skip package gates by design — double-check the effort dir is
  fully tracked so the ledger/wayfind guards see the final map state.
