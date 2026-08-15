---
effort: 2026-08-15-subagent-tui-display
created: 2026-08-15
last: 2026-08-15
status: active
---

# Wayfinder map: 2026-08-15-subagent-tui-display

## Destination

Subagent live view + finalize report become terminal-width-aware and markdown-rendered — live-view lines (header `▸ "task…"`, `→ Running: …`, `↳ elapsed · tool calls`, task label) re-flow to actual TUI width instead of fixed-length truncation; the settled finalize REPORT renders as styled markdown via pi-tui `Markdown` + `getMarkdownTheme()` (same visual language as host chat); streaming partials stay plain capped text (flicker fix #1104 preserved).

## Notes

- Fixed-width truncation sites live in `bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts` (and viewer paths in `src/subagent-viewer.ts`); compose sites use fixed constants, not width.
- Finalize currently: settled expanded report = `${badge} ${meta}\n${theme.fg("toolOutput", text)}` via Text.setText (`subagent-tool-render.ts:437`, `subagent-tool.ts:476`) — plain string, raw `##`/`**` shown.
- pi SDK: `renderResult` may return a Component (`core/extensions/types.d.ts:376`); canonical md usage from `docs/tui.md`; precedent pi-agent-ext-btw (`src/btw/index.ts:33`, `src/btw/overlay.ts:151-160`).
- Zero new deps: pi-agent-ext-subagent already depends on `@earendil-works/pi-tui` + `pi-coding-agent`.

## Decisions so far

- Finalize renderer: pi-tui `Markdown` + `getMarkdownTheme()`; settled branch returns Container = header Text + Markdown body; streaming branch unchanged.
- Split from the dynamic-budget work into its own effort (different blast radius).

## Not yet specified

- Width source (process.stdout.columns vs TUI resize event — must re-flow on resize)
- Truncation helper redesign (ellipsis placement, min-width floor, CJK width handling)
- Which exact lines move to width-aware
- Ticket carve (tracer bullets)

## Out of scope

- Streaming-partial markdown
- Webui rendering
- Budget/timeout behavior (separate effort `2026-08-15-subagent-dynamic-budgets`)
