---
effort: 2026-09-06-self-arc-4
created: 2026-09-06
last: 2026-09-06
status: done
---

# Wayfinder map: 2026-09-06-self-arc-4 — viewer abort-flow pinned; the harness's own stale bug

## Destination

Close the longest-standing loop gap: the /subagents viewer's abort flow was
only best-effort in receipts (the predecessor's short child task always
settled before x/y could fire). This round drives a LONG child (sleep 120)
and pins the full x/y abort — and in doing so unearths that the harness's
abort check had NEVER actually worked.

## Findings (all receipted, 2026-09-06)

- **F-harness-1 — readSnapText never read a snapshot.** It built the filename
  WITHOUT the `snap-` prefix, so `abortFlow` had been a permanent false false
  since #2190, masked by a plausible-but-wrong "the run finished first"
  diagnosis. Fixed; verified the confirm text now reads back and matches.
- **F-ui-1 — the abort gesture is row-sensitive.** `x` only aborts when the
  SELECTED entry is a running row; on any other row it falls through to the
  type-to-filter input (receipted: `filter: "x" — 0 matches`). The driver
  must navigate to the `bg      ●` live row (ArrowUp — the viewer has NO j/k
  aliases; plain `k` also lands in the filter) before pressing x.
- **F-ui-2 — stale aborted entry.** After a SUCCESSFUL kill (elapsed freezes,
  `status: aborted` notification lands, the parent narrates the abort), the
  viewer's Running section keeps rendering the dead entry for 15s+ (watched
  across six 2.5s polls). Future UI ticket: drop/flip the entry when the
  abort notification arrives.
- Check-design rule reinforced: match the DEFINITIVE observable
  (`status: aborted` / "Subagent aborted by user" notification), not the
  bare word "aborted" (transcripts mention it — receipted false positive),
  and not the live row's presence (stale per F-ui-2).

## Receipts

`output/self-arc4-receipt-2026-09-06/`: viewer abort source PASS (9 checks
incl. abortFlow + abortConfirmed) AND deployed `0.10.0+g7cb10de` PASS. The
`filter: "x"` evidence snap is archived alongside.

## Notes

- 4b (deploy report surfacing core.cached) was investigated and found
  ALREADY SHIPPED: the CLI JSON carries `coreCached` and the HTML report
  renders `(cached hardlink) | (fresh bundle)` next to the core row. No code
  needed — recorded here so the queue item closes.
