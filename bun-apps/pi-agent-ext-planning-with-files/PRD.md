# PRD — pi-agent-ext-planning-with-files

## Problem

Complex multi-step tasks span dozens of tool calls across multiple turns. Without a durable plan on disk, the agent drifts from its goals, loses context across compact cycles, and has no way to attest that the task description hasn't been tampered with.

## Solution

A Pi-native port of the Manus-style "markdown as working memory" pattern (upstream `planning-with-files` v3.4.0). Ships as a Layer-3 Pi extension: 6-event lifecycle, 4 injection modes, SHA-256 attestation, slash commands (`/plan-status`, `/plan-attest`, `/plan-goal`, `/plan-execute`, `/plan-loop`), dangerous-bash guard, and auto-continue. Pure TypeScript — no Python dependency.

## Tools / Commands

| Command | Description |
|---------|-------------|
| `/plan-status` | Show current plan and progress |
| `/plan-attest [--show|--clear]` | SHA-256 lock the plan; detect tampering |
| `/plan-goal` | Show the active goal |
| `/plan-execute [reset]` | Approve plan and activate hooks |
| `/plan-done [--delete]` | Close the active plan (stop nags); `--delete` removes the files |
| `/plan-loop [interval] [prompt]` | Periodic re-tick timer |

## Key Dependencies

- Self-contained (Pure TypeScript, `node:crypto`)
- `pi-agent` (run-dir manifest for auto-load)

## Install

```bash
pi install ./bun-apps/pi-agent-ext-planning-with-files
```

## Use

Create `task_plan.md`, `findings.md`, `progress.md` in the project root or `.planning/<slug>/`, then run `/plan-execute` to activate.
