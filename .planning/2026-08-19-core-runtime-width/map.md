effort: 2026-08-19-core-runtime-width
created: 2026-08-19
last: 2026-08-19
status: complete
---

# Wayfinder map: 2026-08-19-core-runtime-width

Micro-effort, executed in one session. Provenance: the deferred prize harvested
from `2026-08-15-subagent-tui-display` (ticket 01 left `render-width` as a
subagent-local prefactor; the prize was core-runtime adoption).

## Destination

Every pure render site that clips a line in core-runtime goes through ONE
width-aware surface: `render-width.ts` moves home from
`pi-agent-ext-subagent/src/` to `pi-agent-core-runtime/src/` (both consumers
already depend on core-runtime — no new edges), gains the mid-ellipsis variant
`ellipsizeMidToWidth`, and the phrase-shaper sites adopt it with optional
widths defaulting to today's constants.

## Decisions

- **Home = core-runtime** (pinned decision from the parent effort: both
  packages already depend on it). `@earendil-works/pi-tui` joins core-runtime
  as peerDependency+devDependency `0.84.2` — the same pattern every ext
  package already uses; core-runtime stays zero-runtime-dep.
- **`ellipsizeMidToWidth` added**: column-budget counterpart of
  `ellipsizeToWidth` with the legacy ceil/floor head-tail split, so ASCII
  outputs stay byte-identical to the old `truncateMid`; wide chars are dropped
  when they would straddle either half's budget (never overshoot).
- **`ToolActionContext.width?: number`** — optional; absent → historical ~50
  cap semantics (ASCII byte-identical); present → `capWidth(50, width)` only
  ever NARROWS. Threaded through presentPhrase/pastPhrase/errorPhrase →
  extractTargetValue/extractGeneric → shapeTarget.
- **`shorten`/`preview` signatures unchanged**: the `max` argument becomes a
  terminal-COLUMN budget instead of a char count (callers in workflow pass
  constants — zero churn). `run-view.shortModelSeg` caps at 24 columns.
- **Subagent keeps no local copy**: `src/render-width.ts` +
  `tests/render-width.test.ts` deleted; `subagent-tool-render.ts` imports
  `capWidth`/`ellipsizeToWidth` from `@repo/pi-agent-core-runtime`.
- **errorPhrase/idlePhrase detail caps (200/120/60) also became column-aware**
  for free via `truncateEnd` → `ellipsizeToWidth` (ASCII-identical).

## Semantics guarantee

ASCII outputs are byte-identical to the legacy char-slice at every converted
site (pinned by tests in all four test files); CJK inputs switch from
char-count to column-count clipping — the actual bug being fixed (a 50-"char"
CJK command previously rendered 100 columns and wrapped the row).

## Out of scope

- Callers passing a live terminal width into `ctx.width` (subagent viewer /
  workflow display can adopt later; the param exists and defaults safely).
- `agent-history.ts` truncation — that is prompt-context content shaping
  (chars are the right unit for model context), not terminal display.

## Verification

- core-runtime: `bun test` 244 pass (incl. ported render-width suite + new
  adoption tests); `tsc --noEmit` green; biome clean on touched files.
- subagent: canonical `bun run test` (biome + build + 663 tests) green.
- workflow (downstream consumer of shorten/preview): 1083 tests green.
