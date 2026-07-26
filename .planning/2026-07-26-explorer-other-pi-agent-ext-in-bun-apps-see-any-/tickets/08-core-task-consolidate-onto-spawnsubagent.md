---
type: task
status: closed
resolution: out-of-scope
blocked by: 07
---

# 08 — core-task → spawnSubagent

## Outcome: OUT OF SCOPE (reclassified)

Reclassified after a deep read of `goal/auditor.ts`. The auditor is a
**supervised session**, not a one-shot subagent — it is deeply coupled to the
session's event stream to enforce the file-header's "non-negotiable, ported
verbatim" safety floors:

1. **event-stream subscription** (`session.subscribe`) — tracks
   `tool_execution_start/end` (enforces **must-call-a-read-tool**),
   `message_end` (assembles output), and stream errors.
2. **stall watchdog** (10-min **inactivity** → abort → error) — this is an
   *inactivity* detector, NOT spawnSubagent's total-run `timeoutMs`.
3. **custom infrastructure** — `makeAuditorResourceLoader` (no
   extensions/skills/prompts/themes; read-only system prompt),
   `SessionManager.inMemory`, `SettingsManager.inMemory`.
4. **own retry policy** — `AUDIT_MAX_RETRIES=3` consecutive *disapprovals* →
   escalate-to-user; orthogonal to spawnSubagent's transient-error retry.

`spawnSubagent` is a one-shot `agent.run()` that does NOT expose the session
object / event stream / stall detection. Forcing consolidation would LOSE the
safety floors (must-call-read-tool, regression_shield, stall) — which the file
header marks non-negotiable.

**The substantive goal is already met**: the auditor already reuses the
parent's ModelRuntime for auth (`createAgentSession({ modelRuntime:
ctx.modelRegistry.runtime })`, auditor.ts ~L165) — the auth-sharing that 07's
opt enables. The only remaining "gain" (§3 retry/timeout + §4 telemetry) does
NOT map: §3 retry conflicts with the disapproval-retry; stall ≠ total timeout;
telemetry is marginal on an internal auditor. Routing through spawnSubagent
would add no value while destroying the safety floors.

Mirrors the btw (03) + tool-gate (06) reclassifications. The unified dispatch
runner's real scope is **fire-and-forget subagents** (obsidian, knowledge-card,
file2md, workflow, memory-to-vault); supervised/specialized sessions (btw,
tool-gate A/B, core-task auditor) are correctly excluded with documented
rationale. 07's `modelRuntime` opt retains standalone value (broadly-useful
auth/context seam for any spawnSubagent caller).

## Question

Consolidate core-task's `goal/auditor.ts` from direct `createAgentSession` onto
`spawnSubagent`, using the new `modelRuntime` opt (07) to pass the parent's
runtime. Gains §3 (retry/timeout) + §4 (telemetry visibility to `/subagents`).

## What resolving it looks like

- the auditor's `sessionFactory`/`createAgentSession` call becomes a
  `spawnSubagent({ modelRuntime: ctx.modelRegistry.runtime, ... })`;
- the parent-runtime reuse is preserved via the opt;
- goal auditing still works + now inherits retry/timeout + telemetry.

## blocked by

07 (modelRuntime opt)
