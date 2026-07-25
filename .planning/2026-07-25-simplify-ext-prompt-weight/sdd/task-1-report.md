# Task 1 Report — Probe harness + Phase-1 fat baseline

**Status:** DONE
**Effort:** `2026-07-25-simplify-ext-prompt-weight`
**Task:** Behavioral probe harness (shared by all 3 phases) + record the fat baseline against the current un-slimmed `subagent` tool.

---

## What was built

### Files (all in commit scope)

| File | Role |
|---|---|
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts` | `Probe` / `ProbeResult` interfaces + the `passed()` tolerance gate. The stable contract Phases 2–3 reuse. |
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts` | The 3 Phase-1 probe fixtures (readonly dispatch, implementer dispatch, run recall). |
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/runner-lib.ts` | **Pure** helpers (`buildJudgePrompt`, `runStructural`, `parseJudgeResult`, `validateProbe`, `alignScores`, `formatRow`) extracted so they are unit-testable with no live dispatch. |
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/runner-lib.test.ts` | Unit tests for the pure logic — 22 tests, all green. |
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline.json` | The fat baseline: 3 `ProbeResult`s recorded against the current un-slimmed `subagent` tool. |
| `scripts/probe-runner.ts` | The runner — loads a probe module, dispatches each probe + judge as isolated subagents, prints a score table, `--record`/`--baseline`. |

### Interfaces produced (the contract)

- `Probe` / `ProbeResult` (from `probes/types.ts`) — byte-faithful to the brief.
- `passed(result, baseline)` — tolerance gate: structural is a hard gate (any miss ⇒ FAIL); rubric allows `≥ baseline − 1` per item (judge noise is ±1, so a uniform −1 is "no worse within noise"; −2+ on any item is a real regression).
- The runner is a thin dispatcher over this contract — a future workflow-tool-backed runner would reuse the same types + `buildJudgePrompt` unchanged.

---

## Runtime-model decision + evidence

**Decision: standalone `bun scripts/probe-runner.ts` ships (Decision #2, branch A).**

`spawnSubagent` wraps `WorkflowAgent.run`, which calls the pi SDK's `createAgentSession()` with an in-memory `SessionManager` + real `SettingsManager`/`auth.json` (`~/.pi`). It does **not** require a live pi TUI around it — it boots a fresh session per dispatch.

The one wrinkle: the `subagent` tool is a **static** extension (in `bun-apps/pi-agent/run-dir/manifest.json`'s `staticExtensions` list, NOT in the dynamic `extensions[]` array the `DefaultResourceLoader` reads). A child session created standalone therefore does **not** auto-load it. The runner bridges the tool explicitly via `spawnSubagent({ extensionTools: [createSubagentTool({ cwd })] })` — this is exactly what a live session does on `session_start` (`pi.getAllToolDefinitions()` → `extensionTools`). The child therefore sees the **current on-disk `subagentToolSchema`**, which is precisely "the thing under test" (fat now, slim in Task 2).

**Evidence (3 checkpoints, all standalone `bun`):**

1. **Imports resolve + arg parse + tool builds** — `bun scripts/probe-runner.ts` (no args) prints usage; `createSubagentTool({cwd})` yields `{ name: "subagent", execute: [Function] }`.
2. **Smoke dispatch** — a 1-probe module (`/tmp/smoke-probe.ts`, 60s timeout): child saw the bridged `subagent` tool, mentioned it; `structural /subagent/i` passed; judge scored `[3]`. End-to-end dispatch works standalone (24s under load).
3. **Full Phase-1 baseline** — all 3 probes dispatched + judged (see below); `baseline.json` written.

The `dispatchSubagent` wrapper passes `tools: ["subagent","read","bash","grep","find"]`, `excludeTools: ["edit","write"]` (probe is non-destructive but can dispatch), `extensionTools: [bridgedSubagentTool]`, and a per-dispatch timeout (`PROBE_TIMEOUT_MS`, default 240s) so a stuck child under load can't hang the recording.

---

## Test results (TDD)

`runner-lib.test.ts` — **22 pass, 0 fail, 46 expect() calls.**

**RED→GREEN cycle:** the first run had 21 pass / 1 fail. The failure was a *test-side* bug — `expect(validateProbe(...))[0].toMatch(...)` indexes the `Assertion` wrapper, not the array (the assertion object has no `[0]`). Fixed to `expect(validateProbe(...)[0]).toMatch(...)` → green. (The production helper was correct throughout — confirmed by direct eval returning the right problem strings.) This is the kind of bug the pure-logic test exists to catch: the harness's actual tolerance/parse/validate logic was validated independently of any slow dispatch.

Coverage:
- `passed()` — 5 cases (structural hard-gate, no-baseline ⇒ pass, within −1 ⇒ pass, −2 on any item ⇒ fail, missing-index defensive).
- `runStructural()` — 4 cases (vacuous, AND-of-regexes, flag sensitivity, Phase-1 fixtures match intended targets).
- `buildJudgePrompt()` — 3 cases (numbered rubric, output truncation cap, full-output passthrough).
- `parseJudgeResult()` — 5 cases (bare JSON, fenced block, embedded object, numeric coercion, total-failure diagnostic).
- `validateProbe()` / `alignScores()` / `formatRow()` — 5 cases (valid accepts, each invalid shape rejected, pad/truncate, row format, every Phase-1 fixture valid).

---

## baseline.json summary (fat subagent)

3 `ProbeResult`s, all `structuralPassed: true`:

| Probe | Scores | Notes |
|---|---|---|
| `subagent-dispatch-readonly` | `[3,3,3]` | Child dispatched a read-only subagent that mapped entry points; judge confirmed tool invocation + self-contained task + read-only restriction. |
| `subagent-dispatch-implementer` | `[3,3]` | Child dispatched a subagent that created `scratch/health.ts` with the exact signature; judge confirmed invocation + self-contained task. |
| `subagent-recall` | `[0,3]` | Child referenced the on-disk `~/.pi/subagents` dir but **not** the `subagent_runs` tool or `/subagents` command; judge correctly scored criterion 0 as 0. Did not invent run ids (criterion 1: 3). |

The `[0,3]` on recall is judge-not-noise — the child genuinely referenced the directory path rather than the tool/command. The structural regex `/subagent_runs|\/subagents/i` still matched because the path `.pi/subagents` contains the substring `/subagents` (a slight regex looseness — noted below). For the baseline's purpose this is fine: it's the reference; future runs need `≥ baseline − 1` per item, so recall needs `[≥0, ≥2]`.

Dispatch timings (under heavy concurrent load on this machine): 171s / 76s / 165s per probe (each = child dispatch + judge dispatch; readonly/implementer also spawn grandchildren). Total ≈ 7 min. No timeouts.

---

## Concerns

1. **Grandchild side effects (implementer probe).** The child's `excludeTools: ["edit","write"]` restricts only the **child**; when the child invokes the bridged `subagent` tool, the grandchild it spawns is *not* restricted, so the implementer probe created `scratch/health.ts`. This is expected per the probe's prompt and is outside the rubric's scope (the rubric judges the child's *decision to dispatch* + *self-containedness*, not the grandchild's outcome). **Cleanup:** removed `scratch/` after the run; it is not committed. If a later phase needs strict non-destructiveness, the bridged tool would forward `excludeTools` into the grandchild — not needed for Task 1.

2. **`subagent-recall` structural regex is path-loose.** `/subagent_runs|\/subagents/i` matches the on-disk path `…/subagents` as well as the tool/command. The judge compensates (scored criterion 0 as 0), and the structural gate is only a *lower* bound (must pass), so this doesn't mask a regression — but tightening to require `subagent_runs` or the literal `/subagents` *command* would make the gate more meaningful. Left as-is to stay byte-faithful to the brief; flagged for Task 3 review.

3. **Judge score variance.** The brief calls out ±1 inter-run judge noise (hence the tolerance). Recorded under concurrent load; re-recording is cheap (`bun scripts/probe-runner.ts <module> --record <out>`) if a future task wants a quieter-room baseline.

4. **Scope of `dispatchSubagent` toolset.** The child additionally inherits whatever extensions `createAgentSession` loads from the run-dir manifest (the `WorkflowAgent` filters only `customTools` via `toolNames`, not the manifest-loaded extension tools). This mirrors a real session and does not affect the probe's behavioral observation, but it means the child isn't hermetically limited to the 5 named tools. Noted for transparency.

---

## How Phases 2–3 reuse this

- **Same `Probe`/`ProbeResult`/`passed()` contract** — Phase 2/3 probe modules only differ in `prompt`/`rubric`/`structural`.
- **Same runner** — `bun scripts/probe-runner.ts phase2-wayfind.ts --baseline baseline-wayfind.json`. Task 5 adds `--manifest` for the Phase-3 A/B manifest-swap mode by extending the same runner.
- **Same judge** — `buildJudgePrompt` + `parseJudgeResult` are phase-agnostic.

## Replay

```bash
export PI_PLANNING_EFFORT=2026-07-25-simplify-ext-prompt-weight
# Re-run the unit tests (instant):
bun test ./.planning/2026-07-25-simplify-ext-prompt-weight/probes/runner-lib.test.ts
# Re-run Phase-1 probes and diff vs the fat baseline (Task 3 will do this after Task 2 slims):
bun scripts/probe-runner.ts \
  .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase1-subagent.ts \
  --baseline .planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline.json
```
