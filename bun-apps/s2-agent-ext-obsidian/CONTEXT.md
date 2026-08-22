# s2-agent-ext-obsidian

The ubiquitous language of s2-agent-ext-obsidian — tools to read, write, search, and graph a project-local Obsidian vault, plus subagent-driven distill/garden operations. Fully hermetic: filesystem only, no network.

## Language

### The vault

**Vault**:
The project-local Obsidian folder the tools operate on. Resolved per invocation (see Vault resolution); all note paths are confined within it.
_Avoid_: folder, directory, store (it is a resolved Obsidian vault with index + graph semantics)

**Vault resolution**:
The 3-tier lookup that picks the active vault — (1) explicit `OB_VAULT_PATH` / `run-dir/obsidian_config.json`, (2) auto-follow the vault open in the Obsidian app, (3) fallback `<cwd>/vault`. Top-down, first match wins.
_Avoid_: vault config, vault path (resolution is the process; a path is one input)

**Auto-seed**:
On first run, if `<cwd>/vault/` is empty, the bundled `vault-template/` starter notes (README, Inbox, Templates, Tags MOC) are copied in.
_Avoid_: init, bootstrap (it seeds structure, not a database)

**Stale-config handling**:
If a Tier 1 target is configured but its path no longer exists, resolution does not abort — it records a warning and falls through to Tier 2/3, so the agent keeps working instead of pointing at a ghost path.
_Avoid_: error, fallback (it is graceful fallthrough with a surfaced warning)

### Retrieval

**Lexical search** (`obsidian_search`):
The default — and, since the vault-mind retirement (2026-08-22), the only — full-text retrieval: substring / regex / words / fuzzy, plus field/folder filters, relevance/recency sort, context snippets, and graph queries. Semantic retrieval over knowledge cards lives in `s2-agent-ext-knowledge-card`'s `knowledge_query`, not here.
_Avoid_: text search, semantic search (the vector mode is retired; name the lexical capability)

**Trigram index** (C5):
The substring pre-filter that backs `obsidian_search` substring mode only (regex/words/fuzzy are full-scan by design — a literal-substring pre-filter is sound; the others aren't).
_Avoid_: search index, inverted index (it is a trigram candidate pre-filter, scoped to substring)

**Index persistence** (C6):
Cross-session persistence of the vault index to `<vault>/.cache/pi-obsidian-index.json`, so the index survives across sessions instead of rebuilding each startup.
_Avoid_: cache, snapshot (it is a persistent cross-session index; tunable via `OB_INDEX_CACHE_DIR`)

### Graph

**Wiki-link** (`[[note]]`):
An Obsidian inter-note link. Auto-rewritten on `move`/`rename`, and the substrate `obsidian_search graph:` queries traverse.
_Avoid_: link, reference (it is the `[[…]]` form specifically, with rewrite + traversal semantics)

**Graph query** (`obsidian_search graph:`):
A structural query over the wiki-link graph — `backlinks`, `outgoing`, `orphans`, `dead-links`, `neighbors`.
_Avoid_: graph search, link analysis (it is a named structural query mode)

### Integrity

**Path safety**:
All note paths resolve within the vault and are rejected on escape (no `../` traversal, no symlink escapes, no control chars). Writes into `.obsidian/` and `.git/` are blocked.
_Avoid_: validation, sanitization (it is vault-confinement enforcement)

**Atomic write**:
Notes are written via temp-file + rename, supporting optimistic concurrency via `expectedMtime`.
_Avoid_: safe write, transactional write

**invalidate** (`obsidian_invalidate`):
Force-clear the read cache + vault index after external edits (e.g. you edited in the Obsidian app or another process).
_Avoid_: refresh, reload (it is an explicit cache/index bust)

### Subagent operations

**distill** (`obsidian_distill`):
Distill markdown/text into atomic Zettelkasten notes via an isolated subagent.
_Avoid_: summarize, condense (it is atomic-note decomposition, not summarization)

**garden** (`obsidian_garden`):
Audit + repair vault graph health (orphans, dead links, MOC drift) via a subagent.
_Avoid_: maintain, clean (it is graph-health audit/repair)
