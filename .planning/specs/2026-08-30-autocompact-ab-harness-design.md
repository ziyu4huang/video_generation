# Design — autocompact A/B harness (ext vs upstream 0.84.4 mid-run compaction)

Date: 2026-08-30
Status: Implemented; measured verdict recorded (reposition) — see `## Measured`
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

Concrete numbers: script a fake model with `contextWindow: 128_000`; the
usage script walks context tokens 5k → 70k across ~8 tool loops, then ends.

| Arm | upstream `reserveTokens` (effective point) | ext | Question |
|---|---|---|---|
| S1 baseline | 68_000 (fires at 60k) | OFF | upstream alone: count, phase, residual |
| S2 matched | 68_000 (fires at 60k) | ON at 60_000 | is the ext a no-op when upstream boundary check runs first? |
| S3 standalone | disabled (`enabled: false`) | ON at 50_000 | ext regression guard (must still work alone) |
| S4 niche | 8_000 (fires at 120k — never in this script) | ON at 50_000 | does the low-absolute-threshold niche actually fire earlier? |

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

## Measured (2026-08-30)

Run: `( cd bun-apps/s2-agent-ext-power-tool && bun test src/__tests__/autocompact-ab.test.ts )`
— 5 pass / 0 fail, ~0.3 s. Report verbatim (after the two riding fixes from
Task 4's review — S4 self-marks structural, compact_failed rows carry
upstream's errorMessage):

```
## autocompact A/B — S1–S4

| arm | threshold compacts | manual compacts | failed | tokens at fire | peak turn_end | final settled | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1-baseline | 2 | 0 | 0 | 64,000 (threshold), 71,000 (threshold) | 71,000 | 70,100 | n/a (control arm) |
| S2-matched | 2 | 0 | 1 ("Compaction failed: Nothing to compact (session too small)") | 64,000 (threshold), 71,000 (threshold) | 71,000 | 70,100 | ext absorbed at matched thresholds (0 manual compacts; 1 settle-time attempt(s) refused upstream: "Compaction failed: Nothing to compact (session too small)") |
| S3-standalone | 0 | 1 | 0 | 70,100 (manual) | 71,000 | 70,100 | n/a (control arm) |
| S4-niche | 0 | 1 | 0 | 70,100 (manual) | 71,000 | 70,100 | niche real (structural — no upstream compaction raced in this curve) |
```

Key numbers per arm:

- **S1-baseline** (upstream only): 2 threshold compacts at 64,000 (mid-run,
  #6879 path) and 71,000 (boundary) — validity gate holds; the mock world
  reached upstream's real compaction seam.
- **S2-matched** (ext armed at upstream's effective point): 0 manual compacts.
  The ext's settle-time attempt was REFUSED by upstream. Correction to Task
  4's reading: the actual refusal message is `"Compaction failed: Nothing to
  compact (session too small)"`, not "Already compacted" — upstream's boundary
  compaction already shrank the content below the manual path's
  keepRecentTokens budget. Same conclusion, honest mechanism: **redundant at
  matched thresholds** (rule 1).
- **S3-standalone** (upstream disabled): 1 manual compact at 70,100 — the ext
  fires alone; regression guard holds.
- **S4-niche** (upstream effective point at 120k, never crossed by the
  5k→70k curve; ext at 50k): 1 manual compact, 0 threshold compacts. The
  ext's lane fires where upstream's never does — but structurally: there was
  no race to win in this curve (rule 2 fires vacuously), so this is
  "niche real BUT structural", not evidence of beating upstream to a shared
  threshold. No collision adjacency observed anywhere (rule 4 negative).

### Verdict: **reposition**

Rules selected: S2 → redundant at matched thresholds; S4 → ext fires with no
upstream race (structural). No retire signal (S4 fired), no collision signal,
S3 guard green. Combined honest reading: the ext's only real value is a
compact point BELOW upstream's relative effective point — low-absolute-
threshold testing and pinning a small working set; at or above upstream's
point it is pure redundancy.

Applied (same commit): `bun-apps/s2-agent-ext-power-tool/src/autocompact.ts` —
header comment now carries the measured positioning paragraph ("verdict
reposition": redundant at matched points, niche = low absolute thresholds),
and `renderStatus` appends the niche line whenever the ext is armed.

Riding fixes applied to the harness (same commit,
`src/__tests__/autocompact-ab.test.ts`): S4's verdict self-marks
"(structural — no upstream compaction raced in this curve)"; `AbRow` records
`session_compact_failed`'s `errorMessage`, surfaced in the report's failed
cell and quoted in S2's verdict — which is what exposed the
"Nothing to compact" correction above.
