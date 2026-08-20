# Receipt — native-relay long-movie plan (Task 12/12): verification sweep + honest e2e status

## Purpose

Final task of the 12-task plan wiring Swift `native-relay`'s per-segment
duration/continuity support into the TS agent pipeline as a long-movie
generation mechanism (Tasks 1-11 already landed and reviewed — see commits
`51cba8a6`..`4d5c982b`). This task is verification-only: run the full test
sweep, run the schema cross-check, and **attempt** a real end-to-end rerun
of the `optical-hall-detective` regression script that originally exposed
the bug Task 10 fixes. No code changes were made in this session.

## What was actually verified in this session

### 1. Full monorepo test sweep

```
( cd bun-apps/s2-agent-ext-ltx && bun test )
  156 pass, 1 skip, 0 fail, 420 expect() calls — 157 tests / 8 files

( cd bun-apps/s2-agent-ext-movie-director && bun test )
  684 pass, 8 skip, 0 fail, 1937 expect() calls — 692 tests / 53 files

( cd swift/ltx-video-director && swift test )
  Build succeeds (warnings only, pre-existing deprecation notices in
  I2VCommand.swift, unrelated to this plan). Test run crashes immediately:
  "MLX error: Failed to load the default metallib. library not found
  library not found library not found library not found" at
  mlx-c/mlx/c/stream.cpp:106, on the very first test case
  (AMPBlock1ParityTests). 0 tests actually executed before the crash.
  This is the KNOWN environment limitation flagged in the task brief, not
  a regression from this plan's work — confirmed by reproducing the exact
  same crash signature this session.
```

Both TypeScript suites (the ones covering all code touched by Tasks 1-11)
are 100% green with zero failures. The Swift suite could not run at all in
this sandbox — see "Environment prerequisites checked" below.

### 2. Schema validation smoke check

```
bun run --cwd bun-apps/gui-movie-director check:schema
```

Did **not** produce a schema-drift report — it failed earlier, at the
run.py subprocess spawn step:

```
ENOENT: no such file or directory, posix_spawn
'/Users/huangziyu/proj/video_generation__director/python/venv/bin/python'
```

`python/venv` does not exist in this sandbox at all, so `check:schema`
never got far enough to compare the `scene_plan`/`edit_decisions` additions
from Tasks 5/6 against `run.py schema --compact`. This is a environment gap,
not a schema-content problem — there is no evidence either way of drift
from this failure; it simply couldn't run. The two TypeScript-only schema
files that Tasks 5/6 touched are still fully covered by the `bun test`
sweep above (692 passing tests across s2-agent-ext-movie-director include
schema-shape tests for these fields), so the parts of Tasks 5/6 that don't
require `run.py` to be present are exercised; the specific run.py
cross-check itself is unverified this session.

### 3. Environment prerequisites checked (before attempting real e2e)

Per the task's guidance, checked what's actually present in this sandbox
before spending time trying to force a real run:

```
ls mlx-models/              → audio, controlnet, face_detection,
                               lens-unet-int4, lora, ... (some subdirs exist)
ls ../video_generation__models/ → _staging_krea2, plus real .safetensors
                               files by hash (some weight blobs exist)
ls python/venv/bin/python   → No such file or directory
```

So: some model-adjacent directories/files are present, but the Python venv
that `run.py` (and therefore the whole schema/pipeline dispatch path) needs
is completely absent, and (per the sweep above) the Swift binary crashes on
MLX's metallib load before it can run any real computation either. Both
of the two execution paths this feature depends on (Python run.py bridge,
Swift native-relay binary) are non-functional in this sandbox for reasons
unrelated to this plan's code. Per the task brief's ~10-minute cap on
troubleshooting, no further attempt was made to repair the venv or the
metallib — both are pre-existing sandbox gaps documented by a prior task
in this same plan, not something introduced or fixable by Task 12.

**Conclusion: a real end-to-end pipeline rerun (real MLX generation via
either run.py or the Swift native-relay binary) is infeasible in this
environment.** No such run was attempted beyond the prerequisite checks
above — no result is fabricated or implied.

## Code walkthrough: why the optical-hall-detective failure mode should now be caught (UNVERIFIED by a real run)

The original failure, from `real-e2e-20260711-optical-hall-detective.md`:
a 120-second, 7-section script produced 162.9s of synthesized narration,
but every scene's I2V clip was generated at a flat 8.04s with `edit_decisions`
locking every cut to exactly `out_seconds: 8`, giving a composed video of
7×8.04s ≈ 56.28s — well under half the planned narrative. Every gate that
existed at the time (`cut_duration_vs_source`, `final-review`'s
container/audio checks) passed clean, because none of them compared the
script's/narration's planned runtime against the composed video's actual
total runtime. The video silently published in a state that couldn't tell
its own story.

Reading the current code (all from this plan's earlier, already-reviewed
tasks):

- `bun-apps/s2-agent-ext-movie-director/src/driver-wiring.ts` `produceAssets`
  (lines ~100-198): after the TTS call, it probes the synthesized narration
  file's REAL duration via `deps.probeDuration` (ffprobe under the hood) —
  `narrativeDurationSeconds = await probe(narrationPath)` (line 127) — and
  writes it into the returned `asset_manifest.metadata.narrative_duration_seconds`
  (line 195). This is exactly the number ("the synthesized narration audio's
  actual probed duration") the precompose-gate doc comment at
  `precompose-gate.ts:42-46` says was missing from the optical-hall-detective
  run.
- `produceCompose` (lines 233-254) reads that same
  `asset_manifest.metadata.narrative_duration_seconds` back out (line 237)
  and threads it into the `compose-motion` dispatch as
  `narrativeDurationSeconds` (line 242) — unconditionally, whenever the
  upstream manifest has it, no opt-in flag required from the caller.
- `src/dispatch.ts` (compose-motion / compose-remotion / pre-compose tool
  handlers, lines ~589-655) all call `enforcePreCompose(edit, opts)` with
  that same `opts.narrativeDurationSeconds` before allowing the render to
  proceed.
- `precompose-gate.ts`'s `preComposeGate` (lines 341-359,
  `narrative_duration_vs_script` check): when `narrativeDurationSeconds` is
  present and positive, it computes `coverage = composedSeconds /
  scriptSeconds` and fails when coverage < 0.8 (default
  `narrativeDurationFailFraction`), warns when < 0.9. Applied to the
  optical-hall-detective numbers (56.28s composed / 162.9s narration =
  ~35% coverage — well below even a much stricter bar than the actual
  47%-vs-120s-script figure quoted in the original receipt), this would
  have produced a hard `fail` verdict.
- `enforcePreCompose` (`precompose-gate.ts:382-396`): on a `fail` verdict,
  it returns `{ok:false, error: "GATE VIOLATION: pre-compose failed..."}`
  instead of `null` — and per the doc comment above it (lines 369-381,
  referencing "Bug 2, saturn-young-rings"), this is enforced as a **hard
  stop inside the same compose-motion/compose-remotion dispatch path**, not
  a separate advisory call the agent could skip. An agent cannot reach
  `compose-motion` with an under-length edit without either fixing the
  edit or passing `overridePreCompose:true` explicitly (which would then be
  a visible, auditable decision rather than the original run's silent
  publish).

**This code path, read end-to-end, should have caught the exact
optical-hall-detective failure mode as a hard `fail` before any render —
composed duration 56s vs. narration 163s is nowhere near the 80% coverage
floor.** But this claim is **unverified by an actual run in this session**:
no real narration was synthesized, no real native-relay clips were
generated, and `enforcePreCompose`/`preComposeGate` were not exercised
against real optical-hall-detective-shaped data here — only read and
cross-referenced against the original receipt's numbers and the unit tests
in `bun test` (which do exercise `narrative_duration_vs_script` and
`motion_coverage_vs_scene` with synthetic fixtures, per the 692 passing
tests above, but synthetic fixtures are not the same as a real pipeline
run against real generated media).

## What remains for a human with the full MLX stack

A human with `python/venv` installed (`bash scripts/setup-offline.sh` or
the `uv venv` recipe in `CLAUDE.md`) and the full model weight store
(`../video_generation__models/`, complete `mlx-models/`) available, plus a
working Metal/metallib environment for the Swift binary, should:

1. Rerun the `optical-hall-detective` script (or an equivalent
   long/variable-section-length script) through the real `run-pipeline`
   command, letting `produceAssets`/`produceEdit`/`produceCompose` dispatch
   a real `native-relay` call end-to-end.
2. Confirm `checkpoint_assets.json`'s `asset_manifest.metadata.narrative_duration_seconds`
   is populated with the real probed narration duration (not 0/absent).
3. Confirm that if the resulting composed video would fall short (as the
   original run's did), `pre-compose`/`compose-motion` actually returns a
   `GATE VIOLATION` fail and refuses to render, rather than silently
   publishing a truncated video — i.e., verify the fix in the field, not
   just by code reading.
4. Only after that observation should this feature be called
   "production-verified" rather than "code-reviewed and unit-tested."

## Verdict

- Monorepo TS test sweep: **PASS** (both suites, 0 failures).
- Swift test: could not execute (known environment metallib limitation,
  reproduced, not a regression).
- Schema check: could not execute (missing `python/venv`, not a schema
  content issue — no drift found because the check never ran).
- Real end-to-end regression rerun: **not performed** — infeasible in this
  sandbox (no Python venv, no working MLX/Metal runtime for the Swift
  binary; some model directories are present but that's insufficient).
  This is an honest non-result, not a pass.
- Fix correctness: supported by a full code-path walkthrough tracing the
  exact numbers from the original failing run through the exact lines that
  now compute and gate on `narrativeDurationSeconds`, but this is
  **code-level confidence, not field-verified confidence** — a human rerun
  with the full model stack is still required before calling this feature
  production-verified.
