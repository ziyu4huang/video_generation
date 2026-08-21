---
name: dispatching-parallel-agents
description: Use when dispatching implementation work under pipeline v2 — workflow templates are the default engine; manual subagent dispatch is the exception path
---

# Dispatching Parallel Agents (pipeline v2)

## Default: workflow templates own the fan-out

Under pipeline v2 you do not hand-dispatch implementation agents. The workflow
templates run the deterministic part — gate, impl, verify, janitor, ledger —
and you keep the judgement part: briefs, budgets, and red-verdict triage.

- **T2/T3 execution** goes through `execute-plan`
  (`bun-apps/s2-agent-ext-ultracode/samples/execute-plan.js`):
  gate → pipelined impl+verify per ticket → janitor → ledger report.
  One ticket flows impl → verify independently; no barrier between tickets.
- **T1 execution** goes through `execute-t1`
  (`bun-apps/s2-agent-ext-ultracode/samples/execute-t1.js`):
  one impl agent + one read-only verify agent, no phase overhead.

Run a template through the `run_workflow` tool, or headless:

```bash
bun bun-apps/s2-agent-ext-ultracode/samples/run.ts \
  bun-apps/s2-agent-ext-ultracode/samples/execute-plan.js
```

Args shapes:

- `execute-plan`: `{ effort: "2026-08-20-x", tickets: [{ id: "01",
  title: "...", runCmd: "...", expected: "...", brief: "self-contained
  mission text" }] }`
- `execute-t1`: `{ task: "what to implement", runCmd: "gate command",
  expected: "what green looks like", commitHint: "files touched" }`

Both templates gate first — `s2-agent cli pipeline-gate --effort <name>`
(T1 has no effort folder: `--tier T1`). A red gate refuses to dispatch; the
red output names the broken contract, the stage to return to, and what to
backfill. Do not bypass a red gate by dispatching manually.

**Your job as driver:**

1. Write the per-ticket mission brief (see the contract below).
2. Pass evidence-base caps: `tokenBudget` 150k–260k and 6–14 `maxTurns`
   equivalents — few, full turns. Turn count dominates cost (~10k+ fixed
   overhead per turn), so budget turns, not tokens alone.
3. Read the Report phase output: per-ticket verify verdicts, janitor result,
   and the ledger rows.

Do NOT hand-dispatch tickets the template can run. If you find yourself
typing a subagent dispatch for a ticket that has `Run:`/`Expected:` markers,
stop — feed it to `execute-plan` instead.

## Mission brief contract (unchanged from the 2026-08-16 evidence base)

1. **Self-contained**: one mission-group per child; the child sees nothing
   else. Paste the errors, the file paths, the constraints — never "see
   previous context".
2. **`Run:` / `Expected:` on every ticket** — pipeline-gate rejects plans
   without them, and the verify child re-runs the `Run:` command verbatim.
3. **Mandatory final report, even on budget death.** A child that dies must
   still report `{ status, commit, gateOutput, notes }` so the ledger row
   and any partial green work survive.
4. **Verify child is read-only** and runs after every write child. It
   re-runs the ticket's gate command and sanity-greps the diff; it never
   edits files. Package green is not repo green — the verify child is the
   mechanical check that catches what package-local tests miss.
5. **Turn count dominates cost** (~10k+ fixed overhead per turn) — prefer
   fewer, fuller turns over many shallow ones.

## When to reclaim MANUAL dispatch (the exception path)

Manual subagent dispatch is still right in exactly three cases:

- **A red verdict needs cross-ticket judgement** — the failure implicates
  more than one ticket, or the verify evidence contradicts the impl report.
  Dispatch the investigation yourself, or switch to systematic-debugging.
  Never paper over a red verdict; redispatch or escalate.
- **The workflow runtime is unavailable** (plain session, no extension) —
  fall back to classic subagent dispatch with the same brief contract
  above. Same caps, same report discipline.
- **Exploratory work with no enumerable tickets** — don't force a template.
  If you can't write `Run:`/`Expected:` for the work yet, it isn't ready
  for dispatch; do the exploration first, then template the follow-up.

When you do dispatch manually, the pre-dispatch guardrails still apply:
always set `tokenBudget`, always set `commitScope` (exact paths, `[]` for
read-only), never delegate a task needing a tool the child lacks, and bound
one subagent to one outcome.

## Recovery

- **Budget-dead child**: check `git log` before redispatching — green work
  may already be committed. Don't redo it. Run the janitor sweep
  (execute-plan's Janitor phase, or a janitor child: status → gate → check
  boxes → commit green work), then redispatch only the gap.
- **Query history first**: `s2-agent cli dispatch-log` — every dispatch,
  workflow-driven or manual, normalizes into one schema queryable by
  effort / tier / outcome. Calibrate budgets against what this ticket
  class cost before, not against a guess.
