# pi-agent-ext-research-tool

A Pi Coding Agent extension for **research collection**: gather LLM/AI videos from
Bilibili and YouTube, organize vault note frontmatter, and import pi-hermes-memory
entries into a vault-mind collection.

This extension **ports and unifies** the standalone `.ts` collection scripts from the
study-news vault into a self-contained Pi extension. The two Bilibili scripts (LLM +
media) collapsed into **one shared engine** — only the keyword preset differs.

## Tools

| Tool | Description |
|------|-------------|
| `collect_videos` | Unified collector. `platform` (bilibili\|youtube) + `preset` (llm\|media) + optional `keywords`, `pages`, `order`, `popular`, `proxy`, `outputPath`. Writes Markdown to the vault and returns it. |
| `organize_vault_notes` | Auto-tag frontmatter (tags/aliases/created) on notes missing it, list orphans. Cross-platform — no hardcoded paths. |
| `import_memory_to_vault` | Parse pi-hermes-memory `MEMORY.md` / `USER.md` / `failures.md` → append to a vault-mind `.jsonl` collection (dedup by id). |

## Slash commands

| Command | Maps to |
|---------|---------|
| `/collect-bilibili-llm [keywords]` | `collect_videos` platform=bilibili preset=llm |
| `/collect-bilibili-media [keywords]` | `collect_videos` platform=bilibili preset=media |
| `/collect-youtube-llm [keywords]` | `collect_videos` platform=youtube preset=llm |

## Credentials

- **Bilibili** — none required (buvid3 + WBI keys auto-fetched). Non-China IPs hit HTTP
  412 risk-control; pass `proxy` (e.g. `http://127.0.0.1:7890`) — the proxy now uses a
  real proxy agent (the original script's `dispatcher` option silently did nothing).
- **YouTube** — set `YOUTUBE_API_KEY` (YouTube Data API v3, Google Cloud Console). The
  tool errors clearly if absent. Daily quota: 10,000 units (each search ≈ 100 units).

## Output

Collected Markdown is written to the **active vault's** `weekly-news/` directory by
default. Vault resolution mirrors the obsidian extension: `OB_VAULT_PATH` env →
`run-dir/obsidian_config.json` vault_path → `<cwd>/weekly-news` fallback. Override with
an explicit `outputPath` param (absolute or cwd-relative).

## Architecture

```
lib/
├── types.ts          # unified VideoResult + shared interfaces
├── bilibili.ts       # ONE engine: WBI signing, buvid3, search, hot (fixed proxy)
├── youtube.ts        # YouTube Data API v3 engine (quota-aware)
├── filter.ts         # keyword presets: LLM set, media set, custom
├── format.ts         # markdown generation (frontmatter, tables, fmtNum)
├── vault.ts          # output-dir resolution (mirrors obsidian tiers)
├── organize.ts       # frontmatter auto-tagging
└── import-memory.ts  # hermes → jsonl
```

## Development

```bash
( cd bun-apps/pi-agent-ext-research-tool && bun test )   # unit tests (pure fns, no network)
```
