type: grilling

## Question

Cold-set the **SEVERITY** (impact-*if*-real) of each open candidate BEFORE the
research tickets (01–05) land, so impact isn't rationalized to whatever the
research finds. Mirror the 2026-07-26 tool-gate map's cold-threshold discipline.

Rank each of the open candidates **P0 / P1 / P2** (or "already-closed" if later
research confirms):

- 01 Duplicate / competing forced blocks
- 02 Session-type reach gaps (workflow worker / obsidian-zk child / SDK-headless / core-task sub-models)
- 03 `_systemPromptOverride` precedence vs the per-turn block
- 04 Patch-interaction ordering (force-response-language × sibling PATCH_TABLE patches)
- 05 Disable-path env-gate (`BUN_PI_FORCE_RESPONSE_LANGUAGE=0`)
- 06 Integration-test gap (no test the block reaches a real session)

**Bar:**
- **P0** — breaks the forced-language guarantee in a real session type that ships today (the block is absent or wrong).
- **P1** — degrades it, or breaks an edge the user is plausibly likely to hit.
- **P2** — theoretical / unlikely / already worked around / pure test-coverage hygiene.

Severity is impact-IF-real; tickets 01–05 determine IS-it-real; the disposition
(fix / mitigate / accept) combines both in a later pass. Record the ranked matrix
as the resolution.
