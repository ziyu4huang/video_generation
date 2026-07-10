---
name: collect-bilibili-media
description: Collect trending Bilibili AI multimedia/AIGC videos (AI 繪畫, AI 影片, Stable Diffusion, Sora) via the collect_videos tool (platform=bilibili, preset=media). Use when gathering Chinese-language AI image/video generation content.
---

# Collect Bilibili AI Media Videos

## When to Use
Gather B站 GAI / AI 繪畫 / AI 影片生成 / AIGC 教學 / Stable Diffusion / Sora trending
videos. Default keywords: `AI 繪畫`, `AI 影片生成`, `AIGC 教學`, `Stable Diffusion`, `Sora 影片`.

## Procedure
1. Call `collect_videos` with `platform: "bilibili"`, `preset: "media"`.
   - `keywords`: optional override.
   - `pages`, `order`, `popular`, `proxy` — same options as the LLM preset.
2. Output → `<vault>/weekly-news/bilibili-media-<saturday>.md`.
3. Summarize top AI-generation videos.

## Slash command
`/collect-bilibili-media [keywords]`

## Pitfalls
- Same HTTP 412 risk-control + proxy guidance as the LLM preset (see
  [[collect-bilibili-llm]]).
- The media relevance filter matches a broad AIGC keyword set (Midjourney,
  ComfyUI, Flux, Runway, Pika, Kling, ControlNet, LoRA, 文生圖, 圖生圖 …).

## Verification
- Per-keyword counts in the tool result; file present under `weekly-news/`.
- Frontmatter tags: `domain/media`, `source/bilibili`, `type/collection`.
