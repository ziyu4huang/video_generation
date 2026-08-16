---
ticket: 06
status: done
blocked-by: [04]
---

## Goal

Reduce dedup mechanisms from 5 to 2 (exact + contentHash only).

## Scope

- Remove near-dup 0.3 (explicit overturn D8), signature, and topic-key mechanisms.
- Delete or adapt their tests.

## Acceptance

- No near-dup/signature/topic-key references remain in `src/`.
- Contract dedup tests green.

## Resolution

Removed near-dup (cosine 0.3 + env override) and topic-key (D8 overturn). Kept: exact (repo contract), contentHash lineage, signature (exact family), dedup-strategy (FTS/hash ingest, kp-04). Obsolete tests deleted (tests/store/near-dup*.test.ts, __tests__/near-dup.test.ts).
