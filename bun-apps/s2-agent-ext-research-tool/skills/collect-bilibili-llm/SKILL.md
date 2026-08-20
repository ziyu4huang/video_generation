---
name: collect-bilibili-llm
description: Collect trending Bilibili LLM/大模型 videos via the collect_videos tool (platform=bilibili, preset=llm). Use when asked to gather, summarize, or track Chinese-language LLM/AI video content for the weekly news.
---

# Collect Bilibili LLM Videos

## When to Use
Gather B站 (Bilibili) LLM / 大模型 / AI 前沿 trending videos for the weekly-news digest.
Default keywords: `大模型`, `LLM`, `AI 前沿`. Override with custom keywords when needed.

## Procedure
1. Confirm scope: default keywords, or a custom comma-list the user provides.
2. Call the `collect_videos` tool with `platform: "bilibili"`, `preset: "llm"`.
   - `keywords`: optional override array.
   - `pages`: pages per keyword (default 1, each ≈20 videos).
   - `order`: `click` (default) | `pubdate` | `dm` | `stow`.
   - `popular: true` to also pull + filter the all-site popular feed.
   - `proxy`: if the result is empty and the user is outside China, set a proxy
     (e.g. `http://127.0.0.1:7890`) to bypass HTTP 412 risk-control.
3. The tool writes Markdown to `<vault>/weekly-news/bilibili-llm-<saturday>.md`.
4. Read the written file and summarize the top videos for the user.

## Slash command
`/collect-bilibili-llm [keywords]` — injects the tool call.

## Pitfalls
- **HTTP 412 = risk-control block.** Non-China IPs almost always hit this.
  Pass `proxy`. An empty result with no proxy usually means 412, not "no videos".
- `popular` pulls a separate feed and filters by the LLM relevance keyword set;
  it is additive to the per-keyword searches.
- WBI keys rotate daily and are auto-fetched — no credential needed.

## Verification
- The tool result reports per-keyword counts; zero across ALL keywords with no
  proxy ⇒ suspect 412, retry with `proxy`.
- Confirm the Markdown file exists under `weekly-news/` with correct frontmatter
  (`domain/llm`, `source/bilibili`, `type/collection`).
