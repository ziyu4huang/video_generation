# pi-knowledge-card

Zettelkasten knowledge-management tools for [pi](https://github.com/earendil-works/pi-coding-agent):
distill markdown into atomic notes, run CRUD over the vault, and ask graph-enhanced
RAG questions — each backed by an isolated subagent.

This package is the **single source of truth** for the task builders
(`buildDistillTask` / `buildAddTask` / `buildFindTask` / `buildUpdateTask` /
`buildRemoveTask` / `buildRagTask`) and the per-action tool allowlists
(`DISTILL_TOOLS` / `ADD_TOOLS` / `FIND_TOOLS` / `UPDATE_TOOLS` / `REMOVE_TOOLS` /
`CHECK_TOOLS` / `RAG_TOOLS`). The `s2-agent cli` commands `zk-extract`,
`zk-card`, `zk-ask`, and `zk-ingest` import these same builders (and the
deterministic ingest library) so the CLI and the extension never drift apart.

> **Architecture & dependencies** — see [`docs/`](./docs):
> - [`docs/TOOL-ORCHESTRATION.md`](./docs/TOOL-ORCHESTRATION.md) — visual
>   Mermaid dependency + data-flow diagram (6 tools, forward/reverse deps, two
>   read/write paths, the deterministic orchestration sequence).
> - [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — two ingestion modes,
>   4 tools, 4 src modules, data flow, load-bearing invariants.
> - [`docs/DEPENDENCIES.md`](./docs/DEPENDENCIES.md) — the cross-package graph
>   (pi-obsidian hard peer; s2-agent + power-tool hard workspace;
>   pi-hermes-memory optional peer) + the **two read paths** (retrieveRecords
>   vs zk_ask) and why the P1 callout boost is retrieveRecords-only.
> - [`docs/DATA-MODEL.md`](./docs/DATA-MODEL.md) — the 12-key record → zettel
>   card frontmatter (incl. P1 feature keys) + MOC + digest.
> - [`docs/PR-HISTORY.md`](./docs/PR-HISTORY.md) — the knowledge-layer arc
>   (#152 → #349).

## Two ingestion modes

| Mode | Tool | Backed by | When |
| ---- | ---- | --------- | ---- |
| **LLM distill** | `zk_extract` | an isolated subagent (`obsidian_distill`) | free-form markdown/text → atomic notes |
| **Deterministic ingest** | `zk_ingest` | `src/ingest.ts` (no LLM, no network) | structured `.knowledge.jsonl` records → one card each |

`zk_ingest` is the **convergence sink**: it dissolves the per-workflow
`.knowledge.jsonl` silos into ONE shared, queryable, backlinked graph. Every
record becomes a zettel card (dedup'd by canonical id, cross-linked by shared
tags, indexed by a Knowledge Graph MOC) so `zk_ask` can answer cross-source
questions. See `src/ingest.ts` for the schema mapping + `src/emit.ts` for the
in-session `pi:knowledge` event-bus contract that lets any extension publish.

**Source families** (`source` param selects the adapter; default `workflow-jsonl`):

| `source`        | Input shape                                  | Adapter                    |
| --------------- | -------------------------------------------- | -------------------------- |
| `workflow-jsonl`| `.knowledge.jsonl` (12-key records)          | `parseKnowledgeJsonl`      |
| `hermes`        | `.md` with `§`-separated entries + `[cat]`   | `adaptHermesMarkdown`      |
| `auto-memory`   | `.md` with `name`/`description` frontmatter  | `adaptAutoMemoryMarkdown`  |
| `generic`       | **ANY `.md`** (no assumptions; universal)    | `adaptGenericMarkdown`     |

`generic` is the **universal adapter**: point `zk_ingest` at any random folder of
`.md` files and every file becomes a converged card (title from H1 or filename,
tags harvested from frontmatter + `#hashtags` + `[[wikilinks]]`, type inferred
from callouts `[!warning]`→`avoid`, confidence 0.7). It makes the whole
`memory → obsidian → kcards` distill event accept arbitrary markdown:

```
zk_ingest source:generic dir:<any-md-folder>   # deterministic convergence
# optional LLM enrichment first:  obsidian distill files:[<folder>]
# then query cross-source:        zk_ask / knowledge_query
```

## Requires

- **[pi-obsidian](../pi-obsidian)** must be available in the same session — the
  tools spawn subagents (via `runSubagentWithRetry` from pi-obsidian) that load
  the obsidian tool set (`obsidian_read`, `obsidian_search`, `obsidian_distill`,
  `obsidian_garden`, …). Without pi-obsidian, the subagents have nothing to call.

## Tools

### `zk_extract`

Decompose markdown/text files into atomic Zettelkasten notes in the Obsidian
vault. Internally delegates to `obsidian_distill` via an isolated subagent. Each
input file is split into self-contained note cards (one idea per note) with
frontmatter, wiki-links to related notes, and tags.

| Parameter        | Type       | Default      | Notes                                            |
| ---------------- | ---------- | ------------ | ------------------------------------------------ |
| `files`          | `string[]` | _(required)_ | Paths to markdown/text files (abs or rel to cwd) |
| `folder`         | `string`   | `Zettelkasten` | Vault folder for new notes                       |
| `max_notes`      | `number`   | _(unset)_    | Approximate cap on total notes (`minimum: 1`)    |
| `model`          | `string`   | pi default   | Override distill subagent model (`provider/id`)  |
| `exclude_tools`  | `string[]` | _(unset)_    | Tool names to deny the subagent                  |

### `zk_card`

CRUD operations on Zettelkasten vault notes.

| Action   | Description                                                                 |
| -------- | --------------------------------------------------------------------------- |
| `add`    | New note with a 4-layer duplicate check (title / body / tags / comparison)  |
| `find`   | Multi-strategy search (title fuzzy > tag > body keyword)                    |
| `update` | Smart-merge content into an existing note (skip-dup, append, union tags)    |
| `remove` | Backlink-safe delete (aborts if inbound links exist, unless `force`)       |
| `check`  | Vault health audit: duplicates, orphans, dead links, unlinked related notes |

`force` bypasses the duplicate threshold (`add`) or deletes even with backlinks
(`remove`). When `add --force` is used, the created note is tagged
`#duplicate-candidate` with `force_inserted: true` and a `duplicate_candidates`
list recorded in frontmatter for traceability.

### `zk_ask`

Graph-enhanced RAG over the Zettelkasten vault. Pipeline:

1. **Seed retrieval** — 3 strategies (fuzzy title + tag + body keyword), with an
   optional seed quality gate that rewrites the query once if the top seed scores
   below 0.4 (disable with `no_refine`).
2. **Graph expansion** — N-hop wiki-link traversal (`obsidian_search graph:"neighbors"`),
   progressive deepening up to `depth`, capped at `max_neighbors` per seed per hop.
3. **Cluster & rank** — deterministic score `0.7×search_score + 0.3×link_count`,
   take top `top_k`.
4. **Context assembly** — 2-tier: full read (truncated to `max_note_tokens`) for
   the top few / high-score notes, snippet-only for the rest.
5. **Generate** — synthesized answer in Traditional Chinese with a reference list
   (`retrieve_only` skips generation and returns the assembled context instead).

> **Note on `max_note_tokens`:** the token cap is enforced by instructing the
> subagent; it is best-effort, not a hard tool-level limit.

### `knowledge_query` · `graph_health` (the hub's direct no-LLM surface)

Two deterministic tools that wrap `src/retrieve.ts` directly — **no subagent,
no LLM, no network** — so they're cheaper than the `zk_*` tools and work as a
fast read/audit path. These were migrated from `s2-agent-ext-power-tool` so the
hub owns every agent-facing knowledge tool (consolidation cycle, 2026-07-07).

| Tool | Description |
| ---- | ----------- |
| `knowledge_query` | Cross-workflow tag-ranked digest over the convergence folder. `tags[]` (ANY semantics) OR a natural-language `query` (tokenized into tags). Returns the grouped digest — the same one `zk-query` (CLI) produces. |
| `graph_health` | Audit + auto-heal the convergence-folder graph: dead wiki-links, MOC drift, orphans. `fix: true` auto-heals (regenerate MOC + prune dead links, scoped — never touches human-authored cards). |

## Environment

| Variable                 | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `OB_VAULT_PATH` / `OB_VAULT_DIR` | Vault resolution (passed through to obsidian) |
| `SUBAGENT_TOKEN_BUDGET_DISABLE` | Set `1` to strip the role-aware dispatch envelopes (see below). |
| `KC_SUBAGENT_MODEL`       | Model for the subagent-backed tools (`zk_card`, `zk_ask`). Default `prism-ml/bonsai-27b` (local LM Studio — keeps LLM spend off the cloud bill). Per-call override via each tool's `model` arg. Does **not** honor the sibling `OB_SUBAGENT_MODEL`. |

zk_card / zk_ask spawn through `roleAwareDirectCall` (in-process `spawnSubagent`): zk_card runs the **writer** envelope (400k tokens / 28 turns / 20 min — children write notes), zk_ask the **recon** envelope (120k / 12 / 5 min — retrieve + synthesize). The old `OB_SUBAGENT_TIMEOUT_MS` knob never applied to these in-process spawns — it belongs to the obsidian package's subprocess runner (distill/garden wall clock, now 20 min).

## Install

This is a pi package. After `bun install` at the monorepo root, register it via
pi's settings (see the repo's `AGENTS.md` / `.pi/settings.json`).

## Tests

```bash
bun test        # from this package dir
```

The suite has no live subagent/LLM dependency:

- `pi-knowledge-card.test.ts` — pins the pure task-builder output (all branches
  of `buildRagTask` etc.), the per-action validation early-returns, and tool
  registration.
- `allowlists.test.mjs` — **cross-package contract guard**: loads the real
  pi-obsidian extension and asserts every `obsidian_*` tool named in the
  allowlists is actually registered there. A rename/removal in pi-obsidian that
  would otherwise silently break this extension's subagents (the tool is just
  absent at run time) is caught at test time — no hand-maintained name list.
- `toolWiring.test.mjs` — mocks `runSubagentWithRetry` + `resolveVault` and
  asserts each `execute()` happy path wires the correct
  `(task, toolsCsv, tmpPrefix, opts)` into the runner and shapes the result
  (vault header, timeout, soft-success on exit≠0 with output) the right way.

## License

MIT
