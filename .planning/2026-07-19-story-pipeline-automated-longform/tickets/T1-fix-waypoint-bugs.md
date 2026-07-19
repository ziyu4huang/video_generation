# T1 — Fix waypoint-runtime argv bug + waypoints fence-stripping

type: task
claimed: pi-agent
blocked by: R1 — Probe orchestrator viability (closed)
status: closed

## Resolution (closed 2026-07-19 — FIXED + TESTS PASS)

Two bugs found during R1 that prevented `run-pipeline` from working:

1. **`waypoint-runtime.ts:130` — `argv.push("--no-tools", "all")` bug.**
   The `"all"` string became a positional argument (user prompt) in the pi-agent
   CLI, swallowing the real prompt. The CLI's `--no-tools` is a boolean flag with
   no value. Fix: `argv.push("--no-tools")` (bare flag).

2. **`waypoints.ts:99` — missing markdown fence stripping.**
   The LM Studio model (gemma-4-12b-qat) wraps its JSON output in `\`\`\`json`
   fences even when instructed not to. `JSON.parse()` failed on the fences, and
   the `clean-to-schema` safety net never reached the data. Fix: regex strip
   of `\`\`\`(json)?...\`\`\`` before parsing.

Both fixes confirmed by `bun test src/waypoints.test.ts` → **8/0 pass**.
The fixes require a session restart for the cached imports to take effect.

After restart: `run-pipeline {projectId, pipeline:"story", model:"google/gemma-4-12b-qat"}`
should produce a full video end-to-end.
