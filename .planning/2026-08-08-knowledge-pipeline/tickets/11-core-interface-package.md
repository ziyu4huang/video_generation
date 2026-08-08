---
type: grilling
status: open
blocked by:
---
# 11 — Core-interface package (typed cross-extension contracts)

## Question
Scaffold `@repo/pi-agent-ext-core-interface` — a types-first workspace package hosting typed cross-extension interface contracts — and graduate the existing `__pi*` `globalThis` seam family (`bun-apps/tests/seam-contract.test.ts`) into it. First tenant: the `KnowledgePipeline` interface (provider = zk, consumer = hermes) decided in ticket 06.

Pin:
- Package layout + what it hosts (typed interfaces only? or interfaces + the seam-key constants + the relocated `seam-contract` guard?).
- How typed interfaces compose with the runtime `globalThis` seam (typed provider publishes; typed consumer reads defensively; `seam-contract.test.ts` shape-guard retained).
- Migration scope: migrate the existing `__pi*` seams (`__piCoreTaskStatusWidget`, `__piGoalActive`, `__piKickHeartbeat`, `__piPlanIncomplete`, `__piPlanPhases`, `__piPlanSummary`, `__piWayfindGrill`, `__piRateLimitState`) into typed interfaces now, or add the pkg + `KnowledgePipeline` first and migrate the rest incrementally?
- Versioning / breaking-change policy for the typed contracts.

## Notes
- Prior art: `bun-apps/tests/seam-contract.test.ts` (4 invariants: no orphans, no dead keys, object-valued shape-guard, no self-only seams); status-widget precedent (`__piCoreTaskStatusWidget`).
- Spawned by ticket 06 (fork 3). Blocks 06's typed-contract impl.
- Cross-cutting (serves all extensions, not just knowledge-pipeline) — candidate for its own effort if scope grows.

## Resolution (2026-08-08, grilled)

Core-interface package contract pinned across 4 forks. `@repo/pi-agent-ext-core-interface` graduates the `__pi*` globalThis seam family into a first-class typed layer.

- **Fork 1 (layout):** Pkg hosts typed interfaces + the `SEAM_KEYS` registry (key names + crossPackage flags) as the single source of truth. The `seam-contract.test.ts` guard STAYS in `bun-apps/tests/` (repo-level, its natural home) and imports `SEAM_KEYS` from the pkg.
- **Fork 2 (composition):** Typed `publishSeam(key, impl)` / `readSeam<T>(key): T | undefined` accessors over `globalThis`. The key param is a typed union of registered `SEAM_KEYS`, so orphan-publishing (the `__piRateLimitState` class) becomes a COMPILE error, not just a test-time guard. Shape-guard retained as runtime backstop.
- **Fork 3 (migration):** Incremental. Ship the pkg with `KnowledgePipeline` + the accessor infra first (unblocks ticket 06). Migrate the 7 existing working seams + fix the `__piRateLimitState` orphan as reviewable follow-ups; account for `__piWayfindActive` re-publication when wayfind-interactive-widget lands.
- **Fork 4 (versioning):** Lockstep with pi-core (matches #1089 convention). Breaking interface changes = coordinated monorepo PR; shape-guard + compile-time accessor typing catch provider/consumer mismatches pre-merge.

First tenant: `KnowledgePipeline` (provider = zk, consumer = hermes), decided in ticket 06. Implementation → task ticket 12.

closed: implemented-as-decision (contract pinned); impl = task 12.
