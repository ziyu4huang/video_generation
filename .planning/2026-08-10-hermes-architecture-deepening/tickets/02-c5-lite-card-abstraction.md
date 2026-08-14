---
type: task
status: open
claimed: 2026-08-15 (this PR)
---
# 02 — C5-lite: finish the Card abstraction for kp 13 (enables, does not switch)

## Question
Make kp ticket 13 (memory-card migration) a pure path-switch by enabling memory-kind persistence in card-store NOW, and deciding the backend-construction seam once.

## Grilled decisions (2026-08-15, 3 rounds)
- Scope: C5-LITE — only what 13 consumes. Full review scope rejected (3 of 4 original claims now documented-intentional or fixed by C1/#1196).
- Backend seam: EXTEND backend-factory with a variant exposing the concrete db handle (getDb/withCorruptionRecovery); card-store AND knowledge-search-tool's 3 ephemeral opens switch onto it. One construction path; the documented rationale is satisfied, not overridden.
- persistableKinds += memory|user|failure WITH memory dedup strategy + golden round-trip (persistence ENABLED; NO write-path switch — MemoryStore stays the memory write path until kp 13).
- MemoryTarget stays as-is (documented legacy memory-path type; CardKind ⊋ MemoryTarget is the designed split).
- Sole-source gate: `new SqliteBackend(` allowed ONLY inside backend-factory.ts (test mirrors the C1 fence-split gate).

## Acceptance
- Backend sole-source gate test passes (and would have failed pre-change).
- card-store + knowledge-search-tool construct via the factory variant; grep shows no other `new SqliteBackend(` outside the factory (+ sanctioned init/test helpers if any — enumerate).
- Golden round-trip for memory/user/failure kinds through card-store (serialize→upsert→read→deserialize byte-identity).
- Full hermes suite green; tsc clean.
