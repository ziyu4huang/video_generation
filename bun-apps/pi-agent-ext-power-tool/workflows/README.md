# Power-tool extension e2e (L2 regression)

This is power-tool's instance of the **unified extension e2e method** defined in
[`bun-apps/pi-agent/PRD.md`](../../pi-agent/PRD.md) (L2 layer). One canonical
workflow per `pi-agent-ext-*` package; same 3-phase shape everywhere.

## What this workflow tests

`test-power-tool-e2e.js` answers the one question deterministic tests structurally
cannot: *"does every power-tool tool register and run successfully under the real
pi-agent runtime?"*

- **Invoke** — drives each power-tool tool (`context_analyzer`, `agent_inventory`,
  `extension_analyzer`, `knowledge_query`, `graph_health`) through the real pi-agent
  CLI via `bun bun-apps/pi-agent/src/cli.ts -e <ext> -p "call <tool>"`, one bash
  invocation per tool. This is the same path end users take.
- **Gate** — pure JS checks: exit code === 0 AND expected-content markers found
  in stdout (no VLM, no model dependency in this phase).
- **Synthesize** — pass iff every tool clears both its exit and content gates.

The deterministic surface (tool schema, parameter coercion, edge cases, path safety)
is covered by `src/__tests__/index.test.ts` (L0) — NOT duplicated here. See PRD.md
for the L0/L1/L2 split.

## What makes power-tool's L2 different from flux2/krea2

| | flux2 / krea2 (image-gen) | power-tool (analytics) |
|---|---|---|
| Phase 1 | Generate: Swift CLI → PNG | **Invoke**: pi-agent CLI → stdout |
| Phase 2 | **Judge**: VLM scorer on image | **Gate**: exit code + content markers |
| Output quality | Subjective (VLM score ≥ 6) | Binary (exit 0 + expected output) |
| Model in loop | VLM (run.py caption) | **None** — pure bash + JS |

The L2 workflow for power-tool needs NO model to judge — exit codes and content
markers are deterministic. This makes it faster and cheaper than the image-gen
counterparts (~1-2 min vs ~5-10 min for flux2/krea2).

## Phase 3 (todo tool, added alongside embedding)

The `todo` tool is tested alongside the other tools in the same Invoke → Gate
cycle:

- Invoke `todo --action list`: verifies the tool is registered and returns the
  expected empty-state message ("No tasks") rather than crashing.
- State isolation is verified implicitly: running 5 other tools before `todo`
  confirms the mutable todo state doesn't corrupt other tools' snapshots.

## Run

```bash
# unified runner (discovers every extension's L2 workflow):
bash bun-apps/pi-agent/scripts/run-ext-e2e.sh power-tool

# or directly via the workflow tool:
bun-apps/pi-agent/run.sh -e workflow -p \
  "read bun-apps/pi-agent-ext-power-tool/workflows/test-power-tool-e2e.js and execute it via the workflow tool (background:false)"
```

Opt-in — it spends LLM tokens (one model call per tool invocation) and is
non-deterministic (tool behavior depends on the running model), so it is NOT part
of CI's `run-test.sh`.

## Why the workflow invokes the pi-agent CLI, not the tool functions directly

Under `-e workflow`, subagents get `createCodingTools` (bash/read/...) — they do NOT
inherit the parent's registered power-tool tools. So the workflow exercises the same
CLI surface end users invoke, via bash. The tool's own TS logic (schema, parameter
coercion, structured output parsing) is L0's job.

## Inputs (via the workflow tool's `args`)

| Key | Default | Description |
|---|---|---|
| `repoRoot` | `cwd` | Repo root path |
| `piCli` | `<repoRoot>/bun-apps/pi-agent/src/cli.ts` | pi-agent CLI entry point |
| `extPath` | `<repoRoot>/bun-apps/pi-agent-ext-power-tool/src/index.ts` | Power-tool extension path |
| `model` | `google/gemma-4-26b-a4b-qat` | Model for each invocation |
| `timeout` | `60` | Per-invocation timeout in seconds |
