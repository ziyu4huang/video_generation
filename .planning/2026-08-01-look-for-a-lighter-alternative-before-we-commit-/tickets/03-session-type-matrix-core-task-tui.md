---
type: research
claimed:
---
## Question

For **each session type** in the test matrix, does a `responseLanguage` change
hot-apply automatically (because the type reads `settings.json` at fresh
construction) or does it need the trigger mechanism from ticket 01/02? Also:
**what exactly is "core-task (tui)"** — identify the extension and how its session
relates to the main `AgentSession`.

### Matrix to fill (expected behavior + evidence)

| Session type | Fresh construction? (reads settings.json) | Needs trigger? | How to A/B test |
|---|---|---|---|
| Main interactive (where `/response-language` is typed) | no — live session | **yes** | type command, check next reply |
| Extension subagent (subagent subprocess) | ? | ? | dispatch a subagent after the change |
| Workflow agent | ? | ? | run a workflow after the change |
| core-task / TUI | ? | ? | TBD — identify first |
| obsidian / zk child | ? | ? | run zk/obsidian after the change |

### Investigate

- Confirm the construction path: do subagent subprocess / workflow agent / obsidian
  child build a **fresh** `AgentSession` (→ `_rebuildSystemPrompt` runs at init →
  reads the new `settings.json`)? If so, they auto-correct and need **no** trigger —
  the only session that needs the mechanism is the **live main session**.
- **Identify "core-task (tui)":** locate the extension (`bun-apps/pi-agent-ext-core-task`
  or similar), determine whether it owns its own `AgentSession`, shares the main
  session, or is TUI-only (no agent reply). This decides whether it's even in the
  "reply-language" scope.
- Per-type A/B procedure: how to flip `responseLanguage` and observe the reply
  language in that type.

### Resolve

The exact test matrix with per-type expected behavior + the identification of
core-task/tui. Narrows "works for all" to the sessions that actually need proving.

### Deliverable

Filled matrix + core-task/tui identification + a concrete A/B procedure per type.

## Resolution (closed)

**"core-task (tui)" identified:** `bun-apps/pi-agent-ext-core-task` provides **TUI
widgets + tools** (`goal`, `todo`, `loop`, `ask_user_question`) that run **inside
the main session's agent**. It does **not** own a separate `AgentSession`. So it is
**not a separate session type** — it is covered by "main interactive session"; its
"replies" are the main agent's replies.

**Filled matrix:**

| Session type | Fresh construction? | Needs trigger? | Why |
|---|---|---|---|
| Main interactive (where `/response-language` is typed) | no — live session | **yes** (per-turn wrap reaches it) | only live session; constructor already ran |
| Extension subagent (subagent subprocess) | yes — fresh pi process | **no** | `applyPatches()` runs in the subprocess → fresh `AgentSession` → constructor wrap + init `_rebuildSystemPrompt` reads new `settings.json` |
| Workflow agent | yes — fresh worker process | **no** | same as subagent |
| core-task / TUI | n/a — runs inside main session | **no** (covered by main) | not a separate session |
| obsidian / zk child | yes — fresh subprocess | **no** | same as subagent |

**Universal-reach proof:** the patch is applied at `applyPatches()` import time,
which runs in **every** pi process (main + every subprocess/worker/child). It wraps
`AgentSession.prototype._installAgentNextTurnRefresh`, called in **every**
`AgentSession` constructor (`:156`). Therefore the per-turn injection reaches **all**
session types by construction — **no per-type handling is needed**.

**A/B procedure (per type):** flip `responseLanguage` via the command (or by editing
`settings.json`), then drive one turn in that type and assert the reply language.
For non-main types the flip can be done from the main session then the type is
spawned — it reads the new value at construction.

**Narrows "works for all":** only the **main interactive session** has a live
caching problem; all fresh-construction types auto-correct. The A/B still covers
all five for safety, but the load-bearing case is main.
