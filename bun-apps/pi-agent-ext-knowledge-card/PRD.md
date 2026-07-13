# PRD — pi-agent-ext-knowledge-card

> **Current-state snapshot: 2026-07-13.** Grounded in the live extension
> registration (`extensions/pi-knowledge-card.ts` registers **4** agent tools),
> `package.json` peer deps, and the in-flight integration roadmap. The
> `docs/TOOL-ORCHESTRATION.md` (2026-07-10) snapshot listed 6 tools — two have
> since moved/merged (see "Tool history" below).

## Problem

Structured and unstructured knowledge (workflow findings, session memories,
human notes) lives in isolated silos — per-workflow `.knowledge.jsonl` files,
hermes memory entries, auto-memory topics. There is no single queryable,
graph-linked, deduplicated knowledge base that spans across all sources.

## Solution

Zettelkasten knowledge-management tools for Pi. The package is the **hub** that
owns every agent-facing knowledge tool. It splits cleanly into two lanes, each
with a deterministic path (no LLM, zero-token, idempotent) and an LLM path
(subagent over `pi-agent-ext-obsidian`):

- **WRITE (converge):** `zk_ingest` (deterministic — the convergence sink) and
  `zk_card` (LLM CRUD).
- **READ (retrieve):** `knowledge_query` (deterministic tag digest) and
  `zk_ask` (LLM graph-RAG answer).

The deterministic `zk_ingest` is the convergence sink: it dissolves per-source
silos into one shared, backlinked graph — one atomic card per record, dedup'd by
canonical id, cross-linked by shared tags, lossless and idempotent (re-ingest is
a no-op).

## Tools (current — 4 agent-facing)

| Tool | Lane | LLM? | Backed by | Description |
|------|------|:----:|-----------|-------------|
| `zk_ingest` | WRITE | ❌ | `src/ingest.ts` `ingestRecords` | Deterministic convergence: `.knowledge.jsonl` / auto-memory / hermes → one card per record |
| `zk_card` | WRITE | ✅ | subagent → `obsidian_*` | CRUD: add / find / update / remove / check — dedup + backlink safety |
| `zk_ask` | READ | ✅ | subagent → graph-RAG (`buildRagTask`) | seed → graph-expand → rank (lexical+graph) → synthesized answer (zh-TW) |
| `knowledge_query` | READ | ❌ | `src/retrieve.ts` `retrieveRecords` | Tag/query digest (gotchas/patterns/levers) |

### Tool history (where the other two went)

- **`zk_extract`** → superseded by `obsidian_distill`. The `buildDistillTask`
  builder remains exported (CLI `zk-extract` + parity tests still use it) but no
  agent tool is registered under that name — call `obsidian_distill` directly.
- **`graph_health` / `healGraph`** → registered with `pi-agent-ext-obsidian` so
  the obsidian `garden` tool surfaces them. Logic still lives in
  `src/retrieve.ts` (`graphHealth` / `healGraph`).

## Pipeline (end-to-end)

```
WRITE ─► ingest: parse (.jsonl / auto-memory / hermes) → renderCard (1/record, dedup by id)
                       │
                       ▼        write card.md + ## 連結 (shared-tag neighbours) → regen MOC
                       │
READ  ─► retrieve: scan folder → parseFrontmatter each → rank (shared-tag + callout boost)
                       │
                       ▼        digest (gotchas/patterns/levers) → agent
                       │
AUDIT ─► graphHealth → healGraph (prune dead links, regen MOC, re-scan)
```

**Key invariant:** both WRITE paths land cards in the **same** folder
(`Zettelkasten/knowledge-graph`) so cross-source `[[edges]]` form by shared tags.
`zk_ask` ranks from `obsidian_search` (frontmatter not available until after
ranking → callouts *surfaced*, not boosted); `knowledge_query` reads frontmatter
at rank time → bounded callout boost applies. Drift-guarded by `retrieve.test.ts`.

## Architecture

- `extensions/pi-knowledge-card.ts` — the hub: tool registration, task-builder
  single source of truth (`buildAdd/Find/Update/Remove/Rag/DistillTask`), tool
  allowlists, vault resolution (delegates to pi-obsidian's multi-tier
  `resolveVault`).
- `src/` — deterministic library (no LLM): `ingest`, `retrieve`, `merge`,
  `emit`, `entities`, `similarity`, `semantic`, `host-fns`.

## Key Dependencies (verified `package.json`)

- `@repo/pi-agent-ext-obsidian` (hard peer) — vault access, `runSubagentWithRetry`
  legacy path, `parseFrontmatter` / `validateZettelNote` / index/graph helpers.
- `@repo/pi-agent-ext-workflow` (hard peer) — the **single spawn path** since ①
  (`createAgentSession` / `spawnSubagent`) and the host-fn registry for ②'s
  deterministic `call('zk.*')`.
- `pi-agent-cli` (reverse consumer) — hosts the `zk-extract` / `zk-card` /
  `zk-ask` / `zk-ingest` / `zk-query` commands and `knowledge-pipeline`.

> Note: `pi-agent-ext-power-tool` is **no longer a dependency** —
> `knowledge_query` + `graph_health` were migrated *from* power-tool *into* this
> hub (PR #351/#354, 2026-07-07). power-tool is self-contained diagnostics again.

## Integration roadmap — knowledge-card × workflow (in flight)

Four sub-projects converging the kcard onto the `workflow` extension's runtime
(see `.planning/kg-subagent-workflow-integration/design.md`):

| # | Sub-project | Status |
|---|-------------|--------|
| ① | Converge `zk_*` onto a single spawn path | ✅ Shipped (PR #545) |
| ② | Deterministic `call()` primitive (host-fn registry; `zk.retrieve/ingest/health/heal`) | ✅ Complete (`feat/kg-call-primitive`, 862+307 tests green) |
| ③ | Knowledge-aware workflow agentTypes + auto-primer | ⏳ Planned |
| ④ | Learning feedback loop → KG | ⏳ Planned |

## Use

```bash
# CLI
bun bun-apps/pi-agent-cli/src/cli.ts zk-ask "question"
bun bun-apps/pi-agent-cli/src/cli.ts zk-ingest <file.knowledge.jsonl>
bun bun-apps/pi-agent-cli/src/cli.ts zk-query --tags flux2,vae        # retrieve digest
bun bun-apps/pi-agent-cli/src/cli.ts zk-query --json                  # deterministic JSON
# Or via the extension (registers the 4 agent tools)
pi -e bun-apps/pi-agent-ext-knowledge-card
```

## Cross-reference

- [`docs/TOOL-ORCHESTRATION.md`](./docs/TOOL-ORCHESTRATION.md) — full dependency + data-flow graph (2026-07-10 snapshot; 2 tools since moved — see "Tool history" above)
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — module map, two ingestion modes
- [`docs/DATA-MODEL.md`](./docs/DATA-MODEL.md) — 12-key record → zettel schema
- [`docs/DEPENDENCIES.md`](./docs/DEPENDENCIES.md) — cross-package coupling graph
- [`docs/kg-improvement-plan.md`](./docs/kg-improvement-plan.md) — retrieval-improvement backlog (P1–P8; arc closed 2026-07-08)
- [`docs/SAG-LEARNINGS.md`](./docs/SAG-LEARNINGS.md) — entity/IDF study behind P8
- [`docs/PR-HISTORY.md`](./docs/PR-HISTORY.md) — knowledge-layer arc
