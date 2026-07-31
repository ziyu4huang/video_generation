# Implementation handoff: Watchdog hardening batch

**Effort**: `2026-07-31-let-s-continue-to-improve-base-on-known-upstream`
**Status**: planning complete for this batch; implementation is handoff (wayfinder
decides, it does not build).
**Scope**: `bun-apps/pi-agent-ext-subagent`.

Three **DO** decisions from this wayfinder effort form a cohesive "watchdog gate
hardening" batch. **This note is an index + sequencing guide — the authoritative
specs and acceptance criteria live in the linked tickets** (don't duplicate here).

## The three decisions

| # | Ticket | One-line | Primary files |
|---|--------|----------|---------------|
| 06 | [zero-layer sentinel](tickets/06-watchdog-zero-layer-sentinel.md) | `reviewRan` field + ⚠ summary, **escalated to subagent-tool top level** | `watchdog/types.ts`, `watchdog/watchdog.ts`, `subagent-tool.ts` |
| 08 | [L1 precise delta](tickets/08-watchdog-l1-precise-delta.md) | content-level before→after delta (retain per-file hashes in `RepoBaseline`) | `watchdog/repo-diff.ts` (+ `watchdog.ts` return) |
| 09 | [cross-ext singleton](tickets/09-cross-ext-singleton-handshake.md) | `globalThis`-keyed singleton + version token, **both** singletons | `subagent-in-flight.ts`, `subagent-run-persistence.ts` |

**Together they close the watchdog gate's three failure modes**: 09 = the runs show
up at all (no silent invisibility); 06 = you can tell when a requested review ran
zero layers; 08 = when layers do run, they review the precise delta (not the whole
dirty tree).

## Suggested implementation order

1. **09 — standalone PR.** Isolated to the singleton modules; no shared-file
   conflict with 06/08. Land first (it's the broadest correctness fix and
   independent).
2. **06 + 08 — one PR.** Both modify `watchdog/types.ts` (additive fields:
   `reviewRan` + `RepoBaseline.entries`) and `watchdog/watchdog.ts` (`runWatchdog`
   return / `summarize`). Bundling avoids merge churn on the same two files, and
   they share the watchdog test setup.

## Cross-cutting notes

- **Effort revision**: 08 is **E3** (not E2) — the ticket's "delta already computed"
  premise was false (`_before` was ignored; per-file hashes were discarded). See
  ticket 08's false-premise finding.
- **Hermeticity** (repo value): 08's tests MUST use the injected `RepoGitOps` seam
  (no host `git` binary); 09's tests need the `__reset…ForTests()` hooks; 06's tests
  assert the **top-level** escalation, not just `details.watchdog`.
- **Non-breaking**: 08 narrows the lint set (correct, not behavior-additive) and 06
  adds a sentinel surface — neither breaks existing clean-tree tests (where path-
  level == content-level == exact, and runs normally produce findings).
- **Still blocked** (not part of this batch): 12/13/14 (ecosystem axis) need a
  `web_search` API key in `~/.pi/web-search.json` before their specs can be
  finalized — see effort `map.md` Not-yet-specified.

## Source of truth

- Tickets: [06](tickets/06-watchdog-zero-layer-sentinel.md) ·
  [08](tickets/08-watchdog-l1-precise-delta.md) ·
  [09](tickets/09-cross-ext-singleton-handshake.md)
- [map.md](map.md) — Decisions-so-far + remaining frontier (05, 07, 10, 11, 12, 13, 14)
