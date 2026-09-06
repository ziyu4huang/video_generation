# s2-agent-ext-research-tool

A Pi Coding Agent extension for **research collection**: gather LLM/AI videos from
Bilibili and YouTube, scaffold + research the weekly LLM community news digest,
organize vault note frontmatter, import pi-hermes-memory
entries into a vault-mind collection, and discover/fetch arXiv papers.

This extension **ports and unifies** the standalone `.ts` collection scripts from the
study-news vault into a self-contained Pi extension. The two Bilibili scripts (LLM +
media) collapsed into **one shared engine** — only the keyword preset differs. The
arXiv tools are ported from [`@wienerberliner/pi-arxiv`](https://github.com/dasomji/pi-arxiv)
(logic in `lib/arxiv.ts`); the library-folder discovery + `/arxiv-library` command were
dropped in favour of writing into the active vault's `papers/`.

## Tools

| Tool | Description |
|------|-------------|
| `collect_videos` | Unified collector. `platform` (bilibili\|youtube) + `preset` (llm\|media) + optional `keywords`, `pages`, `order`, `popular`, `proxy`, `outputPath`. Writes Markdown to the vault and returns it. |
| `organize_vault_notes` | Auto-tag frontmatter (tags/aliases/created) on notes missing it, list orphans. Cross-platform — no hardcoded paths. |
| `collect_news` | Scaffold the weekly LLM 社群每週新聞 digest (`llm-weekly-news-<saturday>.md`): frontmatter + zh title + fill-in guide. The agent then researches the week via web search and writes the digest (see the `collect-news-llm` skill). Refuses to overwrite a non-empty issue unless `overwrite`. |
| `import_memory_to_vault` | Parse pi-hermes-memory `MEMORY.md` / `USER.md` / `failures.md` → append to a vault-mind `.jsonl` collection (dedup by id). |
| `arxiv_search` | Search arXiv by query / optional category, with sorting + pagination. Returns titles, authors, abstracts, dates, categories, links. |
| `arxiv_paper` | Exact metadata lookup for one paper by arXiv ID or URL. |
| `arxiv_fetch2md` | Fetch a paper body as Markdown via the [arxiv2md](https://arxiv2md.org/) HTML pipeline (keeps sections + math). Saves to `<vault>/papers/` (override with `output_path`); `save=false` to skip writing. |

## Slash commands

| Command | Maps to |
|---------|---------|
| `/collect-bilibili-llm [keywords]` | `collect_videos` platform=bilibili preset=llm |
| `/collect-bilibili-media [keywords]` | `collect_videos` platform=bilibili preset=media |
| `/collect-youtube-llm [keywords]` | `collect_videos` platform=youtube preset=llm |
| `/collect-news-llm [focus]` | `collect_news` + the web-research digest workflow |

## Credentials

- **Bilibili** — none required (buvid3 + WBI keys auto-fetched). Non-China IPs hit HTTP
  412 risk-control; pass `proxy` (e.g. `http://127.0.0.1:7890`) — the proxy now uses a
  real proxy agent (the original script's `dispatcher` option silently did nothing).
- **YouTube** — set `YOUTUBE_API_KEY` (YouTube Data API v3, Google Cloud Console). The
  tool errors clearly if absent. Daily quota: 10,000 units (each search ≈ 100 units).
- **arXiv** — none required. The arXiv API and arxiv2md.org are keyless; arXiv API calls
  self-throttle to one request per 3s per arXiv's polite-use guidance.

## Output

Collected Markdown is written to the **active vault's** `weekly-news/` directory by
default (`collect_videos` scaffolds `llm-weekly-news-<saturday>.md`, `collect_news`), or `papers/` for `arxiv_fetch2md`. Vault resolution (research-tool): `OB_VAULT_PATH` env → `~/.pi/obsidian_config.json` (personal) → `<cwd>/.pi/obsidian_config.json` (project, `mode != "app"`) → **throws** (no silent cwd fallback). Runtime is decoupled from `s2-agent-ext-obsidian`, with a dev-only parity test guarding against tier drift. Override with an explicit `outputPath` / `output_path` param (absolute or cwd-relative).

## Architecture

```
lib/
├── types.ts          # unified VideoResult + shared interfaces
├── bilibili.ts       # ONE engine: WBI signing, buvid3, search, hot (fixed proxy)
├── youtube.ts        # YouTube Data API v3 engine (quota-aware)
├── filter.ts         # keyword presets: LLM set, media set, custom
├── format.ts         # markdown generation (frontmatter, tables, fmtNum)
├── news.ts           # weekly news digest: week range, zh title, scaffold, overwrite plan
├── vault.ts          # output-dir resolution (mirrors obsidian tiers)
├── organize.ts       # frontmatter auto-tagging
├── import-memory.ts  # hermes → jsonl
└── arxiv.ts          # arXiv search/lookup + arxiv2md fetch (ported from @wienerberliner/pi-arxiv)
```

## Development

```bash
( cd bun-apps/s2-agent-ext-research-tool && bun test )   # unit tests (pure fns, no network)
```
