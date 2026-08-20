# PRD — s2-agent-ext-obsidian

## Problem

An agent needs durable, searchable knowledge storage that persists across sessions. Without a vault, every tool output and agent decision is ephemeral. The Obsidian vault provides a structured, linkable, human-readable knowledge base that the agent can read, write, and search over multiple sessions.

## Solution

Full Obsidian vault integration as a Pi package. 17 tools for vault CRUD, search (full-text + semantic), wiki-link management, graph queries, frontmatter editing, distill, garden health, and vault status. Three-tier vault resolution (explicit path → app-follow → fallback local vault). Auto-seeds fresh vaults with starter notes.

## Tools

| Tool | Description |
|------|-------------|
| `obsidian_list` | Recursively list notes |
| `obsidian_read` | Read note contents |
| `obsidian_create` | Create/overwrite notes (overwrite guard + mtime conflict) |
| `obsidian_append` | Append text (creates if missing) |
| `obsidian_append_section` | Insert under heading |
| `obsidian_search` | Full-text: substring/regex/words/fuzzy + graph queries |
| `obsidian_semantic_search` | Vector search via vault-mind ChromaDB |
| `obsidian_query` | Index-only metadata (tags/folder/date) |
| `obsidian_move` / `obsidian_rename` | Move/rename + rewrite wiki-links |
| `obsidian_delete` | Delete + strip inbound links |
| `obsidian_update_frontmatter` | Merge frontmatter keys |
| `obsidian_invalidate` | Reconcile cache with on-disk state |
| `obsidian_open` | Open vault in Obsidian app |
| `obsidian_distill` | Distill → atomic Zettelkasten notes |
| `obsidian_garden` | Audit/repair graph health |
| `obsidian_status` | Introspect active vault |

## Commands

| Command | Description |
|---------|-------------|
| `/obsidian [note]` | Open vault/note in Obsidian |
| `/obsidian-init` | Register vault with Obsidian app |
| `/obsidian-config` | Show/set active vault |

## Key Dependencies

- Obsidian app (optional — vault can be used without the app)
- vault-mind service (optional — for semantic search)
- Consumed by `s2-agent-ext-knowledge-card` (zk_* tools depend on vault access)
- Consumed by `s2-agent` (zk-* commands import the obsidian factory)

## Use

```bash
# Auto-loaded via s2-agent's run-dir manifest
# Or standalone:
pi -e bun-apps/s2-agent-ext-obsidian
```
