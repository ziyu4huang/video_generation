---
type: research
status: closed
---

# 03 — Existing test coverage for the workflow command

## Question

What does `bun-apps/pi-agent-cli/tests/workflow-command.test.ts` cover, and can
it extend to the compiled-binary + foreign-cwd path? (Feeds the verification
probe in ticket 05 — don't re-derive coverage that already exists.)

## Resolution

**Source-mode only; mocks the engine. No coverage for compiled binary, foreign
cwd, or a real on-disk pack.**

`tests/workflow-command.test.ts` imports `buildMainSpec`, `parseWorkflowArgs`,
and `workflowRunCommand` directly **from source** (`../src/commands/workflow.ts`)
and stubs `@repo/pi-agent-ext-workflow` via `mock.module`. The stub is a
**transparent passthrough** by default (forwards to the real module loaded by
source path) and only short-circuits with a fake receipt when a `capturing` flag
is set — a pattern chosen specifically to avoid mock leakage into sibling test
files. Coverage:

- `buildMainSpec` — provider/model composition (4 cases).
- `parseWorkflowArgs` — JSON parsing + bad-JSON error (3 cases).
- `workflowRunCommand.run` — `--out-dir` > `PI_WORKFLOWS_OUT_DIR` > default
  precedence (3 cases), and 4-tier model resolution forwarding
  (`callerModel`/`envModel`/`piDefaultModel` + receipt rendering, 5 cases).

**What it does NOT exercise:** the compiled `dist/pi-agent-cli/pi-agent-cli`
binary, a foreign cwd (no repo ancestry), `findRepoRoot` walk-up, a real pack
folder on disk, or the `vm` execution path. So the portable end-to-end proof is
greenfield. **Reusable asset:** the transparent-passthrough mock pattern is a
clean template for a portable-path probe that captures what the CLI forwards
without leaving the source tree.
