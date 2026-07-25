## Question

Validate that upstream's convergent fix-loop (5-round breaker: 3 resume + 2 fresh capable) actually converges on pi, given every round is a fresh dispatch with no resume (ticket 04). Is a probe/eval needed, or is structural inspection of the re-pinned SKILL.md + prompts enough?

**type:** prototype (HITL) — or task (AFK) if structural-only suffices
**claimed:** _(open)_
**blocked by:** 05 (re-pin), 06 (glue)

## Notes

Upstream validated convergence with a RED/GREEN eval rig the fork lacks (see map "Not yet specified"). The minimum bar: structural inspection confirms the 5-round breaker + scoped re-review language landed in the pinned files, and a smoke dispatch shows a fresh "resume" round correctly reads the prior report file. A fuller probe (does it actually converge on a pathological task?) is optional and may graduate from the map's fog.
