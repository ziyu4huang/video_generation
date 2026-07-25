## Question

Does pi's `subagent` tool support resume-in-place (which upstream's fix-loop rounds 1-3 rely on), or must every round be a fresh dispatch?

**type:** research (AFK)
**claimed:** wayfinder-chart
**blocked by:** —

## Resolution

**No resume-in-place is exposed to the caller.** The `subagent` tool schema (`subagent-tool.ts`) exposes: `task, model, tier, cwd, tools, excludeTools, tokenBudget, retryOnTransient, commitScope, schema, agentType` — no `resume`/`sessionId` param. (An internal checkpoint/replay resume exists in `agent-registry.ts` / `errors.ts`, but it's for paused-run recovery, not "resume a prior implementer with new findings.")

→ Upstream's fix-loop spec already anticipates this: *"On a harness without agent resume, a 'resume' is a fresh dispatch carrying the brief, the report file, and the findings — the report file is the persistent memory either way."* So **pi uses that fallback for ALL fix-loop rounds.** The report file (`<sdd>/reports/task-N-report.md`) is the cross-round memory; the re-pinned `implementer-prompt.md` + new `re-review-prompt.md` already instruct the fresh dispatch to read it.

**Implication:** no harness work is needed for the fix-loop — it's pure prompt/glue. This de-risks ticket 05 (re-pin) significantly.
