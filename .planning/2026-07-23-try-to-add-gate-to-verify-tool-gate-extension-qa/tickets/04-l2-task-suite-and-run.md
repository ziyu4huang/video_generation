## Question

Build the **Layer-2 task suite + live A/B run** — the "does it *really* improve
agents" investigation that the deterministic Layer-1 can't see. A concrete
artifact (curated tasks + runner + results), not a spec.

**ON/OFF switch** (from ticket 03): toggle tool-gate via editing
`run-dir/manifest.json` (drop the entry for OFF), **or** — preferred, small change
— add a `TOOL_GATE_DISABLE=1` env the extension respects early in its factory.
Drive the agent headless: `pi … -p "<task>"`.

**Task suite:** a small curated set (per the literature consensus — quality over
quantity). Each task should have a gated tool as its natural solution, so an
ON-miss is observable. Mix: keyword-obvious tasks (gate fires) and
keyword-ambiguous tasks (gate may miss → agent must reach `enable_tool`, or fail).

**Success signal — start with the cheap objective one:** did the agent call the
intended gated tool (tool-usage detection from the run transcript)? This is the
**Marginal Tool Utility** framing (arXiv:2607.14108): "can the tool be gated
without hurting task accuracy?" Compare ON vs OFF success rate per task.

**Still fog (graduated to map, fix here once you see first-run data):**
- the success-*judge* (pure tool-usage vs rubric vs LLM-judge) — start
  tool-usage, escalate if it under-counts;
- the flake budget N (how many ON-vs-OFF runs per task make a delta trustworthy).

**Deliverable:** the task suite + runner + a first A/B result table
(per-task ON% vs OFF%), feeding ticket 05's verdict.

**type:** prototype
**blocked by:** [03 l2-ab-feasibility](03-l2-ab-feasibility.md)
**claimed:** wayfind-session (2026-07-23) — ✅ CLOSED

## Resolution

Built the L2 harness: a **deterministic reachability tier (verified)** + an
**experimental live-usage tier (armed, flagged unverified-without-model)**.

### Delivered
- `TOOL_GATE_DISABLE=1` env kill-switch in `extensions/tool-gate.ts` (the clean
  ON/OFF toggle ticket 03 recommended) — factory early-returns → no gating, all
  tools active (OFF baseline). Existing tests unaffected.
- `qa/l2-tasks.ts` — 10-task curated suite (7 reachable / 3 keyword-free
  gap-or-misroute), seeded from ticket 01's weak spots.
- `qa/l2.ts` — `evaluateReachability()` (deterministic) + `runLive()`
  (experimental subprocess) + `detectToolUsage()` (heuristic).
- `qa/l2.test.ts` — 14 deterministic tests (all green; **172 total**).
- wired `--l2` + `--model` into `bun run qa`.

### Tier 1 — reachability (deterministic, VERIFIED)
`bun run qa --l2` produces, with **no LLM**:
```
7/10 reachable · 3 GAP (krea-realtime, zai-reader, movie-film) · 1 misroute (movie→workflow)
```
These 3 are **CONFIRMED capability regressions** — the intended tool is
reachable OFF but not ON (gate won't fire AND intent-mode can't reach; movie
mis-routes to workflow). Extends ticket 01's keyword-level blind-gate finding
to realistic whole-task prompts.

### Tier 2 — live usage (armed, NOT verified — honest limit)
`runLive()` drives `pi-agent -p` ON vs OFF, N=3/cell, detects tool usage. **Not
run this session**: no model is configured here, and I won't claim untested code
works. Armed by `--model`, fails gracefully when not:
`bun run qa --l2 --model <provider/id>`. Detector is a heuristic regex —
calibrate against real `-p` output on the first armed run.

### Fog resolved (graduated from the map)
- **success-judge** → tool-usage detection (live) + reachability (deterministic).
- **flake budget** → N=3/cell (prototype; NOT statistically rigorous — raise +
  add a significance test for a real verdict).

### Honest scope note
The ticket's "first A/B result table" is delivered as the deterministic
reachability table; the live ON%/OFF% table is the one remaining piece, armed
and one command away. **Ticket 05 can proceed on savings + L1 + reachability
(deterministic); live usage is optional strengthening the user runs.**

### Implications for ticket 05
3 task-level confirmed regressions stack on ticket 01's keyword-level gaps →
the "capability NOT preserved" side is now evidenced at two granularities.
Verdict framing (Marginal Tool Utility, arXiv:2607.14108): gating these 3 tools
DOES hurt reachability; the ~5.5k savings must be weighed against that.

**Assets:** `extensions/tool-gate.ts`, `qa/l2-tasks.ts`, `qa/l2.ts`,
`qa/l2.test.ts`, `qa/run.ts` (`--l2`/`--model`).
