# Wayfinder map: 2026-07-25-brainstorm-review-new-subagent-move-to-bun-apps-

## Destination

A **prioritized set of decision tickets** for the bidirectional integration of `pi-agent-ext-hermes-memory` ↔ `pi-agent-ext-subagent` — (③) where the memory ext's heavy child-execution ops (consolidation, background-review) should leverage `spawnSubagent`, and (②) where memory should make subagent runs smarter/searchable — captured as decisions that hand off to `writing-plans` / builds. The just-merged #789 extraction's health is reviewed as **context** (the bespoke child-execution subsystem vs the new shared runner), not as a standalone deliverable.

## Notes

- **Domain:** Pi extension architecture. Two exts, currently with **zero cross-references** — `hermes-memory` does not use `spawnSubagent`; `pi-agent-ext-subagent` does not reference memory. `hermes-memory → @repo/pi-agent-ext-subagent` is a **proven acyclic** one-way dependency.
- **Standing preferences for this effort:**
  - **Priority anchor (decided):** ③ `spawnSubagent → memory heavy ops` is the **primary** line (C-tickets); ② `memory → subagent awareness` is **second-line** (B-tickets). Both are in scope; this only sets priority.
  - **Output = decisions, not deliverables.** Wayfinder planning-default holds: each ticket resolves a decision and hands off to `writing-plans`. A prototype only where "how should it behave" is the crux.
  - Backend-neutral conventions from #792/#793 apply (the memory store is a backend-neutral `MemoryRepository`); any integration must stay backend-neutral.
  - Conversation in zh-TW; written artifacts in English; never top-level `cd`.
- **Skills every session should consult:** `wayfinder`, `grilling`, `domain-modeling`; for code context read `bun-apps/pi-agent-ext-subagent/{README.md,CONTEXT.md}` and `bun-apps/pi-agent-ext-hermes-memory/src/handlers/{auto-consolidate,background-review,pi-child-process}.ts`.

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then open the link for the detail the ticket holds -->

- [01 — Audit child-execution vs spawnSubagent](tickets/01-research-audit-child-execution-vs-spawnsubagent.md) — **partial duplication**: `pi-child-process.ts`+`subprocess` transport are heavier parallel impls of what spawnSubagent offers, but the `direct` (`completeSimple`) transport is NOT duplicated; per-site verdict — **consolidation = clean spawnSubagent win, review keeps `direct`, correction-detector + session-flush stay light**; `hermes-memory → subagent` dep is clean acyclic (bare `.` import; `src/` subpath only if wanting `/subagents` viewer).
- [02 — Child-execution transport migration](tickets/02-grill-child-execution-transport-migrate-to-spawnsubagent.md) — **UNIFORM migration decided**: every `execChildPrompt` (subprocess) caller → `spawnSubagent` (small tier, memory tool via `extensionTools` bridging, `src/` subpath so runs hit the `/subagents` viewer); `direct` survives ONLY as background-review's default (frequency); **`pi-child-process.ts` + the `subprocess` transport fully deleted** (tech-debt payoff). Correction-detector + session-flush go spawnSubagent (uniform/zero-rework, still faster than current subprocess) over `direct`+parse/apply-rework. Hands off to `writing-plans` (~5 tasks).
- [03 — Index subagent runs into session-search](tickets/03-grill-index-subagent-runs-into-session-search.md) — **CLOSED, not worth building now**: a subagent's output already returns to the parent session (indexed by `parseSessionFile`) so the high-value case is covered by `session_search`; remaining gap (subagent internal work / cross-session aggregation) is YAGNI. Revisit → build a dedicated `subagent_runs` search (not a session-search shoehorn).
- [04 — Memory-prime for spawned subagents](tickets/04-grill-memory-prime-for-spawned-subagents.md) — **CLOSED, not worth a second prime source**: manual priming (`memory_search` → task/instructions) already works; the auto-prime mechanism is owned by **sub-project ③** (obsidian-scoped `SpawnSubagentPrime {query,topK,folder}`, a no-op forward-ref in `spawn-subagent.ts:14,173`); hermes-memory should plug INTO ③ as a source when it lands, not build parallel. The "isolated-context tension" was moot (priming is opt-in by design).
- [05 — Auto-distill subagent completions](tickets/05-grill-auto-distill-subagent-completions.md) — **BUILD (the one ②-opportunity with a real gap)**: `getMessageText` (`types.ts:194`) filters `type==="text"` only + caps 500 → subagent outputs (tool_result blocks) are **invisible to the learning loop → never auto-captured**. Fix = dedicated capture path for `subagent` tool_results (not broadening shared `getMessageText`), relax the cap, feed to review. Hands off to `writing-plans` (~3-4 tasks).

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

- **e2e validation appetite** — the user has voiced (sibling efforts) wanting more e2e experience; whether the two buildable decisions (02 transport migration, 05 subagent-output distill) should each carry a real e2e/prototype gate in their plans, vs. staying unit-test-only, is not yet pinned (deferred to each plan).

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->

- **`pi-agent-ext-knowledge-card`'s existing `spawnSubagent` usage** — covered by the sibling "other exts bridge with subagent" effort. Reference only, not consumed here.
- **Building any integration** — the destination is a prioritized decision set handed off to `writing-plans`. Implementation is a separate effort.
- **A standalone #789 bug hunt / regression sweep** — #789 was reviewed clean (Ready to merge: Yes) and is merged. Move-health surfaces only as the context that motivates the child-execution question (ticket 01).
- **Repo-wide SQLite-hardcoded-string sweep** — completed in #793.
