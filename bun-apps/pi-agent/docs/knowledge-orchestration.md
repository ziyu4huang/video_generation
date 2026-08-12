# Knowledge-Building Orchestration

> **Status:** canonical as of 2026-07-08 (hermes→vault bridge closed, `.claude/memory` retired).
> One page: which knowledge store owns what, how a learning flows between them,
> and the regression assets that keep the pipeline sound. Companion to the
> retrieval-arc verdict in `bun-apps/pi-agent-ext-knowledge-card/docs/kg-improvement-plan.md` (recall is adequate;
> this doc is the *ingest* side).

## The three layers + their responsibilities

| Layer | Store (on disk) | Role | Write path | Read path |
| --- | --- | --- | --- | --- |
| **1. Working memory** (scratch) | `~/.pi/agent/pi-hermes-memory/{MEMORY,failures,USER}.md` + `projects-memory/<proj>/` + `sessions.db` | the agent's dense, hot, human-curated log of failures / corrections / insights / tool-quirks / preferences, written *during* sessions | `memory` tool (`add`/`replace`/`remove`) | `memory_search` (note: SQLite index **lags** the flat `.md` files — the `.md` is ground truth) |
| **2. Durable vault** (convergence) | `vaults_root/pi-agent-vault/Zettelkasten/knowledge-graph/` (492 cards) | the single human-readable, graph-linked card set where **every** source converges — one card per structured record, dedup'd by id, cross-linked by shared tags | `zk_ingest` (deterministic) + `obsidian_distill` (LLM decomposition) + `obsidian_create` (manual CRUD) | `zk_ask` (graph-enhanced RAG, the flagship recall path) + `knowledge_query` (deterministic digest) |
| **3. `.claude/memory/`** (retired) | — | **RETIRED 2026-07-08.** Was a Claude-Code convention orphan that no tool read and that still described the project as "ComfyUI on Apple Silicon" (deprecated). Its 4 topics were 100% duplicated by vault gotchas + the `Platform: Apple Silicon MPS` section in `CLAUDE.md`; nothing was lost. | — | — |

### The promotion flow

```
session insight
      │
      ▼  (memory tool: add/replace)
┌─────────────────────────┐
│ 1. working memory       │  ~/.pi/agent/pi-hermes-memory/*.md  (dense, hot, §-separated)
│    + .claude-glm/memo…  │  ~/.claude-glm/memory/*.md         (curated auto-memory topics)
└─────────────────────────┘
      │
      ▼  (zk_ingest --source <family>)   ← deterministic, idempotent convergence
┌─────────────────────────┐
│ 2. durable vault        │  Zettelkasten/knowledge-graph/    (graph-linked, human-readable)
│    one card per record  │   • workflow-jsonl  → parseKnowledgeJsonl   (self-improve loops)
│    dedup'd by id        │   • auto-memory     → adaptAutoMemoryMarkdown
│    cross-linked by tags │   • hermes          → adaptHermesMarkdown   (closed 2026-07-08)
└─────────────────────────┘
      │
      ▼  (zk_ask / knowledge_query)
   recall: graph-enhanced RAG answers cross-source questions for free
```

**The key property:** because every converged card lives in ONE folder and shares
ONE tag space, a flux2 gotcha, an auto-memory preference, and a hermes tool-quirk
that name the same concept get a `[[wikilink]]` edge automatically — and `zk_ask`
retrieves across all three sources in a single query.

## The three convergence sources (all now implemented)

| `--source` | Input | Adapter (`src/ingest.ts`) | Status |
| --- | --- | --- | --- |
| `workflow-jsonl` | `.claude/workflows/*.knowledge.jsonl` (12-key records) | `parseKnowledgeJsonl` | ✅ the main path |
| `auto-memory` | `~/.claude-glm/memory/*.md` (`name`/`description`/`metadata.type` frontmatter) | `adaptAutoMemoryMarkdown` | ✅ |
| `hermes` | `~/.pi/agent/pi-hermes-memory/{MEMORY,failures,USER}.md` (`§`-separated entries) | `adaptHermesMarkdown` | ✅ **closed 2026-07-08** |

### `adaptHermesMarkdown` — the mapping (mirrors `adaptAutoMemoryMarkdown`)

A hermes file holds MANY entries separated by a line containing only `§`. Each
entry → one `KnowledgeRecord`:

- `id` = `hermes:<slug>` (slug from the entry's first line; namespaced like the others)
- `type` = from the `[category]` prefix: `failure`→`avoid`, `correction`→`false_positive`, `insight`/`convention`/`preference`→`pattern`, `tool-quirk`→`gotcha` (no prefix → `pattern`)
- `title` = first line (bold markers + trailing date/`:` stripped), ≤120 chars
- `detail` = full entry body (prefix + `<!-- created=, last= -->` comment stripped; `[[wikilink]]` brackets stripped to plain text)
- `tags` = `[hermes, <category>, …[[wikilink]] slugs, …distinctive title-keyword slugs]` — the keyword harvest is what lets a hermes fp8 entry cross-link the existing `gotcha-fp8-compute-mps-crash` card
- `dimension` = category (or `general`)
- `confidence` = `0.9` (human-curated working memory)
- `evidence` = `{ first_seen, last_seen }` harvested from the timestamp comment

Defensive: malformed/empty/timestamp-only entries are skipped (never throws);
returns `[]` if nothing parses (the caller records a parse error).

## Wiki-aware convergence (the tight pipeline, 2026-07-09)

The convergence is **wiki-aware**: before minting a new card, each incoming
record is matched against EXISTING cards in the convergence folder (token-set
Jaccard over title + detail, threshold **0.85**). A match **upserts into the
existing canonical card** — appends the new source's evidence + bumps `last_seen`
— instead of creating a parallel duplicate. Only genuinely-new lessons mint a
new card. This is the Alluvium "add to the existing page, don't create a
parallel zoo" pattern.

The matcher lives in `src/similarity.ts` (`tokeniseText` + `jaccard` +
`bestMatch`), shared by both the wiki-aware ingest path and the duplicate
scanner (`mergeDuplicates`) so there is ONE notion of "same concept" across the
pipeline. It is deterministic (token-set overlap, NOT embeddings — embeddings
would re-open the closed semantic-retrieval question per #370).

### Canonical-id namespace policy (first-wins)

When two sources claim the same lesson (e.g. a `gotcha:` card and a
`pi-memory:` entry), the **existing canonical card wins** — its id, title, and
body are preserved; the later source only appends evidence (source label +
`wiki-merged:` provenance line + `last_seen` bump). This is conservative and
reversible: the canonical card keeps its identity, and the merge provenance is
visible in the `## 證據 / 脈絡` section.

The wiki-aware matcher is an **addition** to id-dedup, not a replacement: a
re-ingested record with the same id still upserts via the normal path. The
periodic `mergeDuplicates` (Jaccard ≥ 0.9) catches cross-namespace
near-dupes that slip past the 0.85 ingest gate.

## Where does a new learning go? (the decision rule)

- **A failure / correction / insight / tool-quirk discovered in a session** →
  `memory` tool (`add`) → working memory (`failures.md` / `MEMORY.md`). It is
  then **converged into the vault** by re-running `zk_ingest --source hermes`.
- **A curated, reusable topic** (auto-memory style, `name`/`description`) →
  `~/.claude-glm/memory/*.md` → `zk_ingest --source auto-memory`.
- **Structured self-improve findings** (the 12-key schema) → `.knowledge.jsonl`
  → `zk_ingest --source workflow-jsonl` (run by the self-improve loops).
- **Free-form prose to decompose into atomic notes** →
  `obsidian_distill` (LLM subagent) or manual `obsidian_create`.

## `memory transfer` vs `zk_ingest` — do not conflate

- **`memory transfer`** = a one-shot *move* of entries from working memory into
  the vault (frees space in `~/.pi/agent/`). Use when the working store is
  bloated.
- **`zk_ingest --source hermes`** = the **deterministic, idempotent,
  graph-converging** *copy* — working memory stays intact, and the vault cards
  are re-derived (upserted) every run. Use to (re-)converge after edits.

They are complementary. Re-running `zk_ingest` never deletes the source.

## Regression assets (re-run to catch drift)

```bash
# converge hermes working memory into the vault (idempotent — safe after any edit):
./pi-agent.sh cli zk-ingest --source hermes \
  --vault "$(pwd)/vaults_root/pi-agent-vault" \
  ~/.pi/agent/pi-hermes-memory/{MEMORY,failures,USER}.md )

# dry-run first to preview (TRUE idempotency probe: reports unchanged vs updated):
... zk-ingest --source hermes --dry-run ...

# recall regression (the retrieval arc, see bun-apps/pi-agent-ext-knowledge-card/docs/kg-improvement-plan.md + scripts/):
bun scripts/live-zk-ask-measure.mjs      # zk_ask hit-rate@4 baseline 0.64
bun scripts/real-retrieval-measure.mjs   # tag-path baseline 0.48
```

The eval set (`scripts/real-retrieval-eval.json`, 25 real queries) + the two
measure scripts are durable regression assets for the *recall* side; `zk_ingest`
is the asset for the *ingest* side.

## Honest caveats

- **Dedup is now wiki-aware.** The same lesson converging from two sources
  (different id namespaces) **upserts into one canonical card** (wiki-aware
  match, Jaccard ≥ 0.85) instead of creating parallel duplicates. Cross-namespace
  near-dupes that slip past the 0.85 ingest gate are caught by the periodic
  `mergeDuplicates` scan (Jaccard ≥ 0.9). See the wiki-aware section above.
  **Pre-existing** parallel cards from before the wiki-aware convergence
  (2026-07-09) are a separate optional follow-up (`zk-query --merge-duplicates
  --fix`), not auto-merged on ingest.
- **`memory remove` is unreliable** (returns success but often doesn't delete) +
  **the SQLite index lags** the flat `.md` files. Ground truth = the `.md` files.
  `zk_ingest` reads the `.md`, so re-convergence is always correct regardless.
- **Working memory is under concurrent modification** (other sessions /
  self-improve runs). `zk_ingest` reads + converges into a separate vault, so a
  mid-read edit just means a slightly stale snapshot — re-run to refresh.
