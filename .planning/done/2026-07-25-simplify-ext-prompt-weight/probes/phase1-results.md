# Phase 1 probe results (slimmed subagent tool vs fat baseline)

## Run 1 — REGRESSION (false-negative)
`subagent-dispatch-readonly` struct=FAIL [3,2,0]; `implementer` struct=FAIL [3,3]; `recall` PASS.
Root cause: the structural check grepped the child's PROSE for `/\bsubagent\b/i`, but a child
that dispatches via tool-call may report "I delegated to a worker…" without the literal word.
The judge correctly scored "invokes subagent" = 3 — contradicting the regex. Harness flaw, not a slim regression.

## Fix — harness structural check (probe-runner.ts)
`dispatchSubagent` now captures the child's tool-call transcript via `onHistory`; `runProbe` feeds
`[tools called: <names>]` into the structural haystack. Regex now fires on actual tool invocation.

## Run 2 — hardened harness: ALL PASS
- subagent-dispatch-readonly   struct=ok [3,3,3]  vs baseline [3,3,3] → PASS
- subagent-dispatch-implementer struct=ok [3,3]    → PASS
- subagent-recall               struct=ok [3,3,0]  vs baseline [0,3,0] → PASS (improved)

Conclusion: the slimmed `subagent`/`subagent_runs` schemas are behavior-safe — the LLM still
invokes the tool correctly. Behavior was byte-identical (reviewer-confirmed); probes confirm usage.
