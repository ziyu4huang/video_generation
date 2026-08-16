---
type: task
status: closed
blocking: 02
---
# 03 — Markdown finalize: settled expanded report

## Question

How does the settled finalize REPORT render as styled markdown matching host chat?

## What to build

- The settled expanded branch returns a `Container` composed of the existing header row (badge + model/elapsed/tags meta, content unchanged) followed by a `Markdown` component fed the full report text and the shared markdown theme (`getMarkdownTheme()`), mirroring host chat's custom message rendering — headings, bold, emphasis, code, theme colors instead of raw `##` and `**` markers.
- The full, uncapped report body renders in the expanded view, wrapping and re-flowing at terminal width.
- Streaming partials stay plain capped text exactly as today — the flicker regression (#1104) is preserved; the markdown change is confined to the settled expanded branch.

## Acceptance

- [ ] Rendered lines carry heading/bold theme codes.
- [ ] Full report body present (uncapped) in the expanded view.
- [ ] Streaming branch byte-compatible plain capped text.
- [ ] Header row shape unchanged.

## Resolution

- Settled-expanded finalize now composes a `Container`: the unchanged header row (badge + model/elapsed/tags meta) rendered via `renderSubagentResultHeader` above a `Markdown` component fed the full, uncapped report text and the shared theme (`getMarkdownTheme()`), mirroring host chat's custom message rendering — headings/bold/emphasis/code carry theme codes instead of raw `##`/`**` markers.
- New exports from `subagent-tool-render.ts`: `renderSubagentResultHeader` (header row) and `subagentResultText` (full report body) — header/body split enabling the compose.
- Streaming partials and settled-collapsed rendering are untouched — plain capped text as before, preserving the flicker regression fix (#1104).
- Test approach: render the settled-expanded result and assert header + styled block structure (not the raw string), plus width re-flow (no overflow, no crash); `Markdown.render(width)` makes it width-aware. No `initTheme` call was needed — theme-dependent styling assertions pass as-is in the bun test env.
- Gates: `bun run test` in `bun-apps/pi-agent-ext-subagent` — 611 pass / 0 fail (165 expect() calls, 35 files). Zero new deps.

