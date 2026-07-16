# pi-agent-ext-research-tool

The ubiquitous language of pi-agent-ext-research-tool — research collection: gather LLM/AI videos from Bilibili and YouTube, organize vault frontmatter, and import pi-hermes-memory entries into a vault-mind collection. Ports and unifies the standalone collection scripts into one self-contained extension.

## Language

### Collection

**Unified collector** (`collect_videos`):
One tool over a platform × preset matrix — the two Bilibili scripts (LLM + media) collapsed into one shared engine where only the keyword preset differs.
_Avoid_: collector script, fetcher (it is one unified engine over a platform×preset matrix)

**Platform** (`bilibili` | `youtube`):
The first selector — which source to collect from.
_Avoid_: source, site (it is the platform axis of the collector)

**Preset** (`llm` | `media`):
The second selector — which keyword set filters results. The LLM set vs the media set (AI painting / video / SD / Sora); or a custom keyword list. The abstraction that collapsed the two scripts into one engine.
_Avoid_: category, filter (it is the keyword-preset axis)

### Vault tooling

**`organize_vault_notes`**:
Auto-tags frontmatter (tags / aliases / created) on notes missing it; lists orphans. Cross-platform, no hardcoded paths.
_Avoid_: tagger, indexer (it is frontmatter auto-tagging + orphan detection)

**`import_memory_to_vault`**:
Parses pi-hermes-memory's `MEMORY.md` / `USER.md` / `failures.md` → appends to a vault-mind `.jsonl` collection (dedup by id).
_Avoid_: sync, migrate (it is hermes → vault-mind jsonl import)

### Output

**weekly-news**:
The default output directory (under the active vault) where collected Markdown lands.
_Avoid_: output folder, news dir (it is the canonical weekly-news collection location)

**Vault resolution** (mirrors obsidian):
Output location resolves like the obsidian extension — `OB_VAULT_PATH` → `run-dir/obsidian_config.json` → `<cwd>/weekly-news` fallback; overridable via `outputPath`.
_Avoid_: vault config (it reuses the obsidian resolution tiers)
