---
type: task
status: done
shipped: PR #1131 (squash 3793a390)
blocked by:
---
# 12 — Scaffold core-interface package + KnowledgePipeline

> **SHIPPED** — PR #1131 (squash `3793a390`). `@repo/pi-agent-ext-core-interface` scaffolded; `SEAM_KEYS` (8 keys) + `SEAM_KEY_ENTRIES` + `KnowledgePipeline` interface + `publishSeam`/`readSeam` accessors (typed-key union → orphan-publishing is a compile error); zk publishes `__piKnowledgePipeline`, hermes consumes defensively via `readSeam`; repo `seam-contract.test.ts` migrated to `SEAM_KEY_ENTRIES`. (Original design: `specs/2026-08-08-core-interface-design.md`.)

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
- [x] Package scaffolds under `bun-apps/pi-agent-ext-core-interface/` with package.json (workspace, lockstep pi-core version).
- [x] `publishSeam`/`readSeam` exported + typed-key union; orphan-publishing fails to compile.
- [x] `KnowledgePipeline` interface defined; zk publishes `__piKnowledgePipeline`; hermes reads it defensively.
- [x] `seam-contract.test.ts` migrated to import from the pkg (via `SEAM_KEY_ENTRIES`). **Known issue:** `__piRateLimitState` (pi-agent-ext-subagent) is still an unregistered orphan → #1130 (open) → `test:seam` red. The existing 7 working seams migrated; the orphan + re-publication of `__piWayfindActive` remain reviewable follow-ups per ticket 11 fork 3.
- [x] `bun test` green for core-interface + seam-contract.

## Notes
- Decided by ticket 11 (all 4 forks). Blocks ticket 06's typed-contract impl.
- zk publishes; hermes consumes (per ticket 06 fork 1 + 3). Vault resolution/write stay in zk.
