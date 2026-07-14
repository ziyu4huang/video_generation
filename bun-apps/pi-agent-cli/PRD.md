# PRD — pi-agent-cli

## Problem

Agent workflows like `vlm-describe`, `zk-extract`, `zk-ask`, and `pipeline pdf-to-vault` need a self-contained, non-interactive CLI entry point — one command per run, no TUI loop, no persistent session. Each run curates only the tools it needs instead of loading every extension.

## Solution

A self-contained CLI with extensions baked in as workspace deps. Drives pi-agent via the SDK from TypeScript on Bun. Ships agent workflows (vlm-describe, zk-extract, zk-ask, pipeline pdf-to-vault) plus a pi-compatible passthrough so the binary can serve as its own sub-agent target. Extensions are imported directly into the process (`pi-obsidian`, `pi-vlm`, `pi-knowledge-card` as `workspace:*` deps) without `.pi/settings.json` entries.

## Tools / Commands

| Command | Description |
|---------|-------------|
| `zk-extract` | Decompose files → Zettelkasten notes via subagent |
| `zk-ask` | Graph-enhanced RAG over Zettelkasten vault |
| `zk-ingest` | Deterministic convergence of structured records → vault cards |
| `vlm-describe` | PDF/image → Obsidian markdown via LM Studio VLM |
| `pipeline pdf-to-vault` | Multi-stage PDF pipeline |
| `doctor` | Self-check: runtime, repo layout, run-dir manifest, MLX paths, Obsidian vault |
| `workflow run` | Headless engine runner for pi-agent-ext-workflow scripts |
| `workflow list` | Enumerate available engine workflows |
| (passthrough) | Any pi-agent subcommand in non-interactive mode |

## Key Dependencies

- `@earendil-works/pi-coding-agent` (SDK)
- `pi-agent-ext-hermes-memory` (persistent memory: memory_search, session_search, skill_manage)
- `pi-agent-ext-obsidian` (always loaded for vault access)
- `pi-agent-ext-knowledge-card` (zk-extract, zk-ask, zk-ingest, knowledge_query)
- `pi-agent-ext-distill` (knowledge distillation pipeline: hermes-memory → vault → graph)
- `pi-agent-ext-vlm` (VLM describe)
- `pi-agent-ext-power-tool` (doctor diagnostics)

## Agent Knowledge Stack

Four extensions form a self-regulating knowledge pipeline: raw memories
accumulate, are filtered and enriched, then converge into a linked graph.
The combined agent tool surface is **12 tools / ~3835 schema tokens**.

```
pi-agent-cli
  ├─ hermes-memory    (5 tools, ~1551 tok)  ← raw memory accumulation
  │     memory · memory_search · session_search · skill_manage · skill_manage_help
  │
  ├─ obsidian         (2 tools,  ~235 tok)  ← vault I/O
  │     obsidian · obsidian_help
  │
  ├─ knowledge-card   (4 tools, ~1928 tok)  ← Zettelkasten graph convergence
  │     zk_ask · zk_ingest · zk_card · knowledge_query
  │
  └─ distill          (1 tool,   ~121 tok)  ← pipeline orchestrator
        │     distill (actions: status / gate / converge)
        │
        └─ adaptive threshold (event-driven, default N=50, clamp [20,200])
```

### Distillation data flow

```
hermes-memory (raw, bloated)
    │
    ├─ Stage 1: GATE (rule-based, deterministic, no LLM)
    │     dedup (fuzzy Jaccard ≥0.72) · staleness prune (90d) · format validation
    │
    ├─ Stage 2: ENRICH (agent LLM, in-context — no LLM-in-extension)
    │     agent rewrites survivors: clarity · tags · wiki-links · merge fragments
    │
    └─ Stage 3: CONVERGE (deterministic, reuses knowledge-card ingestRecords)
          canonical-id dedup · tag cross-links · MOC indexing
          → knowledge-card graph (findable, traversable)
          │
          └─ THRESHOLD FEEDBACK: converge metrics → auto-adjust N
             killRate>0.7 & passRate>0.8 → N-=5 (efficient)
             passRate<0.5 → N+=10 (conservative)
```

Agent workflow: `distill status` → `distill gate` → [enrich survivors] →
`distill converge` (3 tool calls + in-context enrichment between gate and
converge). The lifecycle hook nudges the agent on session start when bloat
exceeds the threshold.

### Schema-cost regression guard

The combined tool surface is pinned by `perf-harness/tests/grand-total.regression.test.ts`
(budget: 4200 tok, baseline 3835). Per-extension guards exist in each
extension's `perf/` test directory. Any schema inflation (reverted
promptSnippet, verbose description, new tool) fails CI.

## Use

```bash
bun bun-apps/pi-agent-cli/src/cli.ts <command> [options]
```

## Cross-reference

- [`docs/workflow-cli.md`](docs/workflow-cli.md) — headless engine runner reference
- [`../pi-agent/docs/pi-cross-machine-setup.md`](../pi-agent/docs/pi-cross-machine-setup.md) — fresh-machine steps
