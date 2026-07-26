---
type: task
status: open
blocked by: 04
---

# 05 — obsidian → shared wrapper

## Question

Replace obsidian's `src/lib/subagent.ts` raw `child_process.spawn` with a call to
the shared subprocess-wrapper (04). Preserves isolation (still subprocess) + gains
§2–§4 (config-aware, retry/timeout, telemetry visibility).

## What resolving it looks like

- obsidian's distill/garden paths call `spawnSubagentSubprocess` instead of the
  in-package `spawn`;
- the curated-tool-allowlist + temp-script logic moves to caller args of the
  wrapper (or stays in obsidian as pre-processing);
- verify distill/garden still run + now appear in `/subagents`.

## blocked by

04 (shared subprocess-wrapper)
