# PRD — pi-agent-ext-knowledge-card

## Problem

Structured and unstructured knowledge (workflow findings, session memories, human notes) lives in isolated silos — per-workflow `.knowledge.jsonl` files, hermes memory entries, auto-memory topics. There is no single queryable, graph-linked, deduplicated knowledge base that spans across all sources.

## Solution

Zettelkasten knowledge-management tools for Pi. Provides two ingestion modes — LLM distill (free-form text → atomic notes via `zk_extract`) and deterministic ingest (structured records → vault cards via `zk_ingest`). CRUD over the vault via `zk_card`. Graph-enhanced RAG querying via `zk_ask`. The deterministic `zk_ingest` is the **convergence sink**: it dissolves per-workflow silos into one shared, backlinked graph.

## Tools

| Tool | Description |
|------|-------------|
| `zk_extract` | Decompose files → atomic Zettelkasten notes (subagent-based distill) |
| `zk_card` | CRUD: add, find, update, remove, check — with dedup and backlink safety |
| `zk_ask` | Graph-enhanced RAG: seed retrieval → graph expansion → cluster + synthesize |
| `zk_ingest` | Deterministic convergence: structured `.knowledge.jsonl` → one card per record |

## Key Dependencies

- `pi-agent-ext-obsidian` (hard peer — vault access for subagents)
- `pi-agent-cli` (hosts zk-extract/zk-ask/zk-ingest commands)
- `pi-agent-ext-power-tool` (retrieval path)

## Use

```bash
# CLI
bun bun-apps/pi-agent-cli/src/cli.ts zk-ask "question"
# Or via extension
pi -e bun-apps/pi-agent-ext-knowledge-card
```

## Cross-reference

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — two ingestion modes, data flow
- [`docs/DATA-MODEL.md`](./docs/DATA-MODEL.md) — 12-key record → zettel schema
- [`docs/DEPENDENCIES.md`](./docs/DEPENDENCIES.md) — cross-package graph
- [`docs/kg-improvement-plan.md`](./docs/kg-improvement-plan.md) — knowledge-graph improvement backlog
- [`docs/PR-HISTORY.md`](./docs/PR-HISTORY.md) — knowledge-layer arc
