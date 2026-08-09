---
effort: 2026-08-07-let-s-self-reflection-base-on-wayfind-error-and-
created: 2026-08-07
last: 2026-08-09
status: complete
---

# Wayfinder map: 2026-08-07-let-s-self-reflection-base-on-wayfind-error-and-

## Destination

Harden the accumulated **wayfind-domain failures** (sourced from hermes failure/correction memory) **structurally** — into code, tests, skills, and always-on procedure text — so the correct behavior is enforced, not merely remembered as a memory lesson or soft doc. A bounded **audit + harden sprint**, per the standing preference to harden into extensions rather than rely on agent memory.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-wayfind` (primary) + `bun-apps/pi-agent-ext-core-task` (coordinator). Sibling: `pi-agent-ext-superpowers` (byte-identical port — its 14 verbatim `SKILL.md` bodies are **untouchable**; behavioral hardening goes in wayfind skills/procedures or the bootstrap glue, never superpowers).
- **Source material**: hermes failure/correction memories for wayfind — #444 (slugify), #450 (manifest), #455 (token explosion), #471 (parser), #278 (goal_complete), #522 (fact-freshness), #276/#279 (investigate-WHY). Audit verdicts: 3 HARDENED, 1 PARTIAL, 6 SOFT (see Decisions).
- **Standing preference** (memory #434): harden into extensions, not agent memory. The continuous failure→skill-candidate bridge already exists (effort 2026-07-28, shipped); this sprint clears the **unhardened backlog** the bridge didn't catch.
- **Hardening bar**: mix per failure type — regression tests/gates for code bugs; always-on skill/procedure text for behavioral failures.
- **Skills consulted**: `grilling` + `domain-modeling` (this map's grilling); `test-driven-development` (code tickets).
- **Conventions**: tickets referenced by **name**; `blocking:`/`blocked by:` are bare numbers; UNIFIED ticket format (YAML frontmatter + Question / What to build / Acceptance).

## Decisions so far

- **D1 — Effort shape: audit + harden sprint (bounded).** Source = hermes wayfind failures; goal = harden each unhardened one structurally. The continuous graduation bridge (2026-07-28) already covers the ongoing path; this sprint clears the backlog. *(Grilling Round 1.)*
- **D2 — Scope breadth: both code + behavioral; prioritize recurring.** Memory holds code bugs (parser, slugify, manifest, coordinator) and agent-behavioral mistakes (grilling fog, fact-freshness, investigate-WHY). *(Round 1.)*
- **D3 — Hardening bar: mix per failure type.** Tests/gates for code; always-on skill/procedure for behavioral. **Constraint**: superpowers is byte-identical — behavioral hardening → wayfind skills/procedures or bootstrap glue, never superpowers' 14 verbatim skills. *(Round 1.)*
- **D4 — Scope cut: harden #3, #5, #6, #8 (recurring) + #1 (cheap tests); defer #2c.** Audit found 6 SOFT: #1 slugify-tests, #2c stale-effort, #3 blocked-by, #5 token-explosion, #6 goal_complete, #8 investigate-WHY. Recurrence signal: #5 hit 3×, #8 has 2 memories, #3/#6 latent footguns; #1 cheap; #2c deferred (lower value). #4 left as-is (intentional + tested; optional guard test). *(Round 2.)*
- **D5 — #5 mechanism: add a `status` action to the `wayfind_effort` tool.** Returns low-res (titles + statuses + blocking, NO verbatim decision bodies) so subagents don't read whole `map.md` files and exhaust budget. Interactive `/wayfind status` is unavailable to subagents. *(Round 2.)*
- **D6 — #8 surface: wayfinder procedure text.** Add an "investigate WHY a prior fix didn't stick before re-patching" step to `procedures/wayfinder.md`. Lives in wayfind (superpowers untouchable). *(Round 2.)*

## Not yet specified
_(none — frontier empty after Round 2.)_

## Out of scope
- #2c stale-effort cross-worktree guard (deferred — lower value; re-open if it recurs).
- Redesigning the gating/parser mechanism (incremental hardening only).
- The zk-vault / knowledge-card side and hermes operational bugs (separate efforts).
- Editing superpowers' 14 verbatim `SKILL.md` bodies (byte-identical port contract).
