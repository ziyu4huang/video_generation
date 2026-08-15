---
type: task
status: closed
resolution: out-of-scope
blocked by: 04
---

# 06 — tool-gate → shared wrapper

## Outcome: OUT OF SCOPE (reclassified)

Reclassified after reading both `qa/l2.ts` + the wrapper in detail — the fit is
incompatible, mirroring the btw reclassification (ticket 03). `runOnce` is a
**raw prompt-mode pi-agent A/B harness**, not structured subagent dispatch. It
relies on two invariants the wrapper breaks:

1. **env override** — `TOOL_GATE_DISABLE=1` arms/disarms the off-arm. The
   wrapper's spawn passes only `{cwd, shell, stdio}` — NO env passthrough.
   Routing through it would disable A/B arming.
2. **raw stdout+stderr merged capture** — `detectToolUsage` regex-greps the raw
   merged output for tool-call context. The wrapper parses NDJSON events and
   returns only `message_end` assistant text — it drops the tool-call-laden
   output the grep needs.

Forcing l2.ts through the wrapper would destroy BOTH A/B invariants.

The wrapper's contract guarantees don't map either: §2 (model) is trivially
met (l2.ts already passes `--model`); §3 (retry) is actively HARMFUL for A/B
(retry would skew the measurement); §4 (telemetry) is marginal on an
explicitly-EXPERIMENTAL, uncalibrated, prototype harness.

Ticket 03's decision to route tool-gate was made on the audit's surface-level
description ("spawn bun cli.ts subprocess"); the env-control + raw-output
constraints were not known then. New evidence → reclassify.

(If l2.ts ever graduates from prototype, revisit: extend the wrapper with
`env` + raw-capture opts at that point, when the value justifies the surgery.)

## Question

Replace tool-gate's `qa/l2.ts` raw `spawn("bun", [pi-agent/cli.ts])` with a call to
the shared subprocess-wrapper (04). Preserves the A/B isolation testing + gains
§2–§4.

## What resolving it looks like

- the L2 live-A/B spawn goes through `spawnSubagentSubprocess`;
- the controlled-flags (`-p`, `--model` arm/disarm) pass as wrapper opts;
- verify L2 QA still isolates correctly + now registers telemetry.

## blocked by

04 (shared subprocess-wrapper)
