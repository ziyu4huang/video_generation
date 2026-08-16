# Render-site inventory — subagent TUI display (2026-08-15-subagent-tui-display)

Read-only investigation (task zk-spawn). Evidence base for the width-aware + markdown-render spec. All paths relative to repo root. Line numbers verified against current `main` working tree (2026-08-15).

Symptoms grounded:
1. `subagent ▸ default ▸ glm-5.3 ▸ "You are a DevOps finish agent. Repo worktree: /Users/huangz…"` / `→ Running: git -C /Users/…` / `↳ 60.8s elapsed · 3 tool calls` truncate at FIXED length regardless of terminal width.
2. Settled finalize REPORT dumps raw markdown (`## (A)…`, `**bold**` literal).

---

## (a) Line-composition sites → truncation mechanisms

### A1. `bun-apps/pi-agent-ext-subagent/src/subagent-tool-render.ts` (482 lines) — the inline tool surface

| file:line | rendered line | truncation mechanism |
|---|---|---|
| `:21-24` `taskPreview(task, n=80)` | one-line task preview (feeds `details.taskPreview`, viewer detail tail, persistence) | **fixed 80** — char-based `oneLine.slice(0, n-1)` + `"…"` (line 23) |
| `:32-49` `workIntentPreview(task, n=60)` | work-intent segment of the header line | **fixed 60** — char `trimmed.slice(0, n-1)` + `"…"` (line 40) |
| `:65,67` `describeLastActivity` text branch | last assistant prose inside `↳ <activity>` progress line | **fixed 60** — bare `.slice(0, 60)`, **no ellipsis** |
| `:81-82` `truncateEnd(s, max)` | local helper (module) | char `slice(0, max-1)` + `"…"` |
| `:102` `latestMessageLine` | `↳ "…"` quoted prose under each row (bottom panel + collapsed result) | **fixed 80** — `truncateEnd(firstNonEmptyLine(last.text), 80)` |
| `:120-129` `formatSubagentProgress` | **the `↳ 60.8s elapsed · 3 tool calls` symptom** — `↳ <activity>\n  ↳ <X>s elapsed · N tool call(s)` | no own truncation; fixed 2-line shape; activity capped upstream at 60/50 |
| `:132-157` `formatHistoryLine` | `→ / ✓ / ✗ <phrase>` trace lines (live trace, viewer follow, expanded box) | text branch **fixed 200** — bare `.slice(0, 200)` (152, 154); phrases capped in tool-action-label (A2) |
| `:167-178` `formatSubagentLive` | 2-line header + activity trace payload (`onUpdate` partial) | **`maxTraceLines = 100`** (default param) — `history.slice(-100)` |
| `:200-271` `formatSubagentTrace` | context-box expanded paired trace (`✓ …` / `→ … … <progress>`) | no per-line truncation; progress appended to in-flight line or trailing line |
| `:274-308` `renderSubagentCall` | **the `subagent ▸ default ▸ glm-5.3 ▸ "You are a DevOps…"` symptom** | **fixed 60** at line 306: `workIntentPreview(args.task, 60)`; other segments never truncated |
| `:323` `STREAMING_EXPANDED_TAIL = 16` | exported cap constant (shared inline ctrl+o + dock expanded) | **16 lines** max tail |
| `:334-336` `capTraceTail(lines, tail)` | tail-cap helper | `["…", ...lines.slice(-tail)]` — drops oldest, 1 ellipsis line |
| `:360-367` `renderSubagentResult` isPartial branch | streaming live box | collapsed: `lines.slice(0, 2)` (line 366); expanded: `[...lines.slice(0,2), ...capTraceTail(lines.slice(2), 16)]` (line 365) |
| `:424-437` settled collapsed | `✓ done <modelSeg · elapsed · tags> <first line>` | **fixed 60** at line 437 — `truncateToWidth(firstLine, 60)` (width-aware helper, constant arg) |
| `:440` settled expanded | **the raw-markdown symptom** — `` `${badge} ${meta}\n${theme.fg("toolOutput", text)}` `` | **none** — full report as plain text (`## (A)`, `**bold**` literal) |

### A2. `bun-apps/pi-agent-ext-core-runtime/src/tool-action-label.ts` — the phrases inside every trace line

| file:line | rendered fragment | truncation mechanism |
|---|---|---|
| `:162-164` `truncateEnd` | helper | char `slice(0, max-1)` + `"…"` |
| `:166-170` `truncateMid` | helper | head/tail split around `"…"` |
| `:175-176` `shapeTarget` | **the `→ Running: git -C /Users/…` symptom** | `command` key → `truncateEnd(firstLine, 50)`; other keys → `truncateMid(raw, 50)` — **fixed 50** |
| `:280` `errorPhrase` whole-turn | `⚠ <line>` | **fixed 200** `truncateEnd` |
| `:290` `errorPhrase` detail | `Failed to …: <detail>` | **fixed 120** `truncateEnd` |
| `:299` `idlePhrase` | assistant prose phrase | **fixed 60** `truncateEnd` |

### A3. `bun-apps/pi-agent-ext-core-runtime/src/agent-row-display.ts` — shared rows

| file:line | rendered line | truncation mechanism |
|---|---|---|
| `:118-149` `renderActivityRow(row, theme, maxDetailWidth=50)` | viewer list rows | `shorten(detail, 50)` — **fixed 50** default |
| `:149-163` `renderRunRow(v, theme, maxDetailWidth=50)` | **bottom-panel background-run row** `● actor model · 12.3s · 3 calls — latest` | `shorten(latestAction, 50)` — **fixed 50** |
| `:174-181` `runHeader(v)` | plain terminal-batch-child header | `shorten(latestAction, 60)` |
| `:210-214` `shorten(value, max)` | helper | char `slice(0, max-1)` + `"…"` |
| `:216-220` `preview(value, max=80)` | helper | **fixed 80** char slice |

### A4. `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (`/subagents` overlay)

| file:line | rendered line | truncation mechanism |
|---|---|---|
| `:431-438` `render(width)` | entry + cache (`cachedWidth` key; `invalidate()` 709-713) | **width-aware** at this layer |
| `:454-496, 503-573, 579-597, 601-676` | every list/output/follow line | outer `truncateToWidth(line, width)` — **yes, they truncate, but width-aware** |
| `:488` | running-row `latestAction` fallback | nested **fixed 40**: `truncateToWidth(v.latestAction ?? "", 40)` |
| `:489 / 545` | row tails via `renderActivityRow` | nested **fixed 50** default (`50` explicit on completed rows) |
| `:41-42` `FOLLOW_TRACE_LINES = 40` | follow-view trace window | `history.slice(-40)` |
| `renderOutput` 579-597 / `renderFollow` 601-676 (the "live-tick" range) | follow head, `─` rule, trace, hints | outer `truncateToWidth(..., width)`; trace lines still carry A2's fixed 50/60/200 phrase caps |

### A5. `bun-apps/pi-agent-ext-core-task/src/subagents/subagents-section.ts` — bottom-panel live section

| file:line | rendered line | truncation mechanism |
|---|---|---|
| `:92` `render(theme, _width)` | section entry | **width param received but DISCARDED** (`_width`) |
| `:110` `renderRunRow(v, theme)` | `▶/␣ ● actor model · elapsed · N calls — latest` | fixed-50 `shorten` (A3); **no outer width cut** |
| `:124` `latestMessageLine(v.history)` | `    ↳ "…"` live line | fixed-80 `truncateEnd` (A1) |
| `:100-109` expanded block | `formatSubagentTrace` + `capTraceTail(..., STREAMING_EXPANDED_TAIL=16)`, 6-space indent | 16-line tail cap; per-line caps from A1/A2 |
| `:41-42` `DOCK_HINT_LINE` | dock keymap line | never truncated |

### A6. Data-model pre-render caps — `bun-apps/pi-agent-ext-core-runtime/src/agent-history.ts`

- `DEFAULT_MAX_ENTRIES = 40`, `DEFAULT_MAX_TEXT_CHARS = 2000`, `DEFAULT_MAX_TOTAL_CHARS = 20000` (lines 28-30); `truncateText` (131-135): `slice(0, maxChars-20)}... [truncated]` — char-based, upstream of every render.
- `run-view.ts:70-81` `historyEntryLabel` — picks raw `title/name/label/summary/text`, **no truncation**; becomes `RunView.latestAction` (falls back to `taskPreview`, i.e. fixed-80).

---

## (b) Component wiring + render(width) availability per site

| site | returns | width available? |
|---|---|---|
| `subagent-tool.ts:461-474` `renderCall` | pi-tui **`Text`** — `text.setText(renderSubagentCall(...))` | **No width in the hook.** `ToolRenderContext` (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:314-331`) carries only `args/toolCallId/invalidate/lastComponent/state/cwd/executionStarted/argsComplete`. Width reaches the **returned Component's `render(width)`**: `Text` word-**wraps** (`wrapTextWithAnsi`, `components/text.js:37-84`) — never truncates. The fixed-60 cap is baked into the string before `Text` sees it. |
| `subagent-tool.ts:476-485` `renderResult` | **`Text`** for ALL branches (isPartial collapsed/expanded + settled collapsed/expanded) | Same — no width in hook; a custom `Component`/`Container` here WOULD get width at render time. |
| `subagents-tool.ts:703-712` (batch `renderCall`/`renderResult`) | **`Text`** (same pattern) | Same. |
| Host shell: `pi-coding-agent/dist/modes/interactive/components/tool-execution.js` | `ToolExecutionComponent extends Container`; `render(width)` (line 186) passes width to children; default shell wraps renderer output in `Box(1,1)`; `renderShell: "self"` renders the returned component at full width; `renderShell?: "default" \| "self"` at `types.d.ts:360` | **Width flows automatically** — any Component returned by renderCall/renderResult is rendered at real terminal width minus shell padding. |
| `subagents-section.ts:92` | plain `string[]` via `StatusSection.render(theme, width)` | **Width IS passed** — `status-widget.ts:87-92` registers `setWidget(key, (tui, theme) => ({ render: (width) => this.renderAll(theme, width) }))`; the section currently ignores it (`_width`). One-line change to consume. |
| `subagent-viewer.ts:431` | `string[]`, own `render(width)` + cache | Already width-aware (A4); only nested fixed caps (40/50) remain. |

---

## (c) Width APIs verdict — exact names/paths

All in `@earendil-works/pi-tui` (installed under each ext's `node_modules/@earendil-works/pi-tui/dist/`):

- **`Component.render(width: number): string[]`** — `dist/tui.d.ts:10-31`. The one true width contract; every component re-renders per width (caches keyed on width — `Text.cachedWidth`, viewer `cachedWidth`), so **resize re-flow is automatic**; no manual resize subscription needed for component-returning sites.
- **`truncateToWidth(text, maxWidth, ellipsis?, pad?)`** — `dist/utils.d.ts:73` (re-exported `dist/index.d.ts:30`). ANSI-aware, grapheme-aware, **East-Asian-width-aware**. Siblings: `visibleWidth` (utils.d.ts:13), `sliceByColumn` (78), `wrapTextWithAnsi`.
- **`Terminal.start(onInput, onResize)`** — `dist/terminal.js:94-107` registers `process.stdout.on("resize", …)`; getters `columns` / `rows` (`dist/terminal.d.ts:25-26, 105-106`). `TUI` consumes this and re-renders the tree at the new width.
- **`process.stdout.columns`** — usable only as a fallback for pure-string paths that cannot return a Component (e.g. `formatSubagentLive` payloads built in `execute`); not needed once sites move to Component `render(width)`.
- **`Markdown` component** — `dist/components/markdown.d.ts`: `new Markdown(text, paddingX, paddingY, theme: MarkdownTheme, defaultTextStyle?, options?: MarkdownOptions)`, `render(width)`, `setText`, `invalidate`; `MarkdownOptions.transform?: (markdown, availableWidth) => string`. **`getMarkdownTheme(): MarkdownTheme`** — `pi-coding-agent/dist/modes/interactive/theme/theme.d.ts:117`, re-exported at package root (`dist/index.d.ts:29`). Precedents in-repo: `pi-agent-ext-btw/src/btw/index.ts:25-43` (Box + Markdown inside `registerMessageRenderer`), `pi-agent-ext-btw/src/btw/overlay.ts:151-160` (`new Markdown(...).render(contentWidth)` + `wrapTextWithAnsi`).

---

## (d) Test pins (what breaks if constants change)

- `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts`
  - 633-635: `taskPreview` length === 80 pin + `endsWith("…")`
  - 640-681: `workIntentPreview` preamble-strip + `n=40/60` truncation pins
  - 764-812: `renderSubagentCall` pins — `tier:medium ▸ gemma-4-12b ▸` exact regex (789), `default` slot, shortModel drops, segment-omission rules
  - 738-755: `formatSubagentProgress` `/1 tool call(?!s)/`, `/2 tool calls/`, floor semantics
  - 814-830: settled collapsed/expanded (`12.3s`, `Line one/three of report`)
  - ~993-1001: `formatSubagentLive` 100-line cap (`lines.length <= 102`, `t149` kept, `t0` dropped)
  - 1003-1019: batched `✓ Read <own file>` pairing pins
  - 1021-1047: isPartial collapsed ≤2 lines / expanded `→ Using read`, `✓ Used read`
  - 1060-1093: **STREAMING_TAIL=16 structural pins** — `2 + 1 + 16` line count, `lines[2] === "…"`, `deepEqual` on the exact 16-line tail, no-ellipsis-when-small, collapsed-always-2
  - 1095-1116: settled expanded uncapped (1+60 lines, no ellipsis)
- `tests/subagent-viewer.test.ts`: all renders at fixed `v.render(80)`; pins list/follow/output strings at that width
- `pi-agent-ext-core-task/src/subagents/subagents-section.test.ts`: exact row strings `"  ● researcher sonnet · 12.3s · 3 calls — Reading plan.md"`, `'    ↳ "summarizing findings"'`, DOCK_HINT_LINE verbatim, expanded 16-cap trace block, `render(theme, 100)` signature
- `tests/child-dispatch.test.ts`, `tests/spawn-subagent-subprocess.test.ts`: pin `taskPreview`/`workIntent` fields on registry entries (data, not glyphs)

---

## (e) CJK status

- **No wide-char handling in the subagent package or core-runtime/core-task**: no `wcwidth`/`string-width`/east-asian deps in any of the three `package.json`s. Every own helper (`taskPreview`, `workIntentPreview`, `truncateEnd`, `truncateMid`, `shorten`, `preview`, `formatHistoryLine` slices, `truncateText`) is **UTF-16 char-based** (`String.length` / `.slice`) — a CJK char counts as 1 "unit" but renders 2 cells → column miscount/overflow on zh content.
- **pi-tui utils are already East-Asian-aware**: `dist/utils.js` imports `get-east-asian-width`, defines `graphemeWidth`, `cjkBreakRegex` (Han/Hiragana/Katakana/Hangul/Bopomofo), grapheme segmentation, width cache. `truncateToWidth` / `visibleWidth` / `sliceByColumn` / `wrapTextWithAnsi` are CJK-correct → adopting pi-tui helpers at the truncation sites gets CJK handling with zero new deps (matches map.md "zero new deps").
- Only in-repo mention: a comment in `pi-agent-ext-core-task/src/ask-user/view/components/inline-input.ts:76` noting `visibleWidth` matters for CJK.

---

## Spec-ready takeaway

The fixed truncation lives in three layers — phrase caps (tool-action-label 50/60/120/200), line caps (tool-render 60/80/100/2+16), row caps (agent-row-display 50/60) — all char-based, all width-blind; width is already delivered to every surface (Component `render(width)` for the inline tool rows, `StatusSection.render(theme, width)` for the dock, viewer `render(width)`), it is simply discarded (`_width`) or consumed after the fixed cap. The settled expanded report's raw-markdown symptom sits at `subagent-tool-render.ts:440` + `subagent-tool.ts:476-485`, with the `Markdown` + `getMarkdownTheme()` + btw precedent ready to copy. Flicker guard (#1104) is preserved by keeping the streaming branch's `STREAMING_EXPANDED_TAIL=16` cap untouched (structural test pins at subagent-tool.test.ts:1060-1093 + subagents-section.test.ts expanded block).
