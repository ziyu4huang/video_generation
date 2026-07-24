# PRD — pi-agent-ext-power-tool

## Problem

Developers need runtime introspection of the pi agent's own state: what extensions are loaded, which tools are registered, how many tokens the context window holds, and whether the loaded extension surface is healthy. Without these diagnostics, debugging extension loading, tool conflicts, or context bloat is guesswork.

## Solution

A pi extension with developer-focused diagnostic tools: `inspect_agent` dumps full agent state to YAML (extensions, tools, skills, context files, model, cwd); `inspect_context` breaks down the context window by component; `inspect_extensions` lints loaded extensions/tools/skills for health issues; `inspect_pathology` diagnoses how the agent is failing this session (retry loops, tool error storms, context saturation) from accumulated tool-call history.

## Scope reality (2026-07)

The 2026-07 monolith split **completed** the extraction this section once
flagged as future work. `src/index.ts` now registers only the four diagnostics. The previously co-bundled features were extracted to focused extensions:
`todo`+`/todos`+`/goal`+`goal_complete` → `pi-agent-ext-core-task` (#504);
`ask_user_question` → `pi-agent-ext-ask-user` (#502, merged into
`pi-agent-ext-core-task` 2026-07-18 — no shared code, relocated as the first
step of the core-task pi-ext consolidation); `/btw` →
`pi-agent-ext-btw` (#499). Knowledge tools left earlier for `pi-knowledge-card`
(#351/#354). The `schema-cost` export and CLI subcommand remain here. This
PRD's diagnostics focus is now the literal truth, not just the original intent.

## Tools

| Tool | Description |
|------|-------------|
| `inspect_agent` | Snapshot full agent state to YAML |
| `inspect_context` | Token-cost breakdown by system-prompt component |
| `inspect_extensions` | Lint loaded extensions/tools/skills for health issues |
| `inspect_hooks` | List registered lifecycle hooks per extension and detect unknown event names |
| `inspect_pathology` | Detect failure patterns this session (retry loops, error storms, saturation) — F v1 |

## Key Dependencies

- `pi-agent` (loaded via run-dir manifest)
- Self-contained — no external services

## inspect-*

### inspect_hooks

Hook observability for extension development — the last blind spot of the
inspect surface. Phase 1 (this work): registration listing + `unknown-event-name`
typo detection, reading the aggregated `runner.extensions[].handlers` via a
`getHooks()` polyfill on `sdk-patch.ts`'s `createContext` wrapper.

Phase 2 (follow-up plan, same effort): firing counts — wrap each handler with a
counter at the same patch point, add the `never-fired` (registered-but-dead)
finding. The patch point is shared, so the scaffolding lands once in phase 1.

## Use

```bash
# Auto-loaded via pi-agent's run-dir manifest
# Or standalone:
pi -e bun-apps/pi-agent-ext-power-tool
```
