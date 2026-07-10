# PRD — pi-agent-ext-power-tool

## Problem

Developers need runtime introspection of the pi agent's own state: what extensions are loaded, which tools are registered, how many tokens the context window holds, and whether the loaded extension surface is healthy. Without these diagnostics, debugging extension loading, tool conflicts, or context bloat is guesswork.

## Solution

A pi extension with developer-focused diagnostic tools: `inspect_agent` dumps full agent state to YAML (extensions, tools, skills, context files, model, cwd); `inspect_context` breaks down the context window by component; `inspect_extensions` lints loaded extensions/tools/skills for health issues.

## Tools

| Tool | Description |
|------|-------------|
| `inspect_agent` | Snapshot full agent state to YAML |
| `inspect_context` | Token-cost breakdown by system-prompt component |
| `inspect_extensions` | Lint loaded extensions/tools/skills for health issues |

## Key Dependencies

- `pi-agent` (loaded via run-dir manifest)
- Self-contained — no external services

## Use

```bash
# Auto-loaded via pi-agent's run-dir manifest
# Or standalone:
pi -e bun-apps/pi-agent-ext-power-tool
```
