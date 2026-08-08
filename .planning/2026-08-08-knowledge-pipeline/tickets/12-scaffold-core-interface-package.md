---
type: task
status: open
blocked by: 03, 04
---
# 12 — Scaffold core-interface package + KnowledgePipeline

> **Blocked by 03 + 04 (interface stability):** both reshape the `KnowledgePipeline` interface this task scaffolds — 03 → graph edges in ingest/retrieve return types (possibly a new graph primitive); 04 → embed/vector params + touchpoints on ingest/retrieve. Do not build until both close, or the contract gets reworked.

## Question / scope
Implement the `@repo/pi-agent-ext-core-interface` workspace package per ticket 11's contract, and ship its first tenant so ticket 06's typed impl unblocks.

## What to build
- New workspace package `@repo/pi-agent-ext-core-interface` (types + runtime infra).
- `SEAM_KEYS` registry (key names + crossPackage flags) — single source of truth; `bun-apps/tests/seam-contract.test.ts` imports it from here.
- `publishSeam(key, impl)` + `readSeam<T>(key): T | undefined` accessors over `globalThis`; `key` typed as a union of registered seam keys (compile-time orphan prevention).
- `KnowledgePipeline` interface (first tenant): the zk-primitive surface hermes consumes — `ingestRecords`, `runConvergenceLoop`, `retrieveRecords`, `collectInputFiles`, file-`extract` (signatures to match zk's current exports).
- Register `__piKnowledgePipeline` (crossPackage: true); zk publishes the impl via `publishSeam` in its extension factory; hermes consumes via `readSeam<KnowledgePipeline>`.
- Relocate existing `__pi*` inline key literals to import from the pkg's `SEAM_KEYS` (incremental — wire the new key now; existing-seam migration is follow-up per ticket 11 fork 3).

## Acceptance
- [ ] Package scaffolds under `bun-apps/pi-agent-ext-core-interface/` with package.json (workspace, lockstep pi-core version).
- [ ] `publishSeam`/`readSeam` exported + typed-key union; orphan-publishing fails to compile.
- [ ] `KnowledgePipeline` interface defined; zk publishes `__piKnowledgePipeline`; hermes reads it defensively.
- [ ] `seam-contract.test.ts` imports `SEAM_KEYS` from the pkg; guard green; `__piRateLimitState` orphan registered or explicitly scoped.
- [ ] `bun test` green for core-interface + seam-contract + affected extensions.

## Notes
- Decided by ticket 11 (all 4 forks). Blocks ticket 06's typed-contract impl.
- zk publishes; hermes consumes (per ticket 06 fork 1 + 3). Vault resolution/write stay in zk.
