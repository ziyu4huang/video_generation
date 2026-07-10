# PRD — pi-agent-ext-hermes-memory

## Problem

Pi agents forget everything between sessions. Workflow self-improve loops, failures, corrections, and user preferences need durable storage that survives across sessions and is queryable at runtime.

## Solution

Persistent memory + session search + secret scanning for Pi. Stores categorized memories (failures, corrections, insights, conventions, tool-quirks, preferences) in flat markdown files under `~/.pi/agent/pi-hermes-memory/`. Indexes past sessions for semantic search. Background learning reviews every N turns and saves what matters. Auto-consolidates entries when full.

## Tools / Commands

| Tool/Command | Description |
|--------------|-------------|
| `memory` | Save/query/audit persistent entries across targets (memory, user, project, failure) |
| `memory_search` | Search extended memory store with category/project filters |
| `session_search` | Search indexed past conversation messages |
| `skill_manage` | Create/inspect/update reusable procedural skills |
| `/memory-index-sessions` | One-time index of past sessions |
| `/memory-sync-markdown` | Backfill older markdown memories |

## Key Dependencies

- Self-contained (works across Pi sessions)
- Consumed by `pi-agent-ext-knowledge-card` (zk_ingest --source hermes)

## Install

```bash
pi install npm:pi-hermes-memory
```

## Cross-reference

- [`../pi-agent/docs/knowledge-orchestration.md`](../pi-agent/docs/knowledge-orchestration.md) — 3-layer knowledge system
- `bun-apps/pi-agent-ext-knowledge-card/` — convergence sink consuming this store
