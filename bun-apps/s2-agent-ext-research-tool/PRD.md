# PRD — s2-agent-ext-research-tool

## Problem

AI/LLM video content from Bilibili and YouTube needs to be collected, filtered by topic (LLM or media/AIGC), formatted as structured markdown, and stored in the weekly-news vault. Each platform has a different API surface, authentication model, and response format — the agent needs a unified collector. The weekly LLM community news digest (LLM 社群每週新聞) has the inverse shape: no API exists, the content is agent-researched — but the repetitive parts (Saturday-anchored filename, frontmatter tags, zh title/date formatting, skeleton) must be code-enforced so every issue starts from the same shape.

## Solution

A pi extension for research collection. One `collect_videos` tool with `platform` (bilibili|youtube) and `preset` (llm|media|custom) parameters. Bilibili engine handles WBI signing, buvid3, and popular feed; YouTube uses Data API v3. `collect_news` scaffolds the weekly news digest issue (frontmatter + zh title + fill-in guide) and hands off to the agent's web research; it never overwrites a filled issue unless told to. Output is structured markdown written to the active vault's `weekly-news/` directory. Also provides `organize_vault_notes` (auto-tag frontmatter) and `import_memory_to_vault` (hermes→jsonl).

## Tools

| Tool | Description |
|------|-------------|
| `collect_videos` | Unified collector: platform + preset + keywords + proxy |
| `collect_news` | Scaffold the weekly LLM 社群每週新聞 digest; agent researches + fills via the collect-news-llm skill |
| `organize_vault_notes` | Auto-tag frontmatter on vault notes, list orphans |
| `import_memory_to_vault` | Parse hermes memory → vault-mind `.jsonl` collection |

## Commands

| Command | Description |
|---------|-------------|
| `/collect-bilibili-llm [keywords]` | Shortcut for Bilibili LLM video collection |
| `/collect-bilibili-media [keywords]` | Shortcut for Bilibili AIGC media collection |
| `/collect-youtube-llm [keywords]` | Shortcut for YouTube LLM video collection |
| `/collect-news-llm [focus]` | Scaffold + research + write this week's news digest |

## Key Dependencies

- `s2-agent-ext-obsidian` (vault resolution and output)
- `YOUTUBE_API_KEY` env var (YouTube Data API v3)

## Use

```bash
# Collected output → vault's weekly-news/ (default)
pi -e bun-apps/s2-agent-ext-research-tool
```
