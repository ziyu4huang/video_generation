# s2-agent-ext-research-tool

The ubiquitous language of s2-agent-ext-research-tool — research collection: gather LLM/AI videos from Bilibili and YouTube, scaffold + research the weekly LLM community news digest, organize vault frontmatter, import pi-hermes-memory entries into a vault-mind collection, and discover/fetch arXiv papers. Ports and unifies the standalone collection scripts into one self-contained extension, and ports arXiv tooling from @wienerberliner/pi-arxiv.

> Each term carries a `_Source_:` anchor (`file#symbol`). These are **verified-against-repo** locators in the spirit of Harness Handbook's behavior–implementation alignment (arXiv:2607.13285): if a symbol moves or is renamed, the anchor must be refreshed. See the `shared-state-index` skill (`bun-apps/s2-agent-ext-devops/skills/shared-state-index/SKILL.md`) for cross-package shared state.

## Language

### Collection

**Unified collector** (`collect_videos`):
One tool over a platform × preset matrix — the two Bilibili scripts (LLM + media) collapsed into one shared engine where only the keyword preset differs.
_Avoid_: collector script, fetcher (it is one unified engine over a platform×preset matrix)
_Source_: `extensions/research-tool.ts#collectVideosTool`; engines `lib/bilibili.ts#searchVideos`, `lib/youtube.ts#searchYtKeyword`; keyword sets `lib/filter.ts#DEFAULT_KEYWORDS`

**Platform** (`bilibili` | `youtube`):
The first selector — which source to collect from.
_Avoid_: source, site (it is the platform axis of the collector)
_Source_: `collectVideosTool` parameter `platform`; engines `lib/bilibili.ts`, `lib/youtube.ts`

**Preset** (`llm` | `media`):
The second selector — which keyword set filters results. The LLM set vs the media set (AI painting / video / SD / Sora); or a custom keyword list. The abstraction that collapsed the two scripts into one engine.
_Avoid_: category, filter (it is the keyword-preset axis)
_Source_: `collectVideosTool` parameter `preset`; presets `lib/filter.ts#DEFAULT_KEYWORDS`

### News digest

**`collect_news`**:
Scaffolds the weekly news digest issue — resolves the Saturday-anchored path, generates frontmatter + zh title + fill-in guide — and hands off to the agent's web research. Never overwrites a filled issue unless `overwrite`; the research half has NO API (web search + `arxiv_search`).
_Avoid_: news fetcher, news API (the tool scaffolds; the digest content is agent-researched), scraper
_Source_: `extensions/research-tool.ts#collectNewsTool`; logic `lib/news.ts`

**news digest** (`LLM 社群每週新聞`):
The 繁體中文 weekly community-news issue in `weekly-news/` — headline quote up top, one section per story with 日期 + tables + `[來源](url)` links, closing quick-hits + summary tables. The established study-news format every issue follows.
_Avoid_: newsletter, blog post (it is the vault's weekly-news digest issue)
_Source_: `lib/news.ts#generateNewsScaffold`; corpus `<vault>/weekly-news/llm-weekly-news-*.md`

**issue week**:
The digest's coverage window — Monday through Saturday of the anchor date's week, Saturday-anchored in the filename like every weekly-news file. A Sunday belongs to the week ending the FOLLOWING Saturday.
_Avoid_: calendar week (it is the Mon–Sat digest window, not Mon–Sun)
_Source_: `lib/news.ts#getNewsWeek`; anchor `lib/format.ts#getWeekEndDate`

**scaffold**:
The code-generated issue skeleton (frontmatter tags, zh title, headline-quote placeholder, commented fill-in guide, quick-hits/summary tables) the agent writes the digest into.
_Avoid_: template file (it is generated per-issue with the concrete date range, not a static template)
_Source_: `lib/news.ts#generateNewsScaffold`; write-plan `lib/news.ts#planScaffoldWrite`

### Vault tooling

**`organize_vault_notes`**:
Auto-tags frontmatter (tags / aliases / created) on notes missing it; lists orphans. Cross-platform, no hardcoded paths.
_Avoid_: tagger, indexer (it is frontmatter auto-tagging + orphan detection)
_Source_: `extensions/research-tool.ts#organizeTool`; `lib/organize.ts#organizeVault`

**`import_memory_to_vault`**:
Parses pi-hermes-memory's `MEMORY.md` / `USER.md` / `failures.md` → appends to a vault-mind `.jsonl` collection (dedup by id).
_Avoid_: sync, migrate (it is hermes → vault-mind jsonl import)
_Source_: `extensions/research-tool.ts#importMemoryTool`; `lib/import-memory.ts#importMemory`

### arXiv discovery

**`arxiv_search`**:
Search arXiv by query / optional category, with sorting and pagination. Returns metadata + abstracts.
_Avoid_: paper fetcher, reader (it is the discovery/routing step; full text is `arxiv_fetch2md`)
_Source_: `extensions/research-tool.ts#arxivSearchTool`; `lib/arxiv.ts#searchPapers`

**`arxiv_paper`**:
Exact metadata lookup for one paper by arXiv ID or URL (title, authors, abstract, dates, categories, links).
_Avoid_: search (it is a single-paper exact lookup, not a query)
_Source_: `extensions/research-tool.ts#arxivPaperTool`; `lib/arxiv.ts#lookupPaper`

**`arxiv_fetch2md`**:
Fetches a paper body as Markdown via the [arxiv2md](https://arxiv2md.org/) HTML→MD pipeline (preserves sections + math better than PDF scraping). Writes to `<vault>/papers/`.
_Avoid_: pdf scraper, downloader (it is the arxiv2md HTML pipeline, not PDF extraction)
_Source_: `extensions/research-tool.ts#arxivFetchTool`; `lib/arxiv.ts#fetchMarkdown`, `lib/arxiv.ts#saveMarkdown`

**arxiv2md**:
The external HTML-to-Markdown service (`arxiv2md.org/api/markdown`) that `arxiv_fetch2md` calls. Parses arXiv's structured HTML when available.
_Avoid_: the tool itself (it is the upstream conversion service the tool depends on)
_Source_: external `https://arxiv2md.org/api/markdown`; called from `lib/arxiv.ts#fetchMarkdown`

**papers**:
The default output directory (under the active vault) where fetched arXiv Markdown lands — the arXiv analogue of `weekly-news`.
_Avoid_: library, arxiv folder (it is the canonical vault-local papers collection location)
_Source_: `lib/arxiv.ts#saveMarkdown`; vault root via `lib/vault.ts#resolveVaultRoot`

### Output

**weekly-news**:
The default output directory (under the active vault) where collected Markdown lands.
_Avoid_: output folder, news dir (it is the canonical weekly-news collection location)
_Source_: `lib/format.ts#weeklyFilename`; path via `lib/vault.ts#resolveWritePath`

**papers**:
The default output directory (under the active vault) where `arxiv_fetch2md` Markdown lands. See § arXiv discovery.
_Source_: see § arXiv discovery

**Vault resolution** (research-tool):
`OB_VAULT_PATH` env → `~/.pi/obsidian_config.json` (personal) → `<cwd>/.pi/obsidian_config.json` (project, `mode != "app"`) → **throws** (no silent cwd fallback). Runtime is decoupled from `s2-agent-ext-obsidian`; a dev-only parity test guards against tier drift. Overridable via `outputPath`.
_Avoid_: vault config, obsidian extension (the resolver is standalone; parity test guards drift)
_Source_: `lib/vault.ts#resolveVaultRoot`, `lib/vault.ts#resolveWritePath`, `__tests__/vault-parity.test.ts`
