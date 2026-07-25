## Question

Validate that upstream's convergent fix-loop (5-round breaker: 3 resume + 2 fresh capable) actually converges on pi, given every round is a fresh dispatch with no resume (ticket 04). Is a probe/eval needed, or is structural inspection of the re-pinned SKILL.md + prompts enough?

**type:** task (structural + smoke — recommended scope)
**claimed:** agent-session (2026-07-26) — **CLOSED**
**blocked by:** 05 (done), 06 (done)

## Notes

Upstream validated convergence with a RED/GREEN eval rig the fork lacks (see map "Not yet specified"). The minimum bar: structural inspection confirms the 5-round breaker + scoped re-review language landed in the pinned files, and a smoke dispatch shows a fresh "resume" round correctly reads the prior report file. A fuller probe (does it actually converge on a pathological task?) is optional and may graduate from the map's fog.

## Resolution (2026-07-26)

**DONE — structural + smoke (recommended scope).** All fix-loop machinery verified landed + the cross-round memory round-trips on the real harness.

**Structural inspection (all PASS):**
- 5-round circuit breaker: L61 "Fix round R of 5: R≤3 resume / R≥4 fresh+capable"; L96 "R=5 → Adjudicate (breaker trips)".
- Rounds 1-3 resume / 4-5 fresh capable: breaker node + L130 "mid-loop: resume the loop at the next round".
- Scoped re-review: L62/91/92 "Dispatch scoped re-review (./re-review-prompt.md)"; `re-review-prompt.md` L7 "Verify each finding".
- Controller adjudicates → BLOCKED: L98 "Any load-bearing finding? → STOP: report BLOCKED".
- Rationalization table: L427 `| Excuse | Reality |`.
- Report-file memory: implementer-prompt L109-111 "resumed with the findings … append a fix report to your report file".

**Path consistency:** SKILL.md L218 `task-N-brief.md → task-N-report.md` under the workspace root == `sdd-workspace` (06) output. ✓

**Smoke (real subagent, round-2 resume simulation):** fresh read-only dispatch read the round-1 report + returned `readReport: yes; status: DONE_WITH_CONCERNS; openConcern: "input >= 0; negative inputs untested"` — correctly extracted the round-1 status + concern. **The cross-round memory mechanism works on pi without resume-in-place** (ticket 04's fallback confirmed end-to-end).

**Accepted textual divergence (documented, not a defect):** the pinned implementer-prompt says "you will be resumed with the findings" — on pi this is a FRESH dispatch carrying brief + report + findings (no resume-in-place, ticket 04). This mirrors how the pi-port handles upstream path references (text says `.superpowers/`, runtime uses `.planning/`). The report file is the persistent memory either way; the bootstrap's Pi tool mapping tells the controller the subagent is a fresh dispatch.

**NOT done (out of scope, low ROI):** a full RED/GREEN convergence eval (does a controller actually do 5 rounds + break on a pathological task?) — upstream's eval rig isn't ported; deferred per the map's fog.

**status:** closed
