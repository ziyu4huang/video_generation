# register-tool-surface — extension registerTool tools on the agent tool surface

status: active

## Why (user-approved 2026-08-17)

During the webui_report live demo the orchestrator could not call its own
in-process tool: `webui_report` was absent from the session tool surface, and
a subagent dispatch with requiredTools:["webui_report"] aborted at preflight
("tools not in the child allowlist"). A control probe with the OLDER
gating core tool `webui_present` ALSO aborted — so this is structural, not
per-tool: tools registered via ExtensionAPI.registerTool (webui_present,
webui_report, archify_render, ...) never reach (a) the orchestrator session
model tool list nor (b) subagent tool allowlists. The fallback used in
practice was the loopback HTTP door (POST /api/report) — which #1572 exists to
avoid. The agent-side two-door story is only half-landed until this ticket
lands.

## Evidence (2026-08-17 probes)

- requiredTools:["webui_report"] subagent preflight -> "task requires tools
  not in the child allowlist: webui_report"
- control: requiredTools:["webui_present"] -> identical rejection
- live process served the v3 shell + accepted POST /api/report (200) while
  the tool was registered at boot (wiring registered createWebuiReportTool)

## Tickets

| # | ticket | status | notes |
| - | - | - | - |
| 01 | surface plumbing: expose registerTool tools to the session + subagent allowlist | open | see tickets/01 |

## Constraints

- Schema-cost canary: every newly surfaced tool costs schema tokens in ALL
  sessions — measure with bun-apps/pi-agent/src/cli/commands/schema-cost.ts
  and gate-family the interactive tools (webui_present precedent: core:true
  rationale documented in present-tool.ts).
- Subagent allowlist: children run with an explicit tool set; decide policy
  (allowlist passthrough vs explicit tools:["webui_report"] param).

## Evidence update (2026-08-18, probe)

A `pi.getAllTools()` probe through the REAL CLI (`cli.ts -e probe -p x`,
session_start, offline) settles the premise:

```
[PROBE-TOOLS] total=75 found=["webui_report","webui_present","webui","archify_render"]
```

ALL registerTool tools DO reach the session tool list in real CLI sessions.
The original "never reach the orchestrator session model tool list" claim is
WRONG at the pi-agent level — the orchestrator-seat blindness observed during
the 2026-08-17 demo was THIS pi-harness session's restricted tool config
(that seat sees neither registerTool tools nor read/write/bash), out of
pi-agent's scope. User impact: after a pi restart the TUI model can already
call webui_report directly — the agent-side in-process door (#1572) is fully
landed at the session level.

REMAINING true scope of ticket 01: SUBAGENT allowlists only (preflight
rejects registerTool names in `tools`/`requiredTools`).
