> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
## Destination

Adopt obra/superpowers's two SDD reworks into this fork's `subagent-driven-development` skill — (1) the **plan-scoped workspace** (`.superpowers/sdd/<plan-slug>/`, structural per-plan identity; ledger names its plan; dies at plan end) and (2) the **resume-based fix-loop redesign** (convergent 5-round review loop: 3 resume + 2 fresh capable dispatches, scoped re-reviews, unified who-fixes policy, lifecycle-reorganized SKILL.md + rationalization table) — by **re-pinning ADR-0004 to upstream's current SDD files** (SKILL.md +85 lines, + new `re-review-prompt.md`) and reconciling the pi-port glue (`sdd-workspace`, bootstrap routing rule 1) to the new plan-scoped interface.

## Notes

- **Domain:** pi port of obra/superpowers (`bun-apps/pi-agent-ext-superpowers/`). Upstream source: `../superpowers/` (obra/superpowers, current at chart time).
- **Skills every session should consult:** `grilling` + `domain-modeling` (for the HITL tickets); `subagent-driven-development` (the skill under rework).
- **ADR-0004 = positive pin:** re-pinning to newer upstream is the SANCTIONED update path, not a violation. The fork's current pin is to an older upstream; upstream has since shipped these reworks.
- **Fact freshness:** this branch was **13 behind origin/main** at chart time. Research reflects the working tree, which may differ from origin/main by 13 commits. Rebase (ticket 01) before re-pin execution.
- **Slug correction:** the invocation's auto-slug `2026-07-26-duplicte-remeval-…` was garbled and described the discarded "dedup" framing. Refined destination → clean slug `2026-07-26-adopt-upstream-sdd-reworks`. Object if you'd prefer the original.
- **Standing preference:** pi `subagent` has NO resume-in-place (ticket 04) — every fix-loop round is a fresh dispatch carrying brief + report file + findings.
- **Integration isolation (2026-07-26):** this branch diverged from `origin/main` (24 mine / 13 theirs), but origin/main's 13 commits touch ZERO SDD-rework files. The SDD re-pin is isolated and needs NO rebase. The one real conflict (`pi-agent-ext-subagent/` — my schema-slim vs their model-role refactor) belongs to the prompt-weight workstream, not here.

## Decisions so far

- [02 diff: pinned SDD files vs upstream](tickets/02-diff-pinned-sdd-vs-upstream.md) — SKILL.md +85, impl-prompt +3, reviewer-prompt −3, `re-review-prompt.md` NEW; scripts all differ (fork-customized pi-port glue, not pinned).
- [04 pi subagent resume capability](tickets/04-pi-subagent-resume-capability.md) — no resume-in-place exposed; upstream's rounds 1-3 use the fresh-dispatch fallback (brief + report file + findings).
- [03 effort×plan reconciliation](tickets/03-effort-times-plan-reconciliation.md) — **Nest**: `.planning/<effort>/sdd/<plan-slug>/` (effort ⊃ plan); `sdd-workspace` takes PLAN_FILE + PI_PLANNING_EFFORT. Existing-state migration is forward-only (graduated from fog).
- [05 re-pin ADR-0004 SDD files](tickets/05-repin-adr0004-sdd-files.md) — **DONE** (`09dbb7c4`): SDD re-pinned to upstream v6.2.0 (`3dcbd5c4`); SKILL.md 418→503, `re-review-prompt.md` added, fixture rebaselined, suite **122/0**. **Unblocks 06.**
- [06 reconcile pi-port glue](tickets/06-reconcile-pi-port-glue.md) — **DONE** (`9671d84c`): 3 scripts aligned to upstream's `PLAN_FILE` interface + effort×plan resolution; routing rule 1 + `bootstrap.test.ts` updated; `start-server.sh` unchanged. Suite **122/0**. **Unblocks 07.**
- [07 validate fix-loop on pi](tickets/07-validate-fix-loop-on-pi.md) — **DONE** (2026-07-26): structural inspection (all 6 fix-loop mechanisms landed) + report-path consistency + real-subagent smoke (cross-round memory round-trips). **All tickets resolved — destination complete.**

## Not yet specified

- **Fix-loop validation without upstream's eval harness:** upstream validated convergence with a RED/GREEN eval rig; the fork has none. How much validation is enough before re-pin? Graduates into a ticket once 05/07 shape up.

## Out of scope

- The **skills-compression sweep** (upstream's other recent thread — dropping recap sections). User chose SDD reworks as the destination, not dedup. Separate effort if wanted.
- Re-pinning the **other 13 skills** — only the SDD skill is in scope.
- Upstream's **Windows hooks / portability** changes.
- Porting upstream's **eval harness**.
- **`pi-agent-ext-subagent/` integration** (my Phase-1 schema-slim `c25b9243` ⚔️ origin/main's model-role unification `b97e8975`/`4fe905e1`/`2c04d284`). Belongs to the simplify-ext-prompt-weight workstream's merge, not this map. Surfaced by ticket 01's re-scope.
