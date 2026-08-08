---
effort: 2026-08-07-continue-improve-pi-ext-subagents-related-still-
created: 2026-08-07
last: 2026-08-07
status: complete
---

# Wayfinder map: 2026-08-07-continue-improve-pi-ext-subagents-related-still-

## Destination

Subagent (and background-workflow) running logs in the TUI read naturally to a human. Each tool event renders as a **verb-led action with its key argument extracted** — `Reading src/parser.ts`, `Running: npm test`, `Editing app.ts` — produced by ONE shared label helper that feeds the inline call line, the always-on context box, and the `/subagents` viewer. The always-on box becomes **expandable** (its existing `toggle()` wired to a key) so the naturalized log is visible without opening `/subagents`, and its count header names the right noun when only a workflow is running.

## Notes

- **Fidelity chosen (grilling, 2026-08-07): verb-led action lines** — map each tool event to a human verb + extract the key arg. NOT model-derived narrative commentary (rejected: verbose/inaccurate risk). NOT phrasing-unify-only (too timid).
- **Scope chosen (grilling, 2026-08-07): naturalness + box work folded in** — wire box expand-on-key (deferred prize, `toggle()` already implemented + tested but unbound) and fix the count-header noun. `update-pi.sh` is a SEPARATE effort (assessed separately — script is functionally sound; only stale comments).
- Packages: **`bun-apps/pi-agent-ext-subagent/`** (primary — all phrasing files live here) and **`bun-apps/pi-agent-ext-workflow/`** (`workflowPreview`). Surface C (`/subagents`) and Surface D (workflow task panel) consume the shared helper for free.
- Shared label helper replaces per-surface ad-hoc strings in:
  - `src/subagent-tool.ts` — `describeLastActivity`, `formatHistoryLine`, `formatSubagentProgress` (`renderSubagentCall` UNTOUCHED — launch header)
  - `src/agent-history.ts` — `summarizeLatestAction`
  - `src/subagent-context-widget.ts` — header, workflow row (flow through unchanged)
  - `src/agent-row-display.ts` — `renderActivityRow` (flows via summarizeLatestAction)
- **Args are stringified-only** (`compactAgentHistory` = `JSON.stringify(args)`); the helper parses `e.text`. Result entries carry no args → pair with preceding same-tool call. See ticket 01 resolution.
- Box mechanism: `subagent-context-widget.ts` — `toggle()` is implemented + tested but NOT bound to a key; the docked widget is not focusable yet (Stage A left expansion deferred). Wiring expansion must solve focus + key-binding.
- Prior effort (PR #1076, `e2cc66fc`) landed the unified box + workflow registry wiring. Count-header noun + expand-on-key were the deferred prizes, now folded into THIS map.
- Phrasing helpers are pure string functions → straightforward unit/snapshot tests.
- **Start from `origin/main`.** The branch `feat/unified-subagent-context-box` is stale (PR #1076 already squashed-landed); do not build on it.

## Decisions so far

- [01 — Verb/label mapping spec](tickets/01-verb-label-mapping-spec.md) — verb-led human phrases via one `formatToolAction(entry)` helper (parses stringified args; pairs results with their call's args). Visual scheme: `→` call / `✓` result / `✗` error. Coverage: ~12 curated verbs + generic `Using <tool>` fallback. `renderSubagentCall` launch header untouched; `previewPayload` absorbed.
- [02 — Shared label helper + wire all surfaces](tickets/02-shared-label-helper-and-integration.md) — implemented `formatToolAction` + `matchedCallArgsFor` (new `src/tool-action-label.ts`); rewired `formatHistoryLine`/`describeLastActivity`/`summarizeLatestAction`/`formatSubagentProgress`; `previewPayload` removed; `subagent-viewer` follow-trace consumer fix. Verified green (typecheck + 457 tests, +30 new). `renderSubagentCall`/box widget/workflow-row untouched.
- [03 — Box expand-on-key](tickets/03-box-expand-on-key.md) — Ctrl-O toggles the always-on box (raw `ctx.ui.onTerminalInput` since Ctrl-O is reserved); returns `{consume:false}` so it ALSO fires the inline `app.tools.expand` → Ctrl-O expands/collapses BOTH box + inline together. Default collapsed-until-key; idle invisible. Verified green (462 tests, +8 new). Cleared fog: current-turn exclusion kept regardless of expand; line cap inherited from `formatSubagentLive`.
- [04 — Count-header noun](tickets/04-count-header-noun.md) — `countNoun(running)` picks subagent/workflow/run(s) from the actual run mix (workflow-only no longer says "subagent"); header gains a Ctrl-O discoverability hint. Verified green (467 tests, +5 new).
- Post-close polish: formatHistoryLine error branch now passes matchedCallArgs so tool errors show their target (consistency with the result branch); shipped separately. Whole-turn ⚠ errors unaffected.

## Not yet specified

- **Workflow row phrasing.** The workflow box row uses `workflowPreview()` = `${name} · ${currentPhase} · ${finished}/${total} agents`. Does it also need verb-led naturalness, or is its aggregate form already readable enough? Graduates once a workflow row is seen next to a (now verb-led) subagent row in the expanded box.

## Out of scope

- **`bun-apps/pi-agent/update-pi.sh`** — separate effort. Assessed 2026-08-07: functionally sound (lockstep bump of the 4 core pi packages works); only stale COMMENTS need fixing (non-existent commit `a0e512a7` ref, obsolete "CI: test · pi-agent" job-name refs since CI is disabled, possibly-outdated `ResourceLoader#getSystemPromptSource` API example). No behavior change needed.
- **Model-derived narrative commentary** — the alternative fidelity, rejected at grilling (verbose/inaccurate risk).
- **`/subagents` viewer (Surface C) redesign** — it already has rich follow mode; it just consumes the shared helper for free.
- **Push/subscribe API to replace the 1000ms polling refresh** — deferred prize carried from the prior effort; still deferred.
