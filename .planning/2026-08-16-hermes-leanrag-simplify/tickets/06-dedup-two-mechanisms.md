---
ticket: 06
status: open
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
