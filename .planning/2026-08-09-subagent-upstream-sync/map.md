---
id: 2026-08-09-subagent-upstream-sync
title: "Sync pi-subagents upstream — lsp-diagnostics race fix + provenance"
status: complete
last: 2026-08-09
---

# Wayfinder map: 2026-08-09-subagent-upstream-sync

## Destination

`bun-apps/pi-agent-ext-subagent` carries the ONE real upstream sync item pending from
`pi-subagents` plus a provenance record so the watchdog port is never lost again. After
this effort the package's upstream lineage is fully documented and the LSP watchdog no
longer races a stdin write after the child has begun shutting down.

## Notes

**Dual provenance (both true, do NOT collapse):**

- **Package body** (33 src files): extracted from `pi-agent-ext-workflow` (commit `2852457f` / PR #789). NOT pi-subagents. Out of scope here.
- **2 watchdog files**: selective ports from `nicobailon/pi-subagents` (local checkout `/Users/huangziyu/proj/pi-subagents`, reviewed at origin HEAD `165ec10` / v0.45.1, 2026-08-09):
  - `src/watchdog/lsp-diagnostics.ts` ← `pi-subagents/src/watchdog/lsp-diagnostics.ts` — verbatim logic; the `WatchdogLsp*` types upstream imports from `./types.ts` are **inlined** in ours (ours = 571 lines vs upstream 537).
  - `src/watchdog/repo-diff.ts` ← `pi-subagents/src/watchdog/change-signature.ts` — simplified port + our own curation layer (`MAX_ENTRIES`, large-file guard, `DiffForReview`). NO upstream change since our port → nothing to sync.

**The ONLY real upstream sync item:** `lsp-diagnostics.ts` was missing upstream commit
`e4f0782`'s "avoid LSP shutdown write race" fix (a `terminating` guard so a concurrent
`shutdown()`/`kill()` can't double-SIGTERM the child or race a write after exit). Applied
2026-08-09.

**Why this effort exists:** an earlier sync check reported subagent had "no upstream"
because the package had NO provenance record — only the body's workflow extraction was
known. The watchdog ports were invisible. This effort closes that gap.

## Scope (2 tickets)

- [01 — Apply `e4f0782` LSP shutdown-write-race fix](tickets/01-lsp-diagnostics-shutdown-race-fix.md)
- [02 — Record pi-subagents provenance](tickets/02-record-pi-subagents-provenance.md)

## Decisions so far

<!-- the index — one line per closed ticket: gist + link -->

- [01 — `e4f0782` race fix applied](tickets/01-lsp-diagnostics-shutdown-race-fix.md) — added `terminating` guard, idempotent `kill()`, `shutdown()`-catch + `failProtocol()` route through `kill()`; typecheck + 546 tests green.
- [02 — pi-subagents provenance recorded](tickets/02-record-pi-subagents-provenance.md) — added `docs/upstream/pi-subagents.pin.md` + README `## Upstream sync` section; dual provenance now documented so the watchdog port isn't lost again.
