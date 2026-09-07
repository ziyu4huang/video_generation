---
effort: 2026-09-06-self-arc-6
created: 2026-09-06
last: 2026-09-06
status: done
---

# Wayfinder map: 2026-09-06-self-arc-6 — F-ui-2 fixed (data layer) + the missing-invalidate finding

## Destination

Fix the self-arc-4 F-ui-2 finding (a successfully aborted background run
kept rendering in the viewer's Running section) and pin the fix with unit
tests + a strengthened live receipt (`staleRowGone`).

## Shipped

- **Data-layer fix** (`subagent-viewer.ts` `entries()`): an UNGROUPED
  in-flight entry whose status is already terminal is skipped — the registry
  keeps it on purpose (followable trace), but the Running section is not its
  display of record; the completed section's persisted row is.
- **Scoped on purpose**: BATCH terminal children KEEP the greyed, selectable
  frozen-trace rendering (designed behavior, existing tests pin it; first
  patch attempt broke those tests and was reverted — the existing test suite
  caught the scope error immediately, which is the suite working).
- **3 new unit tests**: ungrouped-terminal dropped; batch terminal children
  keep rendering; partial batch keeps header + live child.
- **Receipt hardened** (`staleRowGone`, required for viewer): after the
  abort notification, the live row must leave the Running section.

## Findings

- **F-invalidate (NEW, live-confirmed, future ticket)**: an open viewer is
  NOT invalidated when a background run terminates. The dialog keeps its
  last painted frame (frozen elapsed + stale row) indefinitely — the data
  layer had already filtered the entry, and a close+reopen rendered it gone
  (receipt evidence: `stale-row-1/2` show the row, `stale-row-after-reopen`
  is clean). Fix direction: wire an invalidate from the in-flight registry's
  end/terminal path into the mounted dialog.
- **Driver lessons**: esc-from-follow retries can over-close the viewer —
  the deterministic pattern is esc + REOPEN /subagents (fresh list puts the
  cursor on the running row). One-shot checks (backgroundRow) fail on
  parent-timing variance — latch across polls (same class as allSettled).
- **Ops finding**: the first #2196 merge attempt was blocked by stray debris
  in the worktree (`bun-apps/s2-agent-ext-subagent/output/` — a stray
  LATEST-next-goal symlink made the single-registry guard's statSync throw).
  Cleaned; the root `output/` archive is the canonical one.

## Receipts

`output/self-arc6-receipt-2026-09-06/`: viewer F-ui-2 source PASS and
deployed `0.10.0+g7735878` PASS (9 checks each, incl. staleRowGone), plus
the reopen-clears-stale-row evidence snap.
