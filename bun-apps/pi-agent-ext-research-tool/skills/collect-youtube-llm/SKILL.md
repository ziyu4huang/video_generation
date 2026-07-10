---
name: collect-youtube-llm
description: Collect trending YouTube LLM/AI videos via the collect_videos tool (platform=youtube, preset=llm) using the YouTube Data API v3. Requires YOUTUBE_API_KEY. Use for English-language/global AI video tracking.
---

# Collect YouTube LLM Videos

## When to Use
Gather YouTube LLM / Large Language Model / AI videos for the weekly digest.
Default keywords: `LLM`, `Large Language Model`, `AI 2026`.

## Prerequisites
- `YOUTUBE_API_KEY` env var (YouTube Data API v3, Google Cloud Console).
- Daily quota: 10,000 units. Each search ≈ 100 units; stats batch ≈ 1 unit/50 ids.
  Keep daily calls under ~50 to stay safe.

## Procedure
1. Confirm `YOUTUBE_API_KEY` is set. If absent, the tool returns a clear error —
   tell the user how to set it.
2. Call `collect_videos` with `platform: "youtube"`, `preset: "llm"`.
   - `keywords`: optional override.
   - `pages`: pages per keyword (default 1, each ≈50 videos).
   - `order`: `relevance` (default) | `date` (newest) | `viewCount`.
   - `recency`: only videos from last N days (default 30; `0` = all history).
3. Output → `<vault>/weekly-news/youtube-llm-<saturday>.md`.
4. Summarize top videos.

## Slash command
`/collect-youtube-llm [keywords]`

## Pitfalls
- **No API key ⇒ hard error.** Unlike Bilibili, YouTube always needs the key.
- **Quota exhaustion** returns a 403 `quotaExceeded`; the tool surfaces the API
  error message per keyword. Wait until quota resets (midnight Pacific Time).
- `recency: 0` removes the time filter — results skew toward historically
  popular evergreen videos, not recent ones.

## Verification
- Per-keyword counts in the result; an `ERROR` note means an API issue (quota /
  key) — inspect the message.
- File present under `weekly-news/` with tags `domain/llm`, `source/youtube`.
