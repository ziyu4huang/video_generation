type: research

## Question

Which session types does the per-turn block actually **REACH**, and which (if
any) bypass it?

**Context (chart-time):**
- The patch wraps `AgentSession.prototype._installAgentNextTurnRefresh`, which
  runs in every `AgentSession` constructor.
- The patch header CLAIMS reach "by construction" for main / subagent-subprocess
  / workflow / obsidian-child.
- The lighter-alternative effort (its ticket 03) already established that
  **core-task / TUI runs INSIDE the main session** (not a separate type).

**Open question:** do **workflow worker**, **obsidian/zk child**, and
**SDK/headless** sessions each construct an `AgentSession` (→ reached), or do
any use a different execution path (raw SDK runner, worker thread without an
`AgentSession`) that bypasses the wrap?

Resolve by tracing each session type's construction path in the SDK
(`agent-session.js` + the workflow / obsidian / SDK entrypoints). Partly
verifiable live (kick the tires — run one of each and inspect the prompt).

**Outcome:** a reach matrix (reached / bypassed per type). Any bypassed type
graduates a fix ticket. The matrix also feeds **06** (integration-test scope).
