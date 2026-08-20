# PRD: `zk-ask` command — Vault Question Answering

**File**: `src/cli/commands/zk-ask.ts`
**Command**: `s2-agent cli zk-ask <question>`
**Status**: All 4 enhancements implemented; task builder + tool allowlist moved to `packages/pi-knowledge-card` (single source of truth).

---

## Problem

`zk-card find` returns individual notes matching a query — good for lookup, but
insufficient for answering conceptual questions that require synthesizing related
ideas spread across multiple notes. Zettelkasten vaults are designed around links;
ignoring graph structure means ignoring the primary knowledge signal.

---

## Goal

Ask a natural language question; receive a synthesized prose answer grounded in
vault notes, retrieved via graph traversal rather than simple keyword matching.
One query → coherent answer citing multiple interconnected notes.

---

## When to use (agent guidance)

| Command | Use when |
|---|---|
| `zk-ask` | You need a synthesized answer to a question ("How does X work?", "What is the relationship between A and B?") |
| `zk-card find` | You need to locate specific notes or raw content by keyword |
| `zk-card check` | You need to verify vault health or list all notes |

---

## Non-Goals

- Does **not** replace `zk-card find` — no duplicate search logic
- Does **not** add new obsidian tools — graph expansion uses existing
  `obsidian_search graph:"neighbors"` parameter
- Does **not** write to the vault (read-only)

---

## Output

- **Default**: prose answer in zh-TW, grounded in vault notes, followed by a
  reference list of source notes (title + path + one-line reason for inclusion)
- **`--retrieve-only`**: structured context only (title, path, content per note);
  no generation step

---

## CLI API

```bash
zk-ask <question>                        # retrieve + generate answer
zk-ask <question> --retrieve-only        # show assembled context, skip generation
zk-ask <question> --depth <n>            # graph hop depth (default: 2)
zk-ask <question> --max-neighbors <n>    # max neighbor nodes per seed per hop (default: 5)
zk-ask <question> --top-k <n>            # max notes in context (default: 8)
zk-ask <question> --max-note-tokens <n>  # max tokens per note in full-read tier (default: 2000)
zk-ask <question> --summarize            # summarize each tag cluster before generating
zk-ask <question> --no-refine            # skip seed quality gate
zk-ask <question> --folder <name>        # restrict seed search scope
zk-ask <question> --blend three-way      # semantic + lexical + graph (needs vault-mind)
zk-ask <question> --blend semantic-lexical # semantic + lexical, NO graph (iter-4)
```

All pi-global flags apply: `--model`, `--vault`, `--mode json`, etc.

### `--blend` retrieval modes

| Mode | Seed strategies | Rank score | Tools |
|------|-----------------|------------|-------|
| `default` (the default) | title fuzzy + tags + body (`obsidian_search`) + graph neighbors | `0.7 × lexical + 0.3 × link_count` | `obsidian_search/query/read/list` |
| `three-way` | adds `obsidian_semantic_search` (vault-mind vector) as a 4th seed | `0.4 × semantic + 0.3 × lexical + 0.3 × link_count` | + `obsidian_semantic_search` |
| `semantic-lexical` | same 4-strategy seed, but graph expansion dropped (Step 2 skipped) | `0.55 × semantic + 0.45 × lexical` (no link term) | + `obsidian_semantic_search` |

The default mode is unchanged from the original design (no regression). Three-way
rebalances so the vector seed leads but cannot dominate — a strongly-graph-linked
card both text modes miss still ranks. Three-way requires the vault-mind service
(`VAULT_MIND_BASE_URL`, default `127.0.0.1:8000`) and the vault indexed there; if
semantic search errors (service down), the pipeline falls back to the 3 lexical
strategies and never aborts. Under `--retrieve-only --blend three-way`, each
reference is tagged with its source mode(s) (`semantic`, `lexical:*`, `graph`).

`semantic-lexical` (iter-4) isolates the semantic win from **graph-neighbor
dilution**: `link_count` is a popularity signal — it boosts heavily-linked cards
regardless of query relevance, so off-topic graph neighbors drag down the
three-way top-k on paraphrase / cross-lingual queries where semantic retrieval is
the whole point. Dropping graph entirely (Step 2 skipped, no link term) gives the
cleanest semantic-vs-lexical comparison; the measured trade-off lives alongside
the `retrieval-quality-self-improve` receipts. Reference tags are `semantic` /
`lexical:*` only (no `graph`).

### Default-flip decision (iter-5 full-vault measurement)

**Default stays `default` (lexical + graph). `semantic-lexical` remains opt-in.**

Full-vault measurement (run `run-mr840sic`, 2026-07-05, 425 knowledge-graph cards,
5 adversarial queries, blind LLM judge, `top-k=4`, `thinking=medium`, both modes
live — `semanticLive=5/5`):

| Mode | Mean relevance@4 | Wins | Notable |
|---|---|---|---|
| `default` (lexical+graph) | **0.802** | 4/5 | Q3 UI-hot-reload 1.00 vs 0.75; Q5 CLI-options 0.85 vs 0.50 |
| `semantic-lexical` | 0.640 | 1/5 (a 1.00–1.00 tie) | Never beat lexical outright |

Lexical body-search matches the English/mixed-language terms in this codebase +
knowledge-graph corpus well, so semantic-lexical underperforms here. This matches
the iter-4 controlled-corpus result (lexical near ceiling at 80% on 24 cards) and
the honest-uncertainty prediction: **semantic-lexical wins only on pure
cross-lingual / paraphrase subsets**, not on the default English-leaning vault.
Flipping the default is therefore not justified by the data; keep `--blend
semantic-lexical` as the opt-in for cross-lingual / anti-lexical-dilution use.

### Cross-lingual regime test (iter-6)

**The predicted cross-lingual win zone did NOT materialize.** The iter-5
prediction was that semantic-lexical would win when queries are in a different
language from the cards (zh-TW queries → English cards), because lexical search
cannot bridge the vocabulary gap. The iter-6 measurement **refutes** this:

Cross-lingual measurement (run `2026-07-05T22-57-51`, 425 English
knowledge-graph cards, 5 **zh-TW** adversarial queries, overlap-gated,
blind LLM judge, `top-k=4`, `thinking=medium`, `semanticLive=5/5`):

| Mode | Mean relevance@4 | Wins | Notable |
|---|---|---|---|
| `default` (lexical+graph) | **0.332** | 2/5 | Q3 bundle-size 1.00 vs 0.00 (found bun-isolated-linker card) |
| `semantic-lexical` | 0.100 | 1/5 | Q5 HMR-stale-bundle 0.50 vs 0.33 (only outright win) |

Even with pure zh-TW queries and zero lexical vocabulary overlap with the
English card titles/tags (enforced by the iter-6 adversarial-overlap gate),
default (lexical+graph) STILL beats semantic-lexical. The reason: **dropping
graph expansion hurts more than the semantic seed helps** — graph links bridge
concepts across languages better than vector similarity alone, and the
lexical body-search still finds CJK substrings inside English card bodies
that happen to mention the concept. Semantic-lexical is therefore not
recommended for any measured regime on this vault.

### Regime guidance summary

| Regime | Recommended blend | Rationale |
|---|---|---|
| Default (English-leaning vault, mixed queries) | `default` | iter-5: 0.802 vs 0.640, lexical wins 4/5 |
| Cross-lingual (zh-TW queries → English cards) | `default` | iter-6: 0.332 vs 0.100, lexical wins 2/5 — graph bridges better than semantic |
| Anti-lexical-dilution (diagnostic only) | `semantic-lexical` | No measured regime where it wins outright; keep as a diagnostic, not a recommendation |

The blend score is a pure exported function `rankBlendScore(parts, mode)` in
`pi-knowledge-card/extensions/knowledge-card.ts` — unit-tested in
`__tests__/blend.test.ts`, re-used by the `retrieval-quality-self-improve`
engine workflow to prove (or refute) blend > lexical with a blind judge.

---

## Architecture: Single Agent Session, 5-Stage Task Prompt

One `createSharedSession` call; all stages execute as LLM tool calls within it.

```
Stage 1  Seed retrieval
         obsidian_search fuzzy/title + words/tags + words/body → top-3 seeds
         Seed quality gate: if top seed score < 0.4, LLM rewrites query with
         synonyms/keywords and retries once (--no-refine skips this gate)

Stage 2  Graph expansion
         obsidian_search graph:"neighbors" per seed, up to depth N
         Progressive: depth-1 first; only go deeper if node count < topK
         Cap: maxNeighbors nodes per seed per hop
         → expanded node set (deduplicated)

Stage 3  Cluster & rank
         score = 0.7 × search_score + 0.3 × link_count
         search_score from obsidian_search result field (fallback: 0.5)
         link_count = [[wikilink]] occurrences in note body
         → top-K notes, grouped by tag

Stage 4  Context assembly (2-tier)
         Tier 1 (full read): top-3 notes or score ≥ 0.7 → obsidian_read,
                             truncated to maxNoteTokens tokens
         Tier 2 (snippet):   remaining notes → use obsidian_search snippet,
                             skip obsidian_read
         [--summarize] → per-cluster 1–2 paragraph summary

Stage 5  Generate / Output
         Default: LLM answers <question> grounded in context (zh-TW)
         [--retrieve-only]: outputs context only, skips generation
         Always appends: "Reference notes" list with per-note rationale
```

---

## Tool Allowlist

```typescript
// Defined in packages/pi-knowledge-card/extensions/knowledge-card.ts
RAG_TOOLS = [
  "obsidian_search",   // seed (fuzzy/words) + graph expansion (neighbors)
  "obsidian_query",    // tag/metadata seed queries
  "obsidian_read",     // context assembly (Tier 1 only)
  "obsidian_list",     // optional listing
]
```

Identical to `FIND_TOOLS` — graph expansion is a parameter
(`graph:"neighbors"`), not a separate tool.

---

## Single Source of Truth (packages/pi-knowledge-card)

The task builder and tool allowlist are **not** local to this command. They live
in `packages/pi-knowledge-card/extensions/knowledge-card.ts`, which is the
shared source for both the `zk_ask` pi-extension tool and this CLI command. This
file imports them so the CLI and the extension never drift apart:

```typescript
import { buildRagTask, RAG_TOOLS } from "pi-knowledge-card/extensions/knowledge-card.ts";
```

| Concern | Decision |
|---|---|
| Task prompt + allowlist | Imported from `pi-knowledge-card` — single source of truth shared with the `zk_ask` extension tool. |
| Session runner | Delegates to the shared `runPrettyTask` / `runJsonTask` in `src/cli/sessions/task-runner.ts` (same runners as `zk-extract` / `zk-card`). |
| NDJSON mode | `runJsonTask` — shared, emits `{ type: "error" }` on failure. |

---

## Pure Function

```typescript
// Exported from packages/pi-knowledge-card/extensions/knowledge-card.ts
buildRagTask(
  query: string,
  depth: number,
  topK: number,
  summarize: boolean,
  retrieveOnly: boolean,
  maxNeighbors: number = 5,
  maxNoteTokens: number = 2000,
  noRefine: boolean = false,
  folder?: string,
): string
```

No I/O. All flags are parameters. Unit-tested in the package test suite.

---

## args.ts Additions

```typescript
depth?: number          // --depth <n>             (numeric, default 2)
maxNeighbors?: number   // --max-neighbors <n>     (numeric, default 5)
topK?: number           // --top-k <n>             (numeric, default 8)
maxNoteTokens?: number  // --max-note-tokens <n>   (numeric, default 2000)
retrieveOnly?: boolean  // --retrieve-only         (boolean)
summarize?: boolean     // --summarize             (boolean)
noRefine?: boolean      // --no-refine             (boolean)
folder?: string         // --folder <name>         (string, optional)
```

---

## Test Coverage

`packages/pi-knowledge-card/__tests__/pi-knowledge-card.test.ts` — the RAG
builder is covered as part of the package suite (65 tests total, 0 failures).

- Query embedded in task
- All 3 seed strategies present
- `graph:"neighbors"` + correct depth value
- `--top-k` embedded in rank step
- Generate vs retrieve-only output instruction
- `--summarize` vs raw content instruction
- Referenced notes footer always present
- Flag combinations (retrieve-only + summarize)
- All 5 steps present in task string
- **Enhancement 1**: scoring formula (search_score, link_count, 0.7/0.3 weights, 0.5 fallback)
- **Enhancement 2**: progressive deepening (depth-1/depth-2), maxNeighbors cap
- **Enhancement 3**: 2-tier Stage 4 instruction (score ≥ 0.7 threshold, Do NOT call obsidian_read), maxNoteTokens in truncation instruction
- **Enhancement 4**: seed quality gate present by default (0.4 threshold, max 1 retry), suppressed by noRefine=true

---

## Design Decisions

**Single session over multi-session**: one agent session with a structured 5-stage
task. The LLM executes tools (obsidian_search, obsidian_read) in sequence.
Avoids inter-session data passing complexity; lower latency.

**No new tools**: `obsidian_search graph:"neighbors"` already provides N-hop
neighborhood traversal via the existing extension. No pi-obsidian changes needed.

**Clustering by tag**: tags in Zettelkasten encode semantic categories; grouping
by tag produces coherent clusters for per-cluster summarization.

**`--depth` default 2**: 1-hop = direct neighbors (similar to find), 2-hop = the
"friends of friends" layer where Zettelkasten ideas typically connect across topics.
3+ is available for broad conceptual queries.

**Deterministic scoring (E1)**: `score = 0.7 × search_score + 0.3 × link_count`.
Both signals are available without extra tool calls. Replaces pure LLM judgment
with a reproducible formula, making ranking explainable and debuggable.

**Progressive deepening (E2)**: depth-1 first, proceed to depth-2+ only if the
node count is below topK. Prevents exponential expansion in dense vaults without
sacrificing recall for sparse graphs.

**Snippet-first assembly (E3)**: full `obsidian_read` only for top-3 notes or
score ≥ 0.7; remaining notes use the search snippet directly. Prevents context
window burn from low-signal notes. `--max-note-tokens` caps token usage per
full-read note (default 2000).

**Seed quality gate (E4)**: if the top seed score is below 0.4, the LLM rewrites
the query with synonyms/keywords and retries Stage 1 once. Addresses the
"garbage in, garbage out" failure mode when vault terminology differs from the
user's phrasing. `--no-refine` skips this for fast/precise queries.
