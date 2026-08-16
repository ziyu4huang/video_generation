---
ticket: 05
status: open
blocked-by: [04]
---

## Goal

Make SurrealDB the default backend with a transparent sqlite fallback.

## Scope

- `config.dbBackend` default becomes `'surreal'`.
- Add a reachability probe.
- Fallback behavior = CRUD + FTS, no embeddings.
- Queue embed backfill on Surreal return.

## Acceptance

- surreal-down-path tests green.
- Fallback degrades tools, does not brick them.
- Backfill replays queued embeds.
