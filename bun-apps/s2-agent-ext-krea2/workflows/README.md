# krea2 extension e2e (L2 judgment)

This is krea2's instance of the **unified extension e2e method** defined in
[`bun-apps/s2-agent/PRD.md`](../../s2-agent/PRD.md) (L2 layer). One canonical
workflow per `s2-agent-ext-*` package; same 3-phase shape everywhere.

## What this workflow tests

`test-krea2-e2e.js` answers the one question deterministic tests structurally
cannot: *"does krea2 generation produce a GOOD image, on-prompt?"*

- **Generate** — drives `krea2 t2i` (the native Swift Krea 2 Turbo CLI the `krea2`
  tool wraps) via bash, one PNG per prompt. krea2 has no `--output-dir`/`--name`,
  so each run gets an explicit `--out <abspath>`; the output path is parsed from
  the `[krea2] saved <abspath>` success line.
- **Judge** — scores each output with the project's local VLM
  (`run.py caption <png> --style score --lang en`) in parallel, parsing the
  `[score] {...}` JSON (overall / detail / sharpness / composition /
  prompt_adherence / artifacts / issues).
- **Synthesize** — pass iff every output clears conservative thresholds
  (overall ≥ 6, artifacts ≥ 6, no blocking-issue keyword).

The deterministic surface (flag mapping, path safety, `[krea2] saved` parse, exit
codes, pixel dimensions) is covered by `src/*.test.ts` — NOT duplicated here. See
PRD.md for the L0/L1/L2 split and the over-praise caveat behind the conservative
thresholds.

## Run

```bash
# unified runner (discovers every extension's L2 workflow):
bash bun-apps/s2-agent/scripts/run-ext-e2e.sh krea2

# or directly via the workflow tool:
bun-apps/s2-agent/run.sh -e workflow -p \
  "read bun-apps/s2-agent-ext-krea2/workflows/test-krea2-e2e.js and execute it via the workflow tool (background:false)"
```

Opt-in — it spends LLM tokens and is non-deterministic, so it is NOT part of CI's
`run-test.sh`.

## Why the workflow drives the CLI, not the `krea2` tool

Under `-e workflow`, subagents get `createCodingTools` (bash/read/...) — they do NOT
inherit the parent's registered `krea2` tool. So the workflow exercises the same CLI
surface the tool forwards to, via bash. The tool's own TS logic is L0's job.

## Inputs (via the workflow tool's `args`)

`repoRoot`, `outDir`, `name`, `seed`, `width`, `height`, `steps`, `prompts` (array).
Defaults: 1024×1024, 8 steps (Turbo), seed 42, 2 prompts.

## Complex-pose validation (`pose_dsg`)

For complex human poses (hands, limbs, face — where `--style score` over-praises),
this workflow is **pose-aware**: pass `poses` (entries lifted verbatim from
[`../../s2-agent-ext-flux2/workflows/poses.json`](../../s2-agent-ext-flux2/workflows/poses.json):
`{id, prompt, failure_modes, atoms:[{id,q}]}`) and the Judge stage switches each
output to the atomic `pose_dsg` validator (shared `run.py caption`, not
flux2-specific). Generation is driven from the pose prompts.

- **Gate** — a pose output passes iff `anatomy_pass === true && faithfulness >= 0.8`
  (`faithThreshold`, overridable). `anatomy_pass === false` is a hard fail
  regardless of faithfulness — a six-fingered hand is not redeemed by a correct
  background.
- **Per-pose × per-atom matrix** — `result.poseMatrix[]` records each pose's
  `atoms:[{id,q,present}]` + `failed_atoms` + `faithfulness`, so a commit can be
  diffed atom-by-atom (e.g. dancer's-pose `a4` from present→absent) even when the
  holistic `overall` score is flat.
- Method + research: [`../../s2-agent-ext-flux2/docs/pose-validation.md`](../../s2-agent-ext-flux2/docs/pose-validation.md).

Without `poses`, the workflow falls back to the holistic `score` path above
unchanged. The silent-failure protection carries into pose mode: a judge that
throws or returns null becomes `{scored:false, style:"pose_dsg", needsReview:true}`,
never a dropped null.

