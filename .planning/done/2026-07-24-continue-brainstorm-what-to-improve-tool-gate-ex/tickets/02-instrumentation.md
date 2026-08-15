---
type: prototype
status: closed
claimed: agent/grilling-2026-07-24
blocked by: [01-metric]
---

# 02 — Build the metric aggregator from existing telemetry

## Question

Given [01]'s metric, **is the existing telemetry sufficient to compute it, and what's the smallest artifact that does so?** Raise fidelity with a cheap, rough aggregator the map can react to — not a polished feature.

## What to build (prototype — rough, reacts-to-able)

- A `qa/miss-rate.ts` (sibling to `qa/savings.ts`) that reads a `TOOL_GATE_LOG_PATH` JSONL file and computes [01]'s headline metric, per session (sessions segmented by `session_start`-equivalent boundary or a `ts` gap heuristic if no explicit marker), plus the per-gate breakdown.
- Emit both a human summary (`formatSavings`-style) and `--json` for machine consumption.
- Wire a `qa:miss` script in `package.json`.
- Reuse the existing event schema verbatim — `turn` / `miss_candidate` / `activate` (`tool-gate.ts:551/558/606-651`) — do NOT add new instrumentation in this ticket. If [01]'s metric turns out to need a field the events don't carry (e.g. an explicit session id, or the active-tool-set snapshot), **stop and surface that as a sub-decision** — adding telemetry is a separate move that must be justified, not smuggled into the aggregator.

## Acceptance

- [ ] `bun run qa:miss --file <path>` parses a captured JSONL and prints the [01] metric + per-gate breakdown; `--json` emits machine-readable output.
- [ ] Round-tripped against a hand-crafted JSONL fixture (a known sequence of `turn`/`miss_candidate`/`activate`) asserting the computed number — a small `qa/miss-rate.test.ts`.
- [ ] If [01]'s metric needs data the events lack, the ticket **does not invent it** — it records the gap and blocks on a new ticket rather than silently adding fields.
- [ ] `bun test` in the package stays green (existing 203 + the new test).

## Resolution (2026-07-24)

**Built + verified.** `qa/miss-rate.ts` computes the full 01 metric from the existing JSONL telemetry — **no new instrumentation** (honors 01's "block, don't invent").

**What it computes:**
- **Sessions** — segmented by a ts-gap heuristic (>30min idle = new session). ⚠ The known gap from 03's hand-off: telemetry has NO session-ID, so sessions are *inferred*. If this proves unreliable at verdict time (05), the candidate fix is adding a `session_start` marker to the `turn` event — an instrumentation change to justify THEN, not smuggled in now.
- **Gated-domain sessions** — sessions with ≥1 gate-fired turn OR ≥1 `activate` (isolates sessions where a gated tool plausibly mattered; pure-coding sessions excluded).
- **Escape-rate (headline)** — escape-sessions / gated-domain-sessions + total `enable_tool` calls.
- **Confirmed-miss (verdict lens)** — a `miss_candidate` turn followed (same session) by an `activate` whose `matchedGate` was dormant then; per-gate breakdown.
- **Common-intent label** — `common` if `promptHead` matches the gate's bare keyword OR the requires noun∧verb (captures "generate a video" for ltx with no bare keyword); else `review` (keyword may sit beyond the 80-char truncation, or intent was model-inferred) → flagged for human judgment at 05, NOT forced.

**Verdict wiring (04):** GO bar = zero `common` confirmed-misses; `review` ones surface for the human to call at 05.

**Verified:** `bun test qa/miss-rate.test.ts` → **10/10** (parse, segmentation, gated-domain detection, confirmed-miss correlation, common/review labelling, GO-bar state, intent matcher); full suite **213/213** (203 + 10); CLI smoke `bun run qa:miss [--json] <file>` produces both human + machine output. Wired as **`qa:miss`** in `package.json`.

**Residual risk** (flagged, not patched): session segmentation relies on the ts-gap heuristic — revisit at 05 if the verdict is borderline and sessions look mis-segmented.
