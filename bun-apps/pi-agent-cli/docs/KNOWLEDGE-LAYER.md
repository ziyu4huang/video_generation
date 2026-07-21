# pi-agent-cli — Knowledge-Layer Role

> The 5 `zk-*` commands are **thin shells** over
> [`pi-knowledge-card`](../../pi-knowledge-card). All logic (task builders,
> deterministic ingest/retrieve/merge) lives there; the CLI commands only parse
> args + wire a single-turn agent run. **CLI and extension never drift** because
> they import the same builders.

## The 5 commands and what they import

| Command | Imports from `pi-knowledge-card/...` | Does |
| ------- | ------------------------------------ | ---- |
| `zk-ask` | `buildRagTask`, `ragToolsFor`, `BlendMode` ← `extensions/knowledge-card.ts` | graph-enhanced RAG answer (obsidian_search seed → graph expand → rank → generate) |
| `zk-card` | `buildAddTask` / `buildFindTask` / `buildUpdateTask` / `buildRemoveTask` + allowlists ← `extensions/knowledge-card.ts` | CRUD over vault notes |
| `zk-extract` | `buildDistillTask` + `DISTILL_TOOLS` ← `extensions/knowledge-card.ts` | LLM distill of free-form markdown → atomic notes |
| `zk-ingest` | `ingestRecords`, `parseKnowledgeJsonl`, `adaptAutoMemoryMarkdown`, `formatSummary` ← `src/ingest.ts` | deterministic convergence of `.knowledge.jsonl` / auto-memory → cards |
| `zk-query` | `retrieveRecords`, `graphHealth`, `formatHealth`, `mergeDuplicates`, `formatMerge` ← `src/retrieve.ts` + `src/merge.ts` | cross-workflow tag-ranked digest + graph health |

## Coupling

`pi-knowledge-card` is a **hard `workspace:*` dep** (static import). Renaming an
exported builder/function breaks the CLI at build time — caught by `bun test`
(248 tests). The retrieval-quality self-improve workflow
(`workflows/retrieval-quality-self-improve.js`) drives `zk-ask --retrieve-only`
to measure blend modes; the measurement scripts live in `../../scripts/`
(`iter4-measure.mjs`, `controlled-corpus.mjs`, `p1-feature-measure.mjs`).

## The two read paths (important)

`zk-ask` and `zk-query` are **different retrieval mechanisms**, not aliases:
- **`zk-query`** (`retrieveRecords`) — deterministic, in-process, shared-tag
  ranking + the P1 callout boost + digest. Used by the `knowledge_query` tool
  too. No LLM.
- **`zk-ask`** (`buildRagTask`) — agent graph-RAG (obsidian_search seed +
  N-hop wiki-link expansion + LLM synthesis). Score `0.7×search + 0.3×links`.

See `../../pi-knowledge-card/docs/ARCHITECTURE.md` § "Data flow" for why the P1
callout boost is `retrieveRecords`-only.

## Cross-links

- Canonical dependency graph: [`../../pi-knowledge-card/docs/DEPENDENCIES.md`](../../pi-knowledge-card/docs/DEPENDENCIES.md)
- Architecture: [`../../pi-knowledge-card/docs/ARCHITECTURE.md`](../../pi-knowledge-card/docs/ARCHITECTURE.md)
- Data model: [`../../pi-knowledge-card/docs/DATA-MODEL.md`](../../pi-knowledge-card/docs/DATA-MODEL.md)
- PR history: [`../../pi-knowledge-card/docs/PR-HISTORY.md`](../../pi-knowledge-card/docs/PR-HISTORY.md)
