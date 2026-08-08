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
