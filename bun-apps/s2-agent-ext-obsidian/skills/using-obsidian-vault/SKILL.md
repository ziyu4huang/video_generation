---
name: using-obsidian-vault
description: |
  Use when capturing, searching, editing, or managing notes in the project
  Obsidian vault — note down / journal / record to Obsidian, where captures go
  (Inbox/Design/Daily/Zettelkasten), linking & naming conventions, and selecting
  among the obsidian actions (list/read/create/append/append_section/search/
  query/move/rename/update_frontmatter/delete/open/distill/garden/status). This
  is the TIER-0 foundation: raw vault I/O only.
---

# Using the Obsidian Vault

Conventions for the project-local Obsidian vault provided by the
`s2-agent-ext-obsidian` extension — raw vault I/O (the TIER-0 foundation
layer). This skill documents ONLY this layer's own actions; it does not
describe components built on top of it.

## Vault resolution

The vault resolves in 3 tiers: Tier 1 explicit (`OB_VAULT_PATH` env or
`run-dir/obsidian_config.json`), Tier 2 the vault open in the Obsidian app,
Tier 3 a project-local `<cwd>/vault/` folder (**auto-seeded** from
`vault-template/` on first use). Run `/obsidian-config` or call `obsidian status`
to see which vault is active and switch it. **Call `obsidian status` before any
vault write** when unsure which vault is in use.

**Commands:** `/obsidian [note]` (open), `/obsidian-init` (register with app),
`/obsidian-config` (show / set / `--use-app` / `--list` / `--clear`).

## Conventions

1. **Default capture location:** `Inbox/`. Move notes out only when the user
   explicitly asks for a structured note (design doc, daily, zettel).
2. **Link aggressively:** wiki-links `[[Target]]` to connect related notes.
   Prefer the note's basename without `.md`.
3. **Design docs** → `Design/` (template: Context / Goals / Options / Decision / Log).
4. **Daily notes** → `Daily/<YYYY-MM-DD>.md`.
5. **Zettelkasten notes** → `Zettelkasten/` — one atomic idea per card,
   frontmatter with an `id` (timestamp) and topic `tags`, plus a `## 連結`
   section holding ≥1 wiki-link to a related/parent note.
6. **Append, don't rewrite:** when adding to an existing note, prefer
   `append_section` under a heading. Pass the **bare heading text** (e.g.
   `Log`), NOT the rendered `## Log` — the matcher strips only one leading `#`,
   so a `## ` prefix fails to match and creates a malformed duplicate section.
7. **Keep the MOC current:** after creating a note, add its wiki-link to the
   matching `#tag` section in `Tags/Index.md` via `append_section`.
8. **Path safety:** never write outside the vault. All paths are vault-relative.

## Note-naming conventions

- Zettelkasten titles: `Topic — Subtopic` (em-dash) for consistency.
- Avoid mixing `:`, `-`, `—` randomly within the same area.
- `obsidian garden` flags titles that deviate from the dominant style.

## Tool-selection decision tree (obsidian actions)

Prefer `query` → `search` (with `paths`) over reading full notes. Only `read`
when you know the exact note.

| Intent | Action |
|--------|--------|
| Find notes by tag/folder/date (no body needed) | `query` (cheap, index-only) → then `search` with `paths` |
| Full-text content match | `search` (substring/regex/words/fuzzy) |
| "Who links to X" / "what does X link to" / orphans / dead links | `search` with `graph:` |
| Meaning-based (vector) retrieval | `semantic_search` |
| Read one note fully | `read` |
| User says "note this down" | `create` into `Inbox/` |
| Add a log line / event | `append_section` under `Log` (bare heading text) |
| Rename / relocate a note | `move` (auto-rewrites inbound links) |
| Add a tag without editing body | `update_frontmatter` |
| Show the user a note | `open` |
| List what exists | `list` |
| Decompose free-form markdown into atomic notes | `distill` (LLM subagent) |
| Audit/repair vault health (orphans, broken links, MOC drift) | `garden` |

Call the `obsidian_help` tool for the full per-action reference (params,
constraints) — it is the on-demand expansion of the terse action list.

## Analyze / summarize the vault

Two complementary approaches:

1. **Interactive (in pi)** — call `garden` (audit: orphans / broken links / MOC
   drift) and `query` (filter by tags/folder/date) to reason about vault health.

2. **Batch (bun scripts)** — read-only, works offline:

   ```bash
   bun run scripts/vault-graph-export.mjs --format mermaid --out out/vault-graph.mmd
   bun run scripts/vault-summarize.mjs --out out/vault-report.md
   bun run scripts/vault-summarize.mjs --tag zettel --llm   # focus + semantic summary
   ```
