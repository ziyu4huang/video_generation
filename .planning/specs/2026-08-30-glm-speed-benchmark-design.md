# GLM Speed & Effectiveness Benchmark (`bench-agent`) — Design

**Date:** 2026-08-30
**Status:** Approved (Approach A, balanced latency+quality objective)
**Scope of changes after measurement:** `bun-apps/s2-agent/src/pre-load-providers.ts` catalog + tiers only

## Problem

The agent feels slow. Is it the model, the thinking level, the context overhead, or the
extensions? Anecdote cannot answer; measurement can.

### Measured baseline (2026-08-30, this machine, 8 recent sessions in this project)

| Metric | Value |
| --- | --- |
| Default model / thinking | `zai/glm-5.3` @ `thinking:"high"` (`BUILTIN_MODEL_DEFAULT`) |
| Tiers | small=`glm-5.3-flash`, medium=big=`glm-5.3` |
| Median turn latency | 5.5–6.5 s |
| p90 turn latency | 17–27 s |
| Output throughput | 66–78 tok/s |
| Reasoning token ratio | 44–64 % of output tokens |
| Cache hit (steady state) | 96–98 % (cold turns: 14–59 %) |
| System prompt | ~13.8 k tok (59 skills ~6.3 k, CLAUDE.md ~2.9 k, memory-policy ~0.75 k) |
| API tools schema | ~25.2 k tok / 84 tools, per request |
| Cost | $0 (Z.AI coding plan) → optimize latency + quality, not spend |

### Key facts established during exploration

- **Hermes-memory is NOT a context tax right now.** It runs in `policy-only` mode
  (default, `src/config.ts:62`), injecting only the ~750-token memory-policy block —
  NOT the 59 KB memory store (`formatForSystemPrompt` full-dump only happens in
  `legacy-inject` mode; failure injection caps at 5 entries / 7 days and only in that
  mode). The hypothesis "hermes-memory hooks too much memory" is disproven by code +
  live system prompt; the `--probe prefill` run re-confirms with wall-clock numbers.
- **The likely latency driver is reasoning tokens at `thinking:high`** — roughly half
  of all generated tokens are thinking at ~70 tok/s.
- **Critical unknown:** `glm-5.3` has NO `thinkingLevelMap` in our catalog and the
  provider-level compat pins `supportsReasoningEffort: false` with
  `thinkingFormat: "zai"`. Whether `--model zai/glm-5.3:medium` changes anything at
  all is unverified. If levels are silent no-ops, the only lever is model choice.

## Solution

A permanent benchmark harness — `cli bench-agent` — that measures wall-clock speed,
token economics, and task quality per model×thinking config, then feeds a
data-driven tuning pass over `pre-load-providers.ts`.

### 1. Harness

New subcommand `bun-apps/s2-agent/src/cli/commands/bench-agent.ts` (+ unit test),
wired like other `cli` commands:

```
bun bun-apps/s2-agent/src/cli.ts cli bench-agent                    # full matrix
bun bun-apps/s2-agent/src/cli.ts cli bench-agent --configs 5.3-high,5.3-medium
bun bun-apps/s2-agent/src/cli.ts cli bench-agent --probe prefill    # context A/B
bun bun-apps/s2-agent/src/cli.ts cli bench-agent --dry              # no-LLM self-test
```

Each cell: one headless session via the existing `createSharedSession` +
task-runner path (`src/cli/sessions/run-agent-session.ts`, `shared.ts`) with `tools`
narrowed per task. No new session machinery. Per-run timeout (default 300 s,
`--timeout`), one retry on transient API error; a failed cell records the error and
the matrix continues.

### 2. Task suite

Fixtures live committed under `bun-apps/s2-agent/bench/tasks/<name>/`. Every run
copies the fixture into a fresh temp dir (`os.tmpdir()`); edits never touch the repo.

| Task | Measures | Quality gate (deterministic, no LLM judge) |
| --- | --- | --- |
| T1 needle-lookup | prefill + first-token latency, minimal reasoning | planted token exact-match in final reply |
| T2 code-edit | agentic loop, read→edit reliability | fixture's own `bun test` passes after the run |
| T3 cross-file-analysis | reasoning depth, multi-file synthesis | structured answers exact/substring-match |

### 3. Config matrix (focused)

- `zai/glm-5.3:high` — current default, baseline
- `zai/glm-5.3:medium`
- `zai/glm-5.3:low`
- `zai/glm-5.3-highspeed:high`
- `zai/glm-5.3-flash:medium` — cheap 5th

15 runs ≈ 20–40 min wall clock. The first comparison the report surfaces is the
reasoning-ratio delta across `5.3:high/medium/low` — that answers the no-op question.

### 4. Metrics & output

Per run, read from the session messages in-process (usage + timestamps the session
already records): wall-clock total + per-turn, turns, input/output/reasoning/cacheRead
tokens, tok/s, reasoning ratio, cache-hit ratio, quality pass/fail (+ which check).

Output: `output/bench-agent/<ISO-ts>/` containing `results.jsonl`, `REPORT.md`
(markdown comparison table), and per-run edited-fixture copies for diff inspection.

### 5. `--probe prefill` — context-cost A/B

T1 twice (cold then warm) under two loads:

- **full** — default extension set (~84 tools, ~25 k tok schema)
- **stripped** — session built with `tools: ["read"]`, no extra factories

Report: cold-start latency delta, warm latency delta, cacheWrite/cacheRead token
deltas. Expected: warm delta small (96–98 % cache hit), cold delta larger — the
report states both and quantifies what the tools schema actually costs in
wall-clock. Hermes contribution documented from code + live prompt (~750 tok,
policy-only).

### 6. Tuning flow (data decides; catalog + tiers only)

Levers, each conditional on findings:

1. Add `thinkingLevelMap` to `glm-5.3` — only if `:medium`/`:low` prove real levers.
2. `BUILTIN_MODEL_DEFAULT.thinking` high→medium — only if quality holds and
   reasoning tokens drop materially.
3. Tier swap (e.g. medium→`glm-5.3-highspeed`) — only if it matches 5.3 quality faster.
4. `glm-5.3-flash` stays the small tier.

After edits: update pinned tests (`pre-load-providers.test.ts` folded-compat +
resolution guards), run `run_local_ci` for `bun-apps/s2-agent`, re-run the bench to
confirm the new default beats baseline on latency with quality held.

### 7. Error handling & self-test

- Per-cell timeout + one transient retry; failure recorded, matrix continues.
- `--dry` mode: exercise fixture copy + all three quality gates with canned outputs,
  zero API calls — covered by `bench-agent.test.ts` so the harness is CI-verified.
- Bench exit code: 0 unless a harness error (failed runs are reported data, not a
  CI gate).

## Explicitly out of scope

- Extension config changes (compact memory-policy, tool-schema trimming, disabling
  extensions) — findings may recommend these later, but this effort changes catalog +
  tiers only.
- Remote CI / cost optimization (cost is $0).
- glm-5.2 family benchmarks (full matrix was declined).

## Verification

1. `bun bun-apps/s2-agent/src/cli.ts cli bench-agent --dry` + `bun test bench-agent.test.ts` green in CI.
2. Full matrix run produces `REPORT.md`; numbers answer: (a) do thinking levels
   affect glm-5.3 reasoning ratio, (b) which config wins latency at equal quality,
   (c) what the tools schema costs cold vs warm.
3. Tuning pass lands with pinned tests updated; `run_local_ci` green.
4. Re-run bench post-tuning: new default ≥ baseline quality, better latency.
