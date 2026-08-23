---
ticket: 05
status: done
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

## Resolution

Default flipped sqlite→surrealdb (config.ts). Fallback/switch/recovery machinery pre-existing (BackendBundleWithFallback + swappable proxies + /memory-switch-backend + delta-keyed vector backfill) — verified, suite green. Embed backfill on recovery rides the existing contentHash delta-keyed design; replays automatically after md→DB re-mirror on switch-back.
