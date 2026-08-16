---
effort: 2026-08-15-subagent-tui-display
created: 2026-08-15
last: 2026-08-16
status: complete
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
- [01 — Width-aware pure render layer](tickets/01-width-aware-pure-render-layer.md) — five pure helpers + settled-collapsed truncate by explicit column width; shared truncation helper prefactor; constants become min() upper bounds; defaults keep today's behavior.
- [02 — Width-aware mounting: compose-in-render](tickets/02-width-aware-component-mounting.md) — renderCall/renderResult (single + batch tools) return components composing inside render(width); resize re-flow free; settled-collapsed cap width-derived; streaming shapes untouched.
- [03 — Markdown finalize report](tickets/03-markdown-finalize-report.md) — settled expanded = header row + Markdown body via getMarkdownTheme() matching host chat; streaming partials stay plain capped text (#1104 preserved).
- [04 — Background-runs rows width-aware](tickets/04-background-runs-rows-width.md) — bottom-panel subagents section consumes its discarded width; shared row helpers gain optional width defaulting to today's constants; detached viewer byte-identical.

## Not yet specified

- Core-runtime phrase-shaper width adoption (deferred at ticket 01 — `render-width` helpers exist; adopt optional width defaulting to today's constants in the core-runtime phrase-shaper) — candidate for the dynamic-budgets-era follow-up (`2026-08-15-subagent-dynamic-budgets`) or its own micro-effort

## Out of scope

- Streaming-partial markdown
- Webui rendering
- Budget/timeout behavior (separate effort `2026-08-15-subagent-dynamic-budgets`)
