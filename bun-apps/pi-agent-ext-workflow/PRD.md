# PRD — pi-agent-ext-workflow

## Problem

One model grinding a task step by step is linear and slow for codebase-wide audits, multi-perspective review, large refactors, or cross-checked research. A single agent context window cannot hold an entire audit surface. Claude Code's dynamic workflow pattern (write a JS orchestration script that spawns subagents) doesn't exist in Pi.

## Solution

Claude Code–style dynamic workflows for Pi. The agent writes a small JavaScript orchestration script that spawns many subagents at once, keeps intermediate work in script variables, and returns only the result. Supports `agent()`, `parallel()`, `chain()`, deterministic gates (retry/loopUntilDry/journaling/resume), and a VSCode workflow editor. Includes a keyword trigger (`/workflows`) and slash commands.

## Tools / Commands

| Tool/Command | Description |
|--------------|-------------|
| `workflow` tool | Execute workflow scripts: `agent()`, `parallel()`, `chain()`, `gate`, `retry`, `loopUntilDry`, `journaling` |
| `/workflows run <prompt>` | Force an ad-hoc workflow |
| `/deep-research <topic>` | Multi-perspective research workflow |
| `/adversarial-review` | Cross-checked review workflow |
| `/workflows-trigger set/off/status` | Manage keyword auto-trigger |

## Key Dependencies

- Self-contained npm package: `npm:@quintinshaw/pi-dynamic-workflows`
- Loaded via pi-agent's run-dir manifest, or headlessly via `pi-agent-cli workflow run`

## Install

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
```

## Use

```text
"Run a workflow to audit every route under src/routes/ for missing auth checks."
```

Headless mode:
```bash
bun bun-apps/pi-agent-cli/src/cli.ts workflow run <name> [--model <spec>]
```
