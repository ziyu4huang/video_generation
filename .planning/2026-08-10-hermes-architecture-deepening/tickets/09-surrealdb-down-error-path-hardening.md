---
type: task
status: open
claimed:
blocked by: (none — open/parallel)
---
# 09 — SurrealDB-down error-path hardening

## Question
Does EVERY path degrade gracefully to the zk JSON-cache cosine when SurrealDB is down — no throw, no silent-empty?

## Acceptance
- Audit every SurrealDB-touching path; tests cover each down-path with graceful degradation verified.
- Open/parallel — not gated by the zk audit or C3.
