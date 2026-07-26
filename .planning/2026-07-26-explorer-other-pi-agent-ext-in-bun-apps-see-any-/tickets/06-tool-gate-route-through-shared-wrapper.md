---
type: task
status: open
blocked by: 04
---

# 06 — tool-gate → shared wrapper

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
