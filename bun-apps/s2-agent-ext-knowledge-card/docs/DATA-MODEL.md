# pi-knowledge-card — Data Model

> Snapshot: 2026-07-07 (post-PR #349). The two structured shapes this package
> transforms between: the **input record** (`.knowledge.jsonl` / auto-memory)
> and the **output card** (a zettel markdown file in the convergence folder).

## Transform at a glance

```
KnowledgeRecord (12-key .knowledge.jsonl line, OR adaptAutoMemoryMarkdown)
        │
        │  ingestRecords()  — deterministic, 1 record → 1 card
        ▼
Zettel card (.md)  ── frontmatter (id/created/tags + provenance + P1 features)
                   ── # Title
                   ── ## 核心想法   (the detail body)
                   ── ## 證據 / 脈絡 (evidence lines)
                   ── ## 連結      (computed shared-tag neighbours)
```

## Input — `KnowledgeRecord` (the 12-key schema)

Defined in `src/ingest.ts`. Emitted by every self-improve workflow as
newline-delimited JSON (`.knowledge.jsonl`). `parseKnowledgeJsonl` parses +
collects per-line errors (never throws); `adaptAutoMemoryMarkdown` produces the
same shape from an auto-memory topic file.

| Key | Type | Required | Notes |
| --- | ---- | -------- | ----- |
| `id` | string | ✅ | Canonical, namespaced (`ltx:cfg-scale-7-lever`, `auto-memory:pr-merge-sop`). Dedup key. |
| `type` | string | (default `pattern`) | `lever` · `avoid` · `pattern` · `gotcha` · `metric` · `false_positive` · `experience` · `event` · `case` · `preference` · `reference` (the generic adapter's neutral prose-page type, #2056) |
| `title` | string | ✅ | One-line hook (becomes the card H1). |
| `detail` | string | (default `""`) | The body — prose, callouts, tasks, embeds. |
| `tags` | string[] | (default `[]`) | Concept tags (normalised on ingest). |
| `dimension` | string \| null | (default null) | Split on `.`/`/` → extra tag parts. |
| `confidence` | number | (default 0) | 0–1. |
| `status` | string | (default `active`) | `active` · `superseded` · `retired`. |
| `superseded_by` | string \| null | (default null) | id of the replacement. |
| `schema_version` | number? | optional | Passed through. |
| `evidence` | object? | optional | `{occurrences?, first_seen?, last_seen?, run_ids?, extracted_at?}`. |
| `extracted_at` | string? | optional | Timestamp fallback for `created`. |

## Output — the zettel card

A markdown file at `<folder>/<slug(id)>.md` (default folder
`Zettelkasten/knowledge-graph`). `validateZettelNote` requires only `id` /
`created` / `tags` (+ `tags[0]=="zettel"`); **every other key is additive**.

### Frontmatter

```yaml
---
id: ltx:cfg-scale-7-lever          # == record.id (YAML-quoted; colon-bearing)
created: 2026-06-20                 # best-effort from evidence.first_seen / extracted_at
tags: [zettel, lever, cfg, ltx]     # tags[0] ALWAYS "zettel"; then type, record tags, dimension parts
sources: [workflow-jsonl:mlx-ltx]   # provenance labels
source: workflow-jsonl:mlx-ltx      # source family + label
source_id: ltx:cfg-scale-7-lever    # == id (explicit for scanners / dedup)
record_type: lever                  # the record type
status: active                      # active | superseded | retired
superseded_by: ""                   # id or empty
confidence: 0.93
dimension: quality                  # only when non-null
# ── P1 feature metadata (PR #349) — written ONLY when the body has the feature ──
has_callouts: true
callout_types: [warning, tip]
has_tasks: true
open_task_count: 2
embed_count: 1
code_block_lines: 14
---
```

> **Backward compatibility:** old cards without the P1 keys validate + retrieve
> unchanged. `readCardMeta` returns `hasCallouts: false` for them. Feature-less
> records ingest byte-identically to pre-#349 (the idempotency test guards this).

### Body sections (canonical, in this order)

```markdown
# <title>

## 核心想法
<detail body — prose, callouts, tasks; truncated at maxDetailChars (32KB)>

## 證據 / 脈絡
- type: <record.type>
- confidence: <n>
- status: <status>[ → superseded_by <id>]
- occurrences: <n>            (only when present)
- first_seen: <ts>            (only when present)
- last_seen: <ts>             (only when present)
- extracted_at: <ts>          (only when present)
- provenance: <sourceLabel>

## 連結
- 相關：[[<neighbour-slug>]]   (computed: shared-tag neighbours, top maxLinks=8)
- 相關：[[<neighbour-slug>]]
[- (no shared-tag neighbours yet)]   (when none)
```

The `## 連結` edges are **computed from shared-tag overlap** across the whole
folder (not from body wikilinks). `tags[0]=="zettel"` is excluded from the
ranking (it's ubiquitous). This is what makes the graph span sources — a flux2
gotcha and a krea2 gotcha sharing `path-safety` get a bidirectional edge.

## Derived artefacts

### The MOC — `Tags/Knowledge Graph.md`

Fully deterministic — regenerated from on-disk cards each ingest run (never
drifts; `graphHealth.mocStale` catches a card added without re-ingest). Groups
every card by `record_type`, then alphabetical.

```markdown
## gotcha
- [[flux2-argv-injection]]
- [[krea2-argv-injection]]
## lever
- [[ltx-cfg-scale-7-lever]]
```

### The digest — `retrieveRecords().digest`

A compact (≤~1500 char) grouped block injected into a workflow's Resolve phase.
Grouped by `record_type` (gotcha/avoid/lever/…), highest-shared first:

```
(graph: 3 cross-workflow card(s) for tags [argv, argparse])
[GOTCHA]
- Reject leading-dash argv — [!warning] it bypasses validation. — flux2 detail… (workflow-jsonl:flux2)
[LEVER]
- cfg=7 sharpens edges — … (workflow-jsonl:ltx)
```

The `[!warning] … —` prefix is the **P1 callout surfacing** (#349): the
highest-signal line lifted ahead of the truncated prose so it reaches the RAG
context instead of being buried in the body.

## Feature extraction (P1, `extractFeatures`)

Code-fence-aware: tasks/embeds inside ``` fences are NOT counted (they're code,
not prose).

| Feature | Detection | Frontmatter key(s) | Ranked? |
| ------- | --------- | ------------------ | ------- |
| Callouts | `^>\s*\[!(\w+)\]` lines | `has_callouts`, `callout_types` | ✅ +0.5 tie-break boost + digest surfacing |
| Tasks | `^[-*]\s+\[ \]` / `\[x\]` | `has_tasks`, `open_task_count` | ❌ (filter flag only) |
| Embeds | `![[...]]` (not `[[...]]`) | `embed_count` | ❌ (filter flag only) |
| Code density | lines inside ```/~~~ | `code_block_lines` | ❌ (recorded, not ranked) |

> Only callouts carry a retrieval *lever* (ranking + context). Tasks/embeds/code
> are recorded as filter flags but not ranked — deferred until a measurement
> says they help (kg-plan P1 scope discipline; resist adding all 9 vault-mind
> categories).

## File naming

`slugify(record.id)` → `<folder>/<slug>.md`. Namespace separators (`:`/`/`) →
`-`; lowercased; truncated to 80 chars. Re-ingest upserts in place (same slug);
slug collisions across different ids are disambiguated (`-2`, `-3`, …).
