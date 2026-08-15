> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — verify tool-gate extension quality

## Destination

A **reusable verification harness**, living inside `pi-agent-ext-tool-gate`, that
decides whether the tool-gate extension "improves agents as it expects" — and can
be re-run whenever the gates change. The harness measures two things and emits a
human-readable report + pass/fail:

1. **Savings** — does the ~8,500 tok/req claim actually hold? (token overhead
   removed by gating, measured via power-tool's `schema-cost`.)
2. **Capability preserved** — in two layers:
   - **Layer-1 (deterministic, CI-friendly gate):** a probe-prompt corpus asserting
     each gate fires on real intent, does NOT false-fire on lookalikes, and the
     `enable_tool` escape-hatch reaches every gate on a miss.
   - **Layer-2 (live A/B investigation):** identical tasks run with tool-gate ON
     vs OFF; compare task success to detect real regressions the deterministic
     layer can't see.

End state: one `bun run qa` (or equivalent) entrypoint in the tool-gate package
that runs savings + L1 probes (+ L2 when invoked) and prints a verdict.

## Notes

**Domain.** `pi-agent-ext-tool-gate` gates heavy domain tools (flux2, ltx, movie,
…) behind keyword/co-occurrence matching; `CORE_TOOLS` stay always-active; fired
gates are sticky for the session; `enable_tool` is the escape hatch. It already
emits telemetry (`TOOL_GATE_LOG` → `turn` / `activate` / `miss_candidate` events).

**Instruments already on the shelf (use, don't rebuild):**
- `@repo/pi-agent-ext-power-tool/schema-cost` — zero-dep, importable, collects
  tool schemas via a capturing-mock API **without booting the agent**; token
  estimate = `(desc.length + JSON.stringify(params).length) / 4`. The canonical
  savings instrument.
- tool-gate's own pure exports: `gateFires`, `matchesKeyword`, `matchIntent`,
  `filterActive`, `updateSticky` — import directly for L1 probes (no agent run).
- `TOOL_GATE_LOG` `miss_candidate` events — real-session miss-rate signal.

**Skills every session should consult:** `grilling`, `domain-modeling`
(term "gate" is overloaded — tool-token gate vs verification gate; "quality" =
savings ∧ capability-preserved, settled this session).

**Standing preferences.** Written artifacts in English; conversation in zh-TW.
Home decision: the **whole harness lives in `pi-agent-ext-tool-gate`** (co-located
with the thing under test); import power-tool's schema-cost as a library — do not
re-host it.

## Decisions so far

<!-- one line per closed ticket -->

- [00 Savings measurement](tickets/00-savings-measurement.md) — **claim does NOT hold**: measured 5,554 tok/req saved (38.6%), ~2,946 short of the ~8,500 claim (lower bound — workflow gate uncosted + zai-mcp unregistered); baseline also drifted to 45 tools/14,388 tok. Runtime vs offline use the identical heuristic → no authority divergence (fog cleared).
- [02 Harness skeleton + L1 gate](tickets/02-harness-skeleton-and-l1-gate.md) — `bun run qa` unified gate: savings + L1 corpus + L2 slot, exit-coded, markdown report. Default = intended-behavior bar (green); `--strict` = zero-known-issues bar (red, 10 open); L1 thresholds strict on intended behavior. Single evaluator (`qa/evaluate.ts`) shared by test + report forms.
- [01 L1 probe corpus](tickets/01-l1-probe-corpus.md) — corpus + 75 green tests; **capability NOT fully preserved**: 6 false-fires (inspect high; flux2/ltx/workflow×2/movie med), 1 keyword overlap (storyboard→ltx+movie), 4 escape-intent blind gates (krea2/zai-mcp/inspect/movie) — intent-mode can't reach, name-only; movie mis-routes to workflow. Gaps tracked as characterization tests.
- [L2 A/B feasibility](tickets/03-l2-ab-feasibility.md) — feasible-but-flaky:
  headless `-p` runs work; no clean per-run extension-disable (`-ne` is a no-op),
  so toggle via manifest-edit / env stub; LLM A/B needs N runs + rubric judge.
- [04 L2 task suite + run](tickets/04-l2-task-suite-and-run.md) — `TOOL_GATE_DISABLE=1` kill-switch + 10-task suite + reachability evaluator. **Deterministic tier verified: 7/10 reachable, 3 confirmed task-level regressions (krea/zai blind + movie→workflow misroute).** Live tier armed by `--model`, not run (no model here) — flagged unverified. Fog (success-judge=tool-usage, flake N=3) graduated.
- [05 Verdict + thresholds](tickets/05-verdict-and-thresholds.md) — **NET POSITIVE, keep tool-gate.** Thresholds encoded: savings floor ≥15%+2k (PASS, 5,554/38.6%); default PASS; `--strict` red on 4 task-breaking gates (false-fires never gate). Scoped follow-up handed off (claim + 4 blind gates + inspect false-fire + dead keyword + overlap).

**→ Map complete: all 6 tickets closed, frontier empty, destination reached
(`bun run qa` is the reusable harness that decides whether tool-gate improves
agents, with a durable encoded verdict).**

## Not yet specified

<!-- in-scope fog that can't be ticketed yet; graduates as the frontier advances -->

- *(all fog graduated — baseline-authority cleared by 00; L2 success-judge +
  flake budget resolved to prototype defaults by 04. The only open work is the
  decision in ticket 05, not fog.)*

## Out of scope

<!-- work consciously ruled beyond this destination -->

- **Re-architecting tool-gate's gate definitions.** This effort *verifies*; if the
  verdict is negative, fixing tool-gate is a separate effort.
- **Generalizing the harness into a publishable QA framework** for any gated
  extension. Stay tool-gate-specific; revisit only if the destination is redrawn.
- **Improving power-tool.** It's the instrument, not the subject. schema-cost's
  known 4-vs-3.7 token-ratio inconsistency is a separate cleanup, explicitly
  deferred (per schema-cost.ts notes).
