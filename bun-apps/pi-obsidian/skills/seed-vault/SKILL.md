---
name: seed-vault
description: |
  Conventions for the project-local Obsidian vault provided by the pi-obsidian
  extension. Use when the user asks to "note down", "record to Obsidian",
  "journal", or manage knowledge in the vault.
---

# Seed Vault Skill

This project uses the `pi-obsidian` extension, which resolves a vault in 3
tiers: Tier 1 explicit (`OB_VAULT_PATH` env or `.pi/obsidian_config.json`),
Tier 2 the vault currently open in the Obsidian app, Tier 3 a project-local
`<cwd>/vault/` folder (auto-seeded on first use). Run `/obsidian-config` (or
the `obsidian_status` tool) to see which vault is active and switch it. The
following tools are available:

- `obsidian_list` — list notes under a folder
- `obsidian_read` — read a note
- `obsidian_create` — create / overwrite a note
- `obsidian_append` — append text to a note
- `obsidian_append_section` — insert text under a heading
- `obsidian_search` — full-text search
- `obsidian_open` — open a note or the vault in Obsidian
- `obsidian_status` — show the active vault, its resolution source, and all candidates

**Commands:** `/obsidian [note]` (open), `/obsidian-init` (register with the
app), `/obsidian-config` (show / set / `--use-app` / `--list` / `--clear`).

## Conventions

1. **Default location for captures:** `Inbox/`. Move notes out only when the
   user explicitly asks for a structured note (e.g. a design doc).
2. **Link aggressively:** use wiki-links `[[Target]]` to connect related notes.
   Prefer the note's basename without `.md`.
3. **Design docs** go in `Design/` and follow the `Templates/Design Note` shape
   (Context / Goals / Options / Decision / Log).
4. **Daily notes** go in `Daily/<YYYY-MM-DD>.md` based on `Templates/Daily Note`.
5. **Zettelkasten notes** go in `Zettelkasten/` and follow the
   `Templates/Zettelkasten Note` shape — one atomic idea per card, frontmatter
   with an `id` (timestamp) and topic `tags`, plus a `## 連結` section holding
   at least one wiki-link `[[Target]]` to a related or parent note.
6. **Append, don't rewrite:** when adding to an existing note, prefer
   `obsidian_append_section` under a heading (e.g. `## Log`) to avoid clobbering
   prior content.
7. **Keep the MOC current:** after creating a note, add its wiki-link to the
   matching `#tag` section in `Tags/Index.md` via `obsidian_append_section`.
8. **Path safety:** never write outside the vault. All paths are vault-relative.

## When to use which tool

| Intent | Tool |
|--------|------|
| Find notes by tag/folder/date (no body needed) | `obsidian_query` (cheap, index-only) → then `obsidian_search` with `paths` |
| Full-text content match | `obsidian_search` (substring/regex/words/fuzzy) |
| "Who links to X" / "what does X link to" / orphans / dead links | `obsidian_search` with `graph:` |
| Read one note fully | `obsidian_read` |
| User says "note this down" | `obsidian_create` into `Inbox/` |
| Add a log line / event | `obsidian_append_section` under `## Log` |
| Rename / relocate a note | `obsidian_move` (auto-rewrites inbound links) |
| Add a tag without editing body | `obsidian_update_frontmatter` |
| Show the user a note | `obsidian_open` |
| List what exists | `obsidian_list` |
| Distill a markdown doc into Zettelkasten notes | `obsidian_distill` |
| Audit/repair vault health (orphans, broken links, MOC drift) | `obsidian_garden` |

**Decision tree:** prefer `obsidian_query` → `obsidian_search` (with `paths`)
over reading full notes. Only `obsidian_read` when you know the exact note.

## Note-naming conventions

- Zettelkasten titles: `Topic — Subtopic` (em-dash) for consistency.
- Avoid mixing `:`, `-`, `—` randomly within the same area.
- `obsidian_garden` flags titles that deviate from the dominant style.

## Analyze / summarize the vault

Two complementary approaches:

1. **Interactive (in pi)** — call `obsidian_garden` (audit: orphans / broken
   links / MOC drift) and `obsidian_query` (filter by tags/folder/date) to
   reason about vault health and topics.

2. **Batch (bun scripts)** — generate static reports + graph exports:

   ```bash
   # Graph for external renderers (Mermaid / Graphviz / D3)
   bun run scripts/vault-graph-export.mjs --format mermaid --out out/vault-graph.mmd
   # Traditional-Chinese knowledge report (stats, clusters, health)
   bun run scripts/vault-summarize.mjs --out out/vault-report.md
   bun run scripts/vault-summarize.mjs --tag zettel --llm   # focus + semantic summary
   ```

   The summarize script is read-only and works offline; `--llm` adds semantic
   per-topic summaries. Use the report to spot dead clusters, plan a cleanup
   pass, or brief a teammate on what the vault contains.
