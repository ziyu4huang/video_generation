---
effort: 2026-08-15-tool-gate-complete-redesign
created: 2026-08-15
last: 2026-08-15
status: active
---

# Map — pi-agent-ext-tool-gate complete redesign

## Destination

`pi-agent-ext-tool-gate` redesigned so its core is a **first-class, auditable gating contract** and a **lean, audited always-active core**, with docs matching the code and power-tool as the live introspection surface — and the keyword/co-occurrence matching mechanism **re-evaluated on evidence and either hardened or replaced** (breaking allowed only if a measured alternative beats the current 46/46 must-fire, 20/20 gate-recall, 0 task-breaking, 51.9% savings baseline without growing the 243-tok `enable_tool` overhead).

One line: **replace the fragile contract + bloated core + dead docs, and prove-or-drop the keyword mechanism — without regressing the QA safety net.**

## Notes

**Domain.** tool-gate is a cost-control/visibility layer between `getAllToolDefinitions()` and `setActiveTools()`. It owns no domain tools — it only flips visibility. Since 2026-08-10 the gate set is **owner-declared** via a `gating` field on each tool's `ToolDefinition` (`{core:true}` always-on, or `{keywords, requires}` gated); `buildEffectiveGates` reconstructs gates from those defs, `updateSticky` fires them on prompt match, `filterActive` applies the result, `enable_tool` is the always-on escape hatch. The contract lives in `pi-agent-ext-core-interface/src/tool-gating.d.ts` (ambient `Gating`); the estimator is `power-tool/src/schema-cost/estimate.ts`; `getAllToolDefinitions()` is a `pi-agent` monkey-patch.

**Prior verdicts (cite, don't re-decide).** `qa` today: 11,717 tok saved (51.9%), 0 task-breaking, 20/20 gate-recall, 3 ungated heavy (non-gating). `.planning/done/2026-07-30-…` ruled mechanism redesign out of scope — **re-opened by user mandate here**. `.planning/specs/2026-08-10-tool-gating-contract-collapse-design.md` left Spec B (gating-hygiene/sibling duplication) and Spec C (always-active re-triage) open — carried into tickets 01 and 02.

**Fact freshness.** `origin/main` is `c18f0363` (20 commits ahead of this worktree). Verified: the 20 commits leave **tool-gate.ts, core-interface, and the `gating` contract unchanged**; they do re-architect **power-tool** (`#1464` → `src/gating.ts` `DIAGNOSTIC_GATING` + `cost.ts`/`report.ts`/`runner-hooks.ts`), which affects only ticket 06. Full sync is currently **blocked** by a dirty `vaults_root/study-news` submodule in the main worktree (see the session note).

**Skills every session should consult.** `grilling` + `domain-modeling` (contract-shape decisions); `codebase-design` + `DESIGN-IT-TWICE` (the contract redesign); `writing-plans` (when a ticket becomes plan-writable); `research` (mechanism re-evaluation). power-tool `inspect_context` / `inspect_extensions` for schema-cost evidence.

**Standing preferences.** Breaking allowed **only** where a ticket proves the win on the QA corpus (the corpus is the contract's spec). Keep the mutate/pure split and fail-open posture. One canonical extension entry (`extensions/tool-gate.ts`). `bun run qa` + `bun test` are the gate — never hand-assemble a subset. ADRs cite as `ADR-tool-gate-NNNN`.

## Decisions so far

- [00 Re-evaluate matching mechanism](tickets/00-re-evaluate-matching-mechanism.md) — **KEEP keyword + noun∧verb co-occurrence** (46/46 must-fire, 20/20 gate-recall, 0 task-breaking, live friction ~zero). Semantic/DSL/budget/LLM-only replacements evaluated and rejected as non-wins or complements; an opt-in semantic *fallback* stays fog, gated on `qa:miss` telemetry. The redesign's breaking changes belong to the contract (01) + core (02), not the matcher.
- [01 First-class gate contract](tickets/01-first-class-gate-contract.md) — **id-referenced gate families + shared exported registry in `core-interface`**: export a real `Gate` type (end the ambient-global `Gating`), declare each co-firing group once by id, tools reference `gating:{gate:id}`, delete `gateGatingKey`/`gatesWithSameGating`, and derive `enable_tool`'s list from the registry. Kills Spec B + F8 + the ambient-global fragility; `#1464`'s `DIAGNOSTIC_GATING` is the in-repo precedent. Semantics-preserving (same keywords/requires; `qa:savings`/`qa:gate-recall` byte-identical).
- [02 Always-active core re-triage](tickets/02-always-active-core-re-triage.md) — **safety core vs demotable split**: keep `read`/`write`/`edit`/`bash`/`enable_tool`/`ask_user_question`/`memory`/`memory_search`/`todo`/`goal_complete`/`web_search`/`fetch_content` never-gated; demote ~14 on-demand tools (`zk_ingest` 934, `zk_ask` 765, `wayfind_effort` 617, `skill_manage` 578, `zk_card`, `knowledge_query`, `session_search`, `get_search_content`, `knowledge_search`/`knowledge_ingest`/`planning_stale`, `grill_decision`, `obsidian`/`obsidian_help`) → target ~half the ~10.9k always-on budget. Each demotion needs keywords + probes; telemetry guards the escape-rate.

## Not yet specified

- **Generalize the QA harness** (savings/coverage/corpus/gate-recall/l2) into a reusable gated-extension framework — gate-recall probe sets currently live scattered in the owning extensions (flux2/ltx/research-tool). Graduates only if the contract redesign (ticket 01) shows real cross-extension reuse value.
- **Live L2 measurement** — `qa --l2 --model X` is armed but never run (no model in this env). Graduates if the mechanism re-evaluation (ticket 00) needs live signal beyond the deterministic corpus.
- **Semantic/embedding matcher prototype** — only if ticket 00's research shows keyword matching is the binding constraint; until then it stays fog.
- **`enable_tool` overhead reduction** (243 tok) — graduates only if ticket 00/01 changes the escape-hatch surface.

## Out of scope

- **The gated tools themselves** — flux2/ltx/krea2/movie/research/etc. are owned by their extensions; this effort only controls their visibility.
- **Fixing pre-existing typecheck errors in sibling packages** (the contract-collapse spike recorded 19 in movie-director alone) — unrelated to gating; not this effort.
- **`pi-agent` upstreaming of `gating` into `ToolDefinition`** (the "FOLLOWUPS #5" true owner-declaration path) — this effort works within the extension-layer contract; upstreaming is a separate cross-repo effort.
