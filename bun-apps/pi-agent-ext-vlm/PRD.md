# PRD — pi-agent-ext-vlm

## Problem

PDF documents and images need to be converted to structured Obsidian markdown for vault ingestion. During a session, the agent cannot read local file paths via MCP — it needs a local VLM pipeline that rasterizes PDF pages, describes them via a vision language model, and stitches the result into markdown with frontmatter and per-page sections.

## Solution

VLM document describer for Pi. The `vlm_describe` tool rasterizes PDF pages (or directly reads images), classifies the document profile (paper/slides/poster/diagram/image), describes each page via LM Studio serving a local vision model (e.g. Qwen3-VL or Gemma), and writes structured markdown with frontmatter + per-page sections. Resumable pipeline with caching and retry for transient errors.

## Tools

| Tool | Description |
|------|-------------|
| `vlm_describe` | PDF/image → structured Obsidian markdown via local LM Studio VLM |

## Key Dependencies

- LM Studio (serving a vision model at `http://localhost:1234/v1`)
- `pi-agent-ext-obsidian` (vault output)
- `pi-agent-cli` (hosts vlm-describe command)

## Use

```bash
pi -e bun-apps/pi-agent-ext-vlm
# Then: vlm_describe({input: "paper.pdf"})
# Or CLI:
bun bun-apps/pi-agent-cli/src/cli.ts vlm-describe paper.pdf
```
