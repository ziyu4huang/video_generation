# PRD — s2-agent-ext-web-access

## Problem

Pi agents need web access: search the web, fetch URL content, extract readable markdown from pages, access YouTube transcripts and GitHub repos, and fall back to a headless browser curator when sites block bots. Multiple search providers (Brave, Exa, Tavily, Perplexity, OpenAI, Parallel, Gemini, Z.ai) need a unified interface with SSRF protection and path validation.

## Solution

Web access for Pi with multi-provider search, content extraction, and a browser curator fallback. `web_search` provides AI-synthesized answers with source citations across 8 providers. `fetch_content` extracts readable markdown from URLs, YouTube videos (with frame extraction), GitHub repos, and local video files. Includes SSRF guards (protocol/hostname validation, DNS-rebinding defense, loopback/IPv6 block), error rendering, and model-scope gating for the summary layer.

## Tools

| Tool | Description |
|------|-------------|
| `web_search` | Multi-provider search with AI-synthesized answers and browser curator |
| `fetch_content` | URL content extraction, YouTube/GitHub/video support |
| `get_search_content` | Retrieve stored content from previous searches |

## Key Dependencies

- Provider API keys: Z.ai (preferred), OpenAI, Brave, Exa, Tavily, Perplexity, Parallel, Gemini
- `YOUTUBE_API_KEY` for YouTube Data API
- `yt-dlp` + `ffmpeg` for YouTube video extraction
- Browser binary for curator fallback

## Use

```bash
# Loaded via s2-agent's run-dir manifest automatically
pi -e bun-apps/s2-agent-ext-web-access
```
