All three checks verified against the artifact:

1. **Destination** (map.md:10–13): names `reviewer-harvest --name <name>` and the outcome — finds the review, extracts the verdict, writes an idempotent receipt, for both dispatch paths. ✓
2. **Miss receipts** (map.md:20–22): both paths cited — `.planning/2026-09-10-self-arc-21-receipt-validator/evidence/t03-harvest-check.txt` and `.planning/2026-09-10-self-arc-19/evidence/t03-harvest-check.txt`; `ls` confirms both exist. ✓
3. **Ticket deps**: every referenced file exists — `arc-review.ts`, `reviewer-harvest.ts` (script + src), `devops-workflow/SKILL.md`, `repoint-next-goal.ts`; `createSubagentRunPersistence` exported at `s2-agent-core-runtime/src/index.ts:262`. New files (t01's `arc-run-record.ts`) are creations, not deps. ✓

No blockers, no should-fixes, no nits.

VERDICT: APPROVE — all three consistency checks pass with cited line and command evidence.