# flux2 extension e2e (L2 judgment)

This is flux2's instance of the **unified extension e2e method** defined in
[`bun-apps/s2-agent/PRD.md`](../../s2-agent/PRD.md) (L2 layer). One canonical
workflow per `s2-agent-ext-*` package; same 3-phase shape everywhere.

## What this workflow tests

`test-flux2-e2e.js` answers the one question deterministic tests structurally
cannot: *"does flux2 generation produce a GOOD image, on-prompt?"*

- **Generate** — drives `flux2 t2i` (the Swift CLI the `flux2` tool wraps) via bash,
  one PNG per prompt.
- **Judge** — scores each output with the project's local VLM
  (`run.py caption <png> --style score --lang en`) in parallel, parsing the
  `[score] {...}` JSON (overall / detail / sharpness / composition /
  prompt_adherence / artifacts / issues).
- **Synthesize** — pass iff every output clears conservative thresholds
  (overall ≥ 6, artifacts ≥ 6, no blocking-issue keyword).

The deterministic surface (flag mapping, path safety, manifest parse, exit codes,
pixel dimensions) is covered by `src/*.test.ts` — NOT duplicated here. See PRD.md
for the L0/L1/L2 split and the over-praise caveat behind the conservative thresholds.

## Run

```bash
# unified runner (discovers every extension's L2 workflow):
bash bun-apps/s2-agent/scripts/run-ext-e2e.sh flux2

# or directly via the workflow tool:
bun-apps/s2-agent/run.sh -e workflow -p \
  "read bun-apps/s2-agent-ext-flux2/workflows/test-flux2-e2e.js and execute it via the workflow tool (background:false)"
```

Opt-in — it spends LLM tokens and is non-deterministic, so it is NOT part of CI's
`run-test.sh`.

## Why the workflow drives the CLI, not the `flux2` tool

Under `-e workflow`, subagents get `createCodingTools` (bash/read/...) — they do NOT
inherit the parent's registered `flux2` tool. So the workflow exercises the same CLI
surface the tool forwards to, via bash. The tool's own TS logic is L0's job.

## Inputs (via the workflow tool's `args`)

`repoRoot`, `outDir`, `name`, `seed`, `width`, `height`, `steps`, `prompts` (array),
`py` (venv python override). Defaults: 768×768, 4 steps, seed 42, 2 prompts.

## Complex-pose validation (`pose_dsg`)

For complex human poses (hands, limbs, face — where `--style score` over-praises),
this workflow is **pose-aware**: pass `poses` (entries lifted verbatim from
[`poses.json`](poses.json): `{id, prompt, failure_modes, atoms:[{id,q}]}`) and the
Judge stage switches each output to the atomic `pose_dsg` validator instead of the
holistic `score`. Generation is driven from the pose prompts.

- **Gate** — a pose output passes iff `anatomy_pass === true && faithfulness >= 0.8`
  (`faithThreshold`, overridable). `anatomy_pass === false` is a hard fail
  regardless of faithfulness.
- **Per-pose × per-atom matrix** — `result.poseMatrix[]` records each pose's
  `atoms:[{id,q,present}]` + `failed_atoms` + `faithfulness`, so a commit can be
  diffed atom-by-atom (the real signal — a dancer's-pose atom regressing from
  present→absent shows up even when `overall` is flat).
- Method + research: [`../docs/pose-validation.md`](../docs/pose-validation.md)
- Pose library: [`poses.json`](poses.json) — 11 poses across 4 levels, each
  pre-decomposed into DSG-style atoms mapped to AbHuman failure modes.

`run.py caption <png> --style pose_dsg --prompt "<pose>" --atoms <atoms.json>`
returns per-atom present/absent + a recomputed `faithfulness` + an AbHuman-derived
`anatomy_pass` hard gate. Without `poses`, the workflow falls back to the holistic
`score` path unchanged. The silent-failure protection carries into pose mode: a
judge that throws or returns null becomes `{scored:false, style:"pose_dsg",
needsReview:true}`, never a dropped null.

## Self-improve loop (`self-improve-flux2.js`)

`test-flux2-e2e.js` opens the loop (generate → judge → synthesize) but never
*closed* it — `failed_atoms` was logged, not fed back. `self-improve-flux2.js`
closes it: generate → judge → on below-threshold, **reflect** (failed atoms → a
targeted prompt-expansion clause) → **retry**, bounded by `attempts`,
seed-locked per attempt, best-so-far ranked **comparatively** by the per-atom
matrix. It reuses the engine's existing `gate(thunk, validator, {attempts})`
combinator (`s2-agent-ext-ultracode/src/workflow.ts`); the validator is pure JS
over the judge result, so a weak driver model cannot break the multi-attempt
control flow — only the per-attempt bash agents touch the model.

**Why comparative, not absolute.** The gate never trusts a holistic VLM score.
`ok` requires `anatomy_pass` (Python-recomputed hard gate) **and**
`faithfulness >= faithThreshold` (0.8 default) **and** no failed atoms. Across
attempts the winner is the one with the **fewest failed atoms** (tie-break:
highest faithfulness) — so a single VLM flip cannot falsely pass or flip
pass/fail. This is the determinism lever the goal (§2) requires.

**Reachability — one command (synchronous direct driver):**
```bash
# runner → driver (the canonical path). Default = first pose in poses.json:
bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh
bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --pose-id L3-01 --attempts 5 --seed 42
bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --prompt "a red apple on a table"   # non-pose
bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --dry-run                                   # print args, exit
```
The runner parses flags + selects a pose via jq, then calls
`scripts/self-improve-loop.driver.ts`, which invokes the engine's `runWorkflow`
**directly** (no LLM agent in the middle). An earlier version invoked
`s2-agent -e workflow -p "read … and execute"`, but the in-the-middle agent
backgrounded the workflow and exited before the result; the direct driver returns
the structured result synchronously. (The agentic `./s2-agent.sh -p "generate +
improve …"` shape and the `s2-agent cli flux2-self-improve` subcommand still
exist as best-effort entries that route to this runner.)

**Cross-run learning (two mechanisms, both deterministic, both off the model):**
- **Persistence** — the workflow only *builds* the winning exemplar and returns
  it; the **driver** appends it to `self-improve-flux2.exemplars.jsonl` via plain
  fs (capped, retire lowest-faith; **converged runs only**, so the few-shot pool
  stays clean). Persistence cannot die with a weak-model agent mid-loop.
- **Few-shot seeding** — on each run the driver `loadFewShot()`s the highest-faith
  prior winning prompt for the target pose and passes it as `args.fewShot`; the
  workflow seeds attempt 0 with it. A first run on a pose has no few-shot.

**Regression-aware termination.** Besides `ok`-or-`maxAttempts`, the loop halts
early when the failed-atom signature is unchanged across `consecutiveStatic`
rounds (default 2) — a plateau exits with `terminationReason:"static"`,
`needsReview:true`, winner = best-so-far (not the stuck attempt). Pass
`consecutiveStatic:0` for cap-only behavior.

**Result.** `{ ok, converged, staticExit, terminationReason, attemptsUsed,
maxAttempts, winnerPath, winnerVerdict, best, trace[], exemplar, exemplarsFile,
needsReview, summary }`.

**Safety.** Propose-only: the loop persists exemplars and returns a verdict; it
**never** git-applies, edits source, or merges. Auto-fix stays out of scope
(goal §3).

**Tests.** `bun-apps/s2-agent-ext-ultracode/tests/regression-self-improve-loop.test.ts`
pins the contract with a mocked judge (no GPU): fail→retry→converge,
fail-forever→bounded exit, null-mid-loop silent-kill guard, determinism, and
comparative best-so-far. Live GPU/VLM is the runner above (opt-in, last).

