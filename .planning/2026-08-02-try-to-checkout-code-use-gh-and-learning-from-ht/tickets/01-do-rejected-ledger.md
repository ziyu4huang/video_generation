# DO — banned-mechanism ledger (REJECTED.md)

**UPSP pattern:** §三三 (淘汰机制汇总) · **Decision:** DO (do first) · **Effort:** XS (pure process)

## What
A `REJECTED.md` (or a section in `CONTEXT.md`) under `pi-agent-ext-hermes-memory` — a 3-column table: **old mechanism | why killed | replacement**. Seed with hermes-memory's settled rejections (consolidation strategies, DB-backend choices, destructive-supersession semantics, subprocess→spawnSubagent migration, the flat `failures.md` vs lifecycle decision).

## Why
Decision-log-as-anti-regression-device. Stops re-litigating settled designs; speeds onboarding ("why don't we X?" → row N). UPSP's §三三 is its most useful page; near-zero cost.

## Acceptance
- Table exists with ≥ the seed rows; updated whenever a design is killed.
- Lives in the domain docs (CONTEXT.md / docs/adr family).

## Scope hint
- `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md` or new `REJECTED.md`.
