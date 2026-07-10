# PRD — pi-agent-ext-subagents

## Problem

A single agent has one context window, one model, and one train of thought. Complex tasks (code review, multi-perspective analysis, parallel research, saved automated workflows) need focused child agents that work independently and return synthesized results. Pi has no built-in delegation mechanism.

## Solution

Multi-agent delegation for Pi. Supports single-agent, chain (sequential pipeline), parallel (concurrent fan-out with optional isolated git worktrees), async (background runs with status polling), and intercom-coordinated workflows. Ships built-in agents (reviewer, oracle, scout) and a supervisor channel for parent-child steering. Optional watchdog recommends complementary models.

## Tools / Commands

| Tool | Description |
|------|-------------|
| `subagent` | Delegate to subagents: single, parallel, chain, async, schedule |
| `subagent_supervisor` / `intercom` | Supervisor channel for parent-child communication |
| `wait` | Block until background runs finish |

### Built-in agents

| Agent | Purpose |
|-------|---------|
| `reviewer` | Code review, diff analysis |
| `oracle` | Second opinion, challenge assumptions |
| `scout` | Code exploration + clarification |

## Key Dependencies

- `pi-agent` (loaded via run-dir manifest)
- Self-contained — no external services

## Install

```bash
pi install npm:pi-subagents
```

## Use

```text
"Use reviewer to review this diff."
"Run parallel reviewers: one for correctness, one for tests."
```
