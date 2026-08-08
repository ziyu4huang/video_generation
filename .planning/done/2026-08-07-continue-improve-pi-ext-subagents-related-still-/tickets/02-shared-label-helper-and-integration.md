---
type: task
status: closed
blocked by: [01]
claimed: claude
---

# 02 — Shared label helper + wire all surfaces

## Question

Implement the shared label helper per ticket 01's approved spec and wire it into every surface, replacing the per-surface ad-hoc strings so all surfaces render ONE consistent human-readable action.

## What to build

- A shared `formatToolAction(entry)` (or equivalent) helper in `bun-apps/pi-agent-ext-subagent/src/` — the single source of the verb-led render from ticket 01.
- Rewire the call sites to use it (replace ad-hoc strings):
  - `src/subagent-tool.ts` — `describeLastActivity`, `formatHistoryLine`, `formatSubagentProgress` (`renderSubagentCall` stays untouched)
  - `src/agent-history.ts` — `summarizeLatestAction`
  - `src/subagent-context-widget.ts` — flows through the above (untouched structurally)
  - `src/agent-row-display.ts` — `renderActivityRow` flows via `summarizeLatestAction` (untouched structurally)
- Resolve the cross-surface inconsistency (inline `read` vs `/subagents` `▸ read` vs result `read → done`) → all surfaces now agree via the helper.
- Unit tests for the helper (verb table, arg extraction, fallback, parse tolerance, pairing) + the per-surface render paths.

## Acceptance

- [x] One shared label helper; all entry-labellers call it (no remaining ad-hoc tool-id stringing)
- [x] Common tools render verb-led with key arg extracted; unknown tools hit a graceful fallback (no raw identifiers leak)
- [x] tool-call / tool-result / error phrasing is consistent across inline, box, `/subagents`, workflow panel
- [x] Helper has unit tests (+30 new in src/tool-action-label.test.ts)
- [x] `bun run typecheck` + `bun test` green in `bun-apps/pi-agent-ext-subagent/` (457 pass / 0 fail)

## blocked by

01 (the verb table / arg-extraction / fallback must be approved before wiring four files).

## Resolution

**Implemented + verified green 2026-08-07.** SHIP verdict from an independent code audit (7/7 spec invariants PASS) + a fresh gate re-run (typecheck clean, 457 tests pass / 0 fail, +30 new).

### What landed
- **New `src/tool-action-label.ts`**: `formatToolAction(entry, ctx?)` + `matchedCallArgsFor(history, index)` + the VERBS table, `parseArgs` (JSON.parse → regex-scrape → undefined), `shapeTarget` (mid-ellipsis / first-line / quoted, ~50-char truncation). Re-exported from `src/index.ts`.
- **Rewired (`subagent-tool.ts`)**: `formatHistoryLine` (`→` call / `✓` result / `✗` error markers; absorbs arg-extraction), `describeLastActivity` (bare phrase, accepts ctx), `formatSubagentProgress` (`↳ ` + paired tail), `formatSubagentLive` (trace maps with `matchedCallArgsFor`). `previewPayload` **deleted**.
- **Rewired (`agent-history.ts`)**: `summarizeLatestAction` → bare `formatToolAction` (pairs tail internally; no `▸`/`✗` prefix — `renderActivityRow` adds its own icon).
- **Consumer fix (`subagent-viewer.ts`)**: follow-trace `.map(formatHistoryLine)` now passes `matchedCallArgsFor` so `/subagents` follow also gets target-rich results.
- **Untouched (audit-confirmed)**: `renderSubagentCall` (launch header), `renderActivityRow`/`ActivityRow`, `subagent-context-widget.ts` source, the workflow-row branch.

### Deviations from spec (both audited PASS, documented here)
1. **Error double-marker guard** in `formatHistoryLine`: `formatToolAction` returns `⚠ <line>` for whole-turn assistant errors (so the bare-phrase callers don't render an assistant error as plain text); a literal `✗ ⚠ …` would double up. Guard: pass through if the phrase starts with `⚠`, else prefix `✗`. Tool errors still render `✗ Failed to …`.
2. **`matchedCallArgsFor` `{}` semantics**: a paired-but-empty-arg call returns `{}` (→ generic `Used <tool>`) vs a true orphan returns `undefined` (→ verb-only `Read`). Matches "paired shows target / orphan → verb-only."

### Test coverage (30 new)
Every curated verb present+past; arg-extraction priority (per-tool > generic > toolName); unknown tool (`krea2` → `Using/Used krea2`); parse tolerance (`{}`, truncated-JSON → scrape, non-JSON → fallback); `matchedCallArgsFor` (paired / orphan / skip-mismatched-tool); error forms; text/idle. Existing tests updated to the new verb-led strings.

### Delivery
Shipped via branch `feat/subagent-natural-logs` (squash-merge to `main`).
