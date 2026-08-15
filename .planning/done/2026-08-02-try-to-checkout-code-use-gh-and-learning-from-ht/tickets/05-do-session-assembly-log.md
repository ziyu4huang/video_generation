# DO — per-session assembly log (prompt-provenance)

**UPSP pattern:** §5 (cheap tier — `request_body_sha256` analogue) · **Decision:** DO · **Effort:** S

## What
Log, per session, the **set of `md_id`s assembled into the prompt** + a hash of the assembled block, into the DB. This is the missing half of our provenance story: we have *entry* provenance, not *prompt* provenance.

## Why
Lets us later answer "which sessions saw the stale version of memory M before it was superseded?" and detect assembly drift. Prerequisite for the replay harness (DEFER) and the "used" signal (ticket 06).

## Acceptance
- Each session records the assembled `md_id` set + a block hash.
- Queryable: given a memory id, list sessions whose assembly included it.

## Scope hint
- `prompt-context.ts` (capture the assembled set + hash) + a DB `session_assembly` record/table.
