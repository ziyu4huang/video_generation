---
name: using-knowledge-cards
description: |
  Use when doing knowledge work over the vault — converging structured records
  (.knowledge.jsonl, hermes § entries, auto-memory/generic .md) into the shared
  graph, asking cross-source questions, adding curated atomic cards, or choosing
  between the zk_* hub tools (zk_card / zk_ask / zk_ingest / knowledge_query)
  and raw obsidian vault actions. Owns the two-tier hand-off: when zk_* vs
  obsidian. The knowledge-card extension is the TIER-1 convergence hub; it may
  reference obsidian (its TIER-0 foundation dependency) — edges point down only.
---

# Using Knowledge Cards (the convergence hub)

The `s2-agent-ext-knowledge-card` extension is the **TIER-1 convergence hub**:
it builds on the TIER-0 `obsidian` foundation (vault I/O) to add duplicate-
checked cards, graph-RAG, and deterministic convergence. Per ADR-0001 the
dependency edges point **DOWN only**, so this skill may reference both `zk_*`
(its own tools) and `obsidian` (its foundation dependency) — but the obsidian
foundation skill never references back up.

## The two tiers

```
TIER 0 — FOUNDATION:  obsidian  — vault I/O (create/read/search/... + distill/garden)
                          ▲
                          │ knowledge-card depends on obsidian (down edge ✓)
TIER 1 — HUB:         zk_card · zk_ask · zk_ingest · knowledge_query  (this skill)
```

- **Authoritative map:** `bun-apps/KNOWLEDGE-LAYER.md`.
- **Layering discipline:** `docs/adr/0001-strict-downward-edges-knowledge-layer.md`.

## Hand-off — zk_* vs raw obsidian

Pick by what you have and what you need:

| Situation | Use | NOT |
|-----------|-----|-----|
| Records of ANY shape (`.knowledge.jsonl`, hermes `§`, auto-memory `.md`, **any `.md`** via the `generic` adapter) | `zk_ingest` (**DEFAULT** — deterministic, lossless, idempotent) | ❌ `obsidian distill` |
| A LONG NARRATIVE where one-card-per-file would lose signal (e.g. a sprawling multi-thousand-word design rationale) | `obsidian distill` as a **pre-step**, then `zk_ingest` the result | — |
| Add one curated atomic card (dup-checked) | `zk_card add` | raw `obsidian create` |
| Agent self-triggered distill of memory entries | `zk_ingest` `action=gate`/`converge`/`status` | — |
| Cross-source knowledge Q&A (graph-RAG, LLM) | `zk_ask` | — |
| Structured digest by tags (deterministic, no LLM) | `knowledge_query` | — |
| Convergence-folder dup/orphan/dead-link audit | `zk_card check` | — |
| Quick capture / raw note / full-text search / backlinks / vault-health audit | `obsidian` (the foundation — see its `using-obsidian-vault` skill) | — |

**The distill trap:** `obsidian distill` and `zk_ingest` are NOT duplicates and
NOT alternatives — `zk_ingest` is the DEFAULT for every source (including
arbitrary `.md` via the `generic` adapter, which is lossless and idempotent).
`obsidian distill` is a **pre-enrichment step**, not a substitute: reach for it
ONLY when a file is a long narrative whose value would be lost as a single card
(one-card-per-file still captures it losslessly via `generic`; distill just
atomicises it first). If unsure, `zk_ingest` first — you can always distill
after.

## The zk_* tools at a glance

- **`zk_ingest`** — converge structured records → shared graph (deterministic,
  no LLM, idempotent by canonical id). Four source adapters: `workflow-jsonl`
  (`.knowledge.jsonl`), `hermes` (§-separated memory `.md`), `auto-memory`
  (name/description `.md`), `generic` (ANY `.md`).
- **`zk_card`** — CRUD on Zettelkasten cards: `add` (4-layer dup check) / `find`
  (multi-strategy search) / `update` (smart-merge) / `remove` (backlink-safe) /
  `check` (vault health audit).
- **`zk_ask`** — graph-enhanced RAG over the vault (seed retrieval → N-hop
  wiki-link expansion → cluster & rank → answer in Traditional Chinese).
- **`knowledge_query`** — cross-workflow tag-ranked digest (deterministic, no
  LLM, no subagent — the cheap read path).

For raw vault capture / search / health, use `obsidian` (the foundation) — see
its `using-obsidian-vault` skill.
