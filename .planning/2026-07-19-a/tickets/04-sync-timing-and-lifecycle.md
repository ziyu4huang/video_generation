---
type: research
status: open
blocked by: 02, 03
---

# 04 — Sync timing & lifecycle

## Question

WHEN does the unified layer parse + sync (`session_start` full sync? file-watch? `tool_execution_end` after a plan write?), and HOW do auto-managed todos survive `session_compact` / `session_tree` / branch-switch — does goal-todo re-pull the plan AFTER `replayFromBranch(ctx)` (so synced todos survive) or does replay clobber them? Define the ordering (replay first, then re-sync). Verify idempotency + merge-safety across concurrent sessions editing the plan dir.

Adopted + restated from the older effort's ticket 05 for the unified layer.

### Context

- goal-todo hooks: `session_start/compact/tree` → `replaceState(replayFromBranch(ctx))`; `tool_execution_end` → refresh on `todo` success; stale-ctx errors swallowed via `isStaleCtxError`.
- To verify during research: what `tool_execution_end` exposes beyond `toolName` + `isError` (does it carry args / output path to detect a plan write?); whether pi offers any file-watch primitive to extensions.
