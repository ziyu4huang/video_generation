# Spec — pi-agent-ext-tool-gate redesign

**Effort**: `2026-08-15-tool-gate-complete-redesign`
**Date**: 2026-08-15
**Status**: spec (decisions settled by wayfind tickets 00–02; execution pending)

## Problem Statement

Every tool an extension registers is charged as per-request token overhead on every turn of every session — even when unused. `pi-agent-ext-tool-gate` already gates heavy domain tools behind keyword + noun∧verb co-occurrence matching (measured 11,717 tok / 51.9% saved, 0 task-breaking gates, 20/20 gate-recall). But its **core is fragile and undocumented**:

- A "gate" (a group of tools that co-fire) has **no first-class representation** — it is reconstructed by comparing JSON fingerprints of per-tool `gating` literals (`gateGatingKey`/`gatesWithSameGating`). Two tools must carry byte-identical `gating` or co-activation silently breaks.
- The `gating` contract is an **ambient-global type**, invisible to imports, forcing tsconfig-`types`/triple-slash plumbing across ~14 packages.
- The **always-active core has bloated** to ~31 tools / ~10,871 tok/req — over half the entire gated-ON budget — with no cost audit.
- `enable_tool` hardcodes a prose list of gated domains that drifts from the real gates; the agent has **no live view** of gate state; the `inspect_*` diagnostics are themselves keyword-gated; the docs describe a dead hardcoded model.

## Solution

Redesign the core in three parts, without regressing the proven matcher:

1. **First-class gate contract.** An exported `Gate` type + a shared registry in `@repo/pi-agent-ext-core-interface`. A gate is declared **once** by id; sibling tools declare `gating: { gate: "<id>" }` (reference) instead of inlining keywords. `buildEffectiveGates` groups by id in a single pass — the fingerprint reconstruction is deleted. `enable_tool` derives its list/description from the registry.
2. **Always-active core re-triage.** Split the ~31-tool core into a **safety core** (never gate) and a **demotable** set (gate on-demand tools), targeting roughly half the always-on budget.
3. **Docs + introspection + lifecycle.** Reconcile README/PRD/CONTEXT to the owner-declared model; give the agent a live gate-state view via power-tool and un-gate the `inspect_*` diagnostics; eliminate the per-turn full rebuild and the subagent-child seam hack.

The **keyword + noun∧verb co-occurrence matcher is kept** (decision 00: 46/46 must-fire, 20/20 gate-recall, 0 task-breaking, friction ~zero). Breaking changes are confined to the contract (01) and the core set (02).

## User Stories

1. As an extension author, I want to declare a gate once by id and have every sibling tool reference it, so I never duplicate keywords and cannot silently break co-activation by editing one side.
2. As an extension author, I want the gating contract to be an importable type, so my package's typecheck no longer depends on tsconfig-`types`/triple-slash plumbing.
3. As an extension author, I want a guard that fails when a tool references an unknown gate id (or a gate id is referenced by no tool), so forgotten declarations are caught at test time.
4. As the agent, I want `enable_tool` to list the gates from the registry, so its description can never drift from the real gate set.
5. As the agent, I want a live view of which gates have fired, which are dormant, and their per-gate token cost, so I can reason about why a tool is missing.
6. As the agent, I want the `inspect_*` diagnostics reachable without first knowing their magic keywords, so I can debug when something is already wrong.
7. As a tool-gate maintainer, I want the always-active set trimmed to the true safety core, so per-turn overhead falls without breaking file I/O, memory, ask-user, or the escape hatch.
8. As a tool-gate maintainer, I want the per-turn path to do no full tool-definition rebuild, so a token-optimization extension does not itself do redundant per-turn work.
9. As an ops reader, I want `qa:savings` and `qa:gate-recall` to stay byte-identical across the contract migration, so I know the redesign preserved gating semantics.
10. As an ops reader, I want `qa:coverage --strict` green, so no heavy tool ships ungated.
11. As a contributor, I want README/PRD/CONTEXT to describe the code as it is, so I don't rebuild the dead hardcoded-GATES model.
12. As a user of subagent sessions, I want gated tools to activate correctly in in-process children without a magic `sticky.size === 0` sentinel, so child sessions behave identically to parent sessions.

## Implementation Decisions

- **Gate contract (from ticket 01).** Export a `Gate` type `{ id, keywords?, requires?, description }` and a `GATE_DEFS` registry from `core-interface`. Tools declare `gating: { gate: "<id>" }`; `core:true` tools stay `gating: { core: true }`. `buildEffectiveGates` groups tools by gate id. Delete `gateGatingKey`/`gatesWithSameGating`; derive `enable_tool`'s list + description from the registry.
- **Migration is expand–contract (wide refactor).** Add the id-reference form beside the existing inline `gating` first (nothing breaks), migrate the 14 owning extensions in batches (green at each step), then delete the inline path + ambient-global `Gating` + the fingerprint code.
- **Core re-triage (from ticket 02).** Safety core (never gate): `read`/`write`/`edit`/`bash`, `enable_tool`, `ask_user_question`, `memory`, `memory_search`, `todo`, `goal_complete`, `web_search`, `fetch_content`. Demotable: `zk_ingest`, `zk_ask`, `zk_card`, `knowledge_query`, `wayfind_effort`, `skill_manage`, `session_search`, `get_search_content`, `knowledge_search`, `knowledge_ingest`, `planning_stale`, `grill_decision`, `obsidian`, `obsidian_help`. Each demotion authors keywords ± `requires` + must-fire/must-not-fire probes.
- **Lifecycle (from ticket 05).** Full rebuild + `measuredTokens` build at `session_start` only; per-turn path is fire + filter + `setActiveTools`. Key `sticky`/`measuredTokens` by `ctx.sessionManager.getSessionId()` (the power-tool pathology-accumulator pattern) instead of a size sentinel.
- **Introspection (from ticket 06).** A `tool_gate_status` surface (or extended `inspect_context`) reads the effective gate state: active count, per-gate fired/dormant + cost, current sticky set. Un-gate `inspect_*` (flip the single `DIAGNOSTIC_GATING` predicate introduced by `#1464`).
- **Matcher (from ticket 00).** Keep keyword + noun∧verb co-occurrence. Do not replace with semantic/embedding/DSL/budget matchers. An opt-in semantic *fallback* is deferred, gated on `qa:miss` telemetry showing a real miss rate.

## Testing Decisions

- **Semantics-preserving migration**: `qa:savings` + `qa:gate-recall` must be byte-identical before/after the contract migration (any drift = a gating declaration was altered, a defect).
- **Contract invariants**: drift-guard asserts "every gate id is referenced by ≥1 registered tool; every gated tool references a known id"; delete the `gating-siblings.test.ts` fingerprint net (same-id ⇒ same-family is trivial).
- **Demotion probes**: each demoted tool gets must-fire + must-not-fire cases in the L1 corpus; `qa:gate-recall` + `qa:coverage --strict` hold.
- **Lifecycle**: `before_agent_start` performs no full-def/measure rebuild; child sessions seed from an explicit session id (test the subagent-spawn seam).
- **Behavioral (not implementation) tests**: test gate firing through the public `filterActive`/`updateSticky`/`enable_tool` surface, mirroring the existing `tool-gate.test.ts` setupPi pattern.

## Out of Scope

- **Replacing the matching mechanism** (semantic/embedding/capability/budget matchers) — rejected on evidence (ticket 00); the semantic fallback stays fog.
- **Upstreaming `gating` into `pi-coding-agent`'s `ToolDefinition`** (the deferred "FOLLOWUPS #5" true owner-declaration) — this effort works within the extension-layer contract.
- **The gated tools themselves** — flux2/ltx/krea2/movie/research/etc. are owned by their extensions; only their visibility is controlled.
- **Fixing pre-existing typecheck errors in sibling packages** (the contract-collapse spike recorded 19 in movie-director alone).

## Further Notes

- **Sync state**: review corrected against `origin/main` `9c1f2ab8` (`#1464` power-tool re-arch, `#1478`/`#1480` knowledge-card refactor). `planning_stale` + `knowledge_search` became `core:true` upstream (folded into ticket 02's demotion set).
- **Measurement caveat**: `qa:savings` hangs on the synced tree (hermes `surrealdb` slow-start); per-tool costs in ticket 02 stay directional until implementation re-runs it.
- **Decision record**: wayfind tickets `00`/`01`/`02` hold the full evidence; the map's Decisions-so-far is the index.
