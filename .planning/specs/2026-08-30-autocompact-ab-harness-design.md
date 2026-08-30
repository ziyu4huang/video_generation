# Design — autocompact A/B harness (ext vs upstream 0.84.4 mid-run compaction)

Date: 2026-08-30
Status: Approved design (pending implementation plan)
Package: `bun-apps/s2-agent-ext-power-tool`

## Destination

A one-command, fully deterministic, hermetic A/B harness that measures how
`/autocompact` (absolute threshold, `agent_settled` trigger) interacts with
upstream pi 0.84.4's auto-compaction (relative threshold, mid-run + boundary),
and produces a report plus an explicit verdict: **keep / reposition / retire /
collision-guard**.

## Context (measured 2026-08-30 on this machine, pi-coding-agent 0.84.4 installed)

- Upstream `#6879` (0.84.4): large tool results crossing the compaction
  threshold are compacted **between tool execution and the next assistant
  request in the same run** — `agent-session.js:805` calls
  `_checkCompaction(msg)` per assistant message (mid-run).
- Upstream ALSO checks at run boundary — `agent-session.js:895`
  `_checkCompaction(lastAssistant, false)`. Our ext triggers on
  `agent_settled` (`agent-session.js:350`), which fires **after** that
  boundary check: overlap is potentially complete at matched thresholds.
- Threshold rule: `shouldCompact = contextTokens > contextWindow - reserveTokens`
  (`compaction.js`), defaults `{enabled: true, reserveTokens: 16384,
  keepRecentTokens: 20000}`.
- Token curve is scriptable: `_checkCompaction` prefers
  `calculateContextTokens(assistantMessage.usage)` — the provider-reported
  usage drives the decision directly (`agent-session.js:1697-1722`).
- Upstream has an anti-double-compact guard (stale pre-compaction usage
  check, `agent-session.js:1705-1714`) — collisions are expected NOT to
  occur; "no collision observed" is itself a valid finding.
- Our ext (`s2-agent-ext-power-tool/src/autocompact.ts`, 197 lines):
  absolute per-session threshold (`/autocompact 400k`), triggers only on
  `agent_settled`, debounce guard per session, `agent_settled` chosen
  precisely because it cannot race upstream compaction.
- No breaking rename affects us: `GoogleThinkingLevel` →
  `GoogleApiThinkingLevel` has zero references in this repo.

## Non-goals

- No live-model lane (LM Studio) — machinery-level verdict only; mock
  provider covers the decision seam.
- No `#8537` (`triggerTurn:false` ordering) coverage — handled separately by
  an ordering assertion in the existing background-run-manager tests.
- No LLM-judge of summary quality, no cost/wall-clock metrics.

## Harness design

Single file: `bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts`
(bun test = the one command; avoids the `scripts/` allowlist trap; runs inside
the package's canonical `bun run test`).

### Components

1. **Harness extension** — one factory that:
   - registers the **ScriptedProvider** via `pi.registerProvider(createProvider(...))`
     (complete pi-ai Provider; `streamResponse` yields a scripted sequence:
     N assistant responses each carrying one `emit_blob` tool call, then a
     final text-only response; `usage` fields scripted per response so the
     context-token curve is exact; compaction summarizer calls hit the same
     provider and get a fixed summary response);
   - registers the **`emit_blob` tool** returning a given-length string
     (large tool result = the `#6879` trigger condition);
   - subscribes as **recorder**: `session_compact`, `session_compact_failed`,
     `agent_settled`, `turn_end` → rows `{arm, event, contextTokens, loopIndex}`.
2. **Hermetic session** — `createAgentSession({ cwd, agentDir })` pointed at a
   temp dir containing a `settings.json` (controls `compaction.reserveTokens`
   per arm) and receiving the sessions JSONL. Never touches `~/.pi/agent`.
   The power-tool factory loads through the same resource loader (real ext,
   real `/autocompact` command, real `agent_settled` hook).

### Arms (single-variable discipline)

| Arm | upstream `reserveTokens` | ext | Question |
|---|---|---|---|
| S1 baseline | small (mid-run provocation) | OFF | upstream alone: count, phase, residual |
| S2 matched | same as S1 | ON, threshold ≈ upstream's effective point | is the ext a no-op when upstream boundary check runs first? |
| S3 standalone | disabled | ON | ext regression guard (must still work alone) |
| S4 niche | large (upstream fires late) | ON, absolute threshold well below upstream's | does the low-absolute-threshold niche actually fire earlier? |

### Report

Per arm: compaction events with phase (mid-run vs settled), contextTokens at
fire, loopIndex, peak context, post-compact residual, ext triggers. Printed
to stdout as a comparison table.

### Verdict rules

- S2 ext triggers all absorbed by upstream (ext sees post-compact tokens) →
  redundant at matched thresholds.
- S4 ext fires earlier than upstream ever does → niche is real →
  **reposition** (docs + `/autocompact` status output state the
  low-threshold-testing use case explicitly).
- S4 ext never fires even below upstream's effective point → **retire**.
- Double-compact adjacency observed (unexpected, guard should prevent) →
  **collision-guard**: ext subscribes `session_compact` as a recency gate.
- S3 fails → regression against upstream changes; fix before any verdict.

## Error handling

- Script exhaustion → loud fail (never a silent pass).
- **Harness validity gate (CI-asserted)**: S1 must produce ≥1 compaction —
  otherwise the mock world never reached the `#6879` path and any "no
  difference" result is invalid; fail with diagnostics.
- Per-arm timeout; hermetic temp dirs cleaned up.

## CI / budget

- Pure mock, no network, seconds → satisfies local_ci ≤5 min and
  no-long-running-tests rules.
- CI asserts structural invariants only (arms complete, validity gate);
  measured numbers are reported, not gated.

## Risks

- `createAgentSession` + `registerProvider` composition is verified against
  docs/dist types but not yet executed — first implementation step is a
  smoke proof of this integration point.
- Extension loading via a custom ResourceLoader must load the real power-tool
  factory from the workspace (not a copy); fall back to registering the
  factory directly against the session if loader composition fights us.
