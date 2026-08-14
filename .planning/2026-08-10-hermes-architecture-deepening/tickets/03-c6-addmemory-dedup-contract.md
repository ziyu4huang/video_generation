---
type: task
status: open
claimed: 2026-08-15 (this PR)
---
# 03 — C6: addMemory exact-dup dedup into the MemoryRepository contract

## Grilled decisions (2026-08-15)
- Mechanism: equality SELECT mirroring syncMemoryEntry's identity (project+target+category+content) — NO hash column, NO migration.
- Semantics: exact-dup hit → return the existing entry (no duplicate row); documented in the MemoryRepository interface (dedup is now part of the contract).
- Contract tests: exact-dup via addMemory, both backends. Near-dup/topic-dup stay MemoryStore-layer (boundary documented in the test file).
- Purpose: kp ticket 13's acceptance requires dedup parity against the unified store; closes the blind-INSERT gap (silent double-persist).

## Acceptance
- addMemory called twice with identical content+scope → one row, same returned entry id both times (sqlite + surreal contract tests).
- Existing addMemory lifecycle/recall tests stay green.
- Full hermes suite green; tsc clean.
