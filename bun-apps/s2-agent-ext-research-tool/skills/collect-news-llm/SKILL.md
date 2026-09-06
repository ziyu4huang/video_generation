---
name: collect-news-llm
description: Generate the weekly LLM community news digest (LLM 社群每週新聞) into the vault's weekly-news/ via collect_news + web research. No API key. Use for the Saturday-anchored 繁體中文 weekly digest.
---

# Collect LLM Weekly News

## When to Use
Generate this week's LLM 社群每週新聞 digest — the 繁體中文 weekly community-news
issue in `<vault>/weekly-news/llm-weekly-news-<saturday>.md`. Unlike the video
collectors there is NO API: `collect_news` scaffolds the issue (filename,
frontmatter, zh title, fill-in guide), then you research the week's news via
web search/fetch and write the digest.

## Prerequisites
- None. Research runs on the session's web search/fetch tools; `arxiv_search`
  (same extension) covers the papers beat.

## Procedure
1. Call `collect_news`. It scaffolds `<vault>/weekly-news/llm-weekly-news-<saturday>.md`
   for the current Monday–Saturday window and returns the path + range.
   - `date`: anchor a different week (ISO). `overwrite: true` resets a filled
     issue — off by default so a re-run never clobbers the digest.
2. Research the week (Mon–Sat window) across:
   - Hacker News (news.ycombinator.com), r/LocalLLaMA, r/MachineLearning
   - X/Twitter AI accounts, vendor blogs (OpenAI / Anthropic / Google /
     Meta / Moonshot / DeepSeek / Qwen …)
   - arXiv via `arxiv_search` for notable paper releases
3. Write the digest into the scaffolded file in 繁體中文, following the
   scaffold's fill-in guide:
   - `> *本週重量級動態：…*` — 3–5 one-line headlines up top.
   - `## 🔥 本週頭條：<story>` — the top story, expanded (tables, pricing,
     benchmarks where relevant).
   - One `## <emoji> <title>` section per story with `**日期：**`, body, and a
     closing `[來源](url) | [Outlet](url)` link line.
   - `## ⚖️ 政策與產業動態`, then `## 🤔 值得關注的其他動態` (quick-hits table:
     | 主題 | 日期 | 一句話 |).
   - Summary table (最受關注公司 / 上升最快公司 / 主導主題) + `*下期預告：…（六）*`.
   - Keep the frontmatter (tags: type/weekly, domain/llm, domain/news).
4. Report: issue path, date range, top headlines.

## Slash command
`/collect-news-llm [focus topics]`

## Pitfalls
- **No source, no story.** Every section needs at least one working link;
  never invent releases, numbers, or quotes.
- **The Saturday anchor** — `collect_news` picks the week's Saturday for the
  filename; a Sunday belongs to the week ending the FOLLOWING Saturday. Don't
  hand-pick a different date in the filename.
- **Re-run safety:** scaffolding an issue that already has content is refused
  unless `overwrite: true` — prefer editing the existing file.
- Prefer `--date`/`date` for backfilling an older week over renaming files by
  hand (the title range, footer preview, and filename must agree).

## Verification
- File exists under `weekly-news/` named `llm-weekly-news-<saturday>.md`,
  frontmatter intact (type/weekly, domain/llm, domain/news).
- Title range matches the file's Monday–Saturday; every story section links
  at least one source.
