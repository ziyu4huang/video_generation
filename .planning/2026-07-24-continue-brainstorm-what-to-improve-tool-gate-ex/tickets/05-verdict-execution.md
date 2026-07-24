---
type: task
status: open
blocked by: [02-instrumentation, 03-workload-timeframe, 04-threshold]
---

# 05 — Execute the measurement, apply the threshold, record the verdict

## Question

With the aggregator ([02]), the workload+timeframe ([03]), and the threshold ([04]) all settled, **run the measurement, compute [01]'s metric, apply [04]'s bar, and record the go/no-go verdict** — the destination act of this map. This is the one ticket that *does* rather than decides: the decisions are made; this executes them and reads off the answer.

## What to do (task — executes the settled decisions)

1. Confirm [03]'s logging window has actually elapsed and the JSONL covers it (no gaps where logging was off). If the window is incomplete, **wait** — do not verdict on partial data.
2. Run [02]'s aggregator over the collected JSONL → primary metric (+ secondary lens) + per-gate breakdown.
3. Apply [04]'s threshold: does the measured value meet both the primary ceiling and the secondary (confirmed-miss-on-common-intents) bar?
4. Record the verdict:
   - **GO** — recall is good enough; tool-gate ships as-is. The map is complete; close it (`/wayfind done`).
   - **NO-GO** — recall is a real problem. Record *which* gates/intents drove the failures (the per-gate breakdown + the confirmed-miss prompts), then **graduate the fix-menu fog** into a fresh effort — do NOT spec the fix inside this map (it's past the destination).

## Acceptance

- [ ] The JSONL window is complete (covers [03]'s timeframe with no logging gaps); partial data → wait, not verdict.
- [ ] The metric value + per-gate breakdown is computed and written into this ticket's Resolution (or a linked asset).
- [ ] The verdict (go / no-go) is stated explicitly, with the threshold comparison shown (measured vs [04]'s bar).
- [ ] On no-go: the failing gates/intents are named, and the fix-menu fog is graduated (new effort referenced, not specced here).
- [ ] On go: the map is closable with zero open tickets.

## Resolution

<!-- filled when [05] is worked — the verdict + the numbers that produced it -->
