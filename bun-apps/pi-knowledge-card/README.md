# pi-knowledge-card

Zettelkasten knowledge-management tools for [pi](https://github.com/earendil-works/pi-coding-agent):
distill markdown into atomic notes, run CRUD over the vault, and ask graph-enhanced
RAG questions — each backed by an isolated subagent.

This package is the **single source of truth** for the task builders
(`buildDistillTask` / `buildAddTask` / `buildFindTask` / `buildUpdateTask` /
`buildRemoveTask` / `buildRagTask`) and the per-action tool allowlists
(`DISTILL_TOOLS` / `ADD_TOOLS` / `FIND_TOOLS` / `UPDATE_TOOLS` / `REMOVE_TOOLS` /
`CHECK_TOOLS` / `RAG_TOOLS`). The `bun-pi-agent-cli` commands `zk-extract`,
`zk-card`, `zk-ask`, and `zk-ingest` import these same builders (and the
deterministic ingest library) so the CLI and the extension never drift apart.

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

## Environment

| Variable                 | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `OB_VAULT_PATH` / `OB_VAULT_DIR` | Vault resolution (passed through to obsidian) |
| `OB_SUBAGENT_TIMEOUT_MS`  | Subagent timeout in ms (default `300000` = 5 min)   |

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
