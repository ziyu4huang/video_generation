# s2-agent-ext-flux2

A [s2-agent](https://github.com/earendil-works/pi-coding-agent) extension that wraps the
`swift/flux2-image-director` CLI (`flux2`) as **one agent-optimized tool**.

`flux2` is a pure-Swift/MLX image generator (Flux2 Klein 9B + SAM3.1) with 18 subcommands.
This extension exposes them through a single `flux2` dispatcher tool with typed per-command
parameters, structured manifest parsing, progress streaming, abort support, and path-safety
guards — so an agent can generate, gate, and chain images without memorizing flags.

## What it does

- **One tool, 18 commands.** `flux2({ command, options })` — `command` is one of
  `t2i · scene · edit · style · angle · swap · expand · upscale · gate · segment · story ·
  models · verify-vae/encoder/tokenizer/transformer/e2e/edit`.
- **Typed options.** `options` is camelCase keys mapped to flux2 flags (`cfgScale`→`--cfg-scale`).
  Defaults come from the CLI itself — omit a field to use it.
- **Structured results.** Every generation returns `details.output` (PNG path), `outputs[]`,
  dimensions, seed, `gate` (auto-runs `flux2 gate` on the output), and `perf` — parsed from the
  `.manifest.json` sidecar. Chain `scene → gate → upscale` by reusing `details.output`.
- **Binary auto-build.** Resolves `.build/release/flux2`; if missing, streams
  `swift build -c release` once and caches it.
- **Safe by default.** All paths validated under repo / output-dir / models-tree roots; flag-like
  values rejected (anti-argv-injection).
- **Multi-seed `scene` pipeline.** `scene` refs are global tokens (no identity→region binding),
  so placement/pose is prompt-driven & reliable-but-probabilistic. Pass `scenePipeline: { seeds }`
  to render the same scene across N seeds, gate each, optionally VLM-verify each (via a shared
  pi-file2md subagent), and auto-pick a winner — instead of looping single `scene` calls yourself.
  See [§ Multi-seed scene pipeline](#multi-seed-scene-pipeline) below.

## Load

```bash
# Source mode (hot):
bun bun-apps/s2-agent/src/cli.ts \
  -e bun-apps/s2-agent-ext-flux2/extensions/flux2.ts \
  -p "generate a 1024×1024 t2i image of a cat, seed 42"
```

```bash
# Bundle:
cd bun-apps/s2-agent-ext-flux2 && bun scripts/build-bundle.ts   # → dist/pi-extensions/s2-agent-ext-flux2.bundle.js
```

## Multi-seed scene pipeline

`flux2({ command: "scene", options: {...}, scenePipeline: { seeds: [11, 22, 33] } })` renders
the SAME `options` once per seed, gates each, and picks a winner:

- `seeds` (required) — one render per seed, in order.
- `verifyPrompt` — question asked of a VLM subagent about each rendered candidate (e.g.
  `"Describe each person's LEFT/RIGHT position and pose."`). Reuses pi-file2md's shared subagent
  (`askImage`/`resolveLLM`, default `lm-studio/prism-ml/bonsai-27b`) — not a new LM Studio
  client. Omit to skip VLM verification (candidates are still generated + gated).
- `verifyMatch` — case-insensitive substrings that must ALL appear in a candidate's VLM reply to
  win (first matching seed, in order). Falls back to the best-gated candidate if omitted or
  nothing matches.
- `vlmModel` — `"provider/modelId"` override for the VLM subagent.
- `handRepairWinner` — re-render the winning seed once more with `--hand-repair`.

`details.output` is the winner's (or hand-repaired winner's) PNG path — chains exactly like a
single `scene` call. `details.scenePipeline.candidates[]` has every seed's output/gate/VLM verdict.
Per-seed outputs are auto-suffixed (`name` → `name_seed<N>`) so seeds never overwrite each other's
file even when you pass a fixed `name`/`output`.

This formalizes the workflow `scripts/multi-seed-autoselect.sh` / `scripts/scene-classroom-demo.sh`
already do by hand (render N seeds → VLM-verify placement/activity → rank → pick), as a
first-class, testable tool capability instead of a bash script with hardcoded absolute paths.

## Env overrides

| Var | Purpose |
| --- | --- |
| `FLUX2_BIN` | Prebuilt binary path (skip resolution/build). |
| `FLUX2_REPO_ROOT` | Repo root (required in bundle/binary mode). |
| `MLX_OUTPUT_DIR` | Output directory. |
| `MLX_MODELS_DIR` | Models tree root. |

## Development

```bash
bun run check:flags     # drift guard: every flux2 flag modeled or allow-listed
bun run build:bundle    # produce the single-file bundle
```

`src/commands.ts` is the single source of truth for the command surface; it is curated against
`swift/flux2-image-director/Sources/Flux2DirectorCLI/*Command.swift` and verified by
`check:flags`. When the CLI adds/renames a flag, `check:flags` fails until `commands.ts` is updated.

## Layout

```
extensions/flux2.ts   # the dispatcher tool (thin wrapper around runFlux2)
src/index.ts             # runFlux2() — pure, pi-free pipeline
src/commands.ts          # 18 commands: typed params + flag map (source of truth)
src/binary.ts            # resolve / auto-build the flux2 binary
src/invoke.ts            # spawn + stream + abort
src/result.ts            # manifest parsing → structured details
src/paths.ts             # path-safety / argv-injection guards
src/scenePipeline.ts     # multi-seed scene pipeline (render/gate/verify/pick-winner loop)
src/vlm.ts               # thin adapter over pi-file2md's shared VLM subagent
scripts/check-flags.ts   # drift guard
scripts/build-bundle.ts  # single-file bundle
```

## Validating complex poses

For complex human poses (hands, limbs, face) the holistic `--style score`
over-praises. Use the atomic `pose_dsg` validator instead — see
[`docs/pose-validation.md`](docs/pose-validation.md) for the method (DSG/TIFA
atoms + AbHuman anatomy gate, aggregates recomputed in Python) and the
[`workflows/poses.json`](workflows/poses.json) pose library fixture.

## Closed self-improve loop (`self-improve-flux2.js`)

A bounded, propose-only closed loop: generate → judge (pose_dsg / score) → retry
on fail → pick best-so-far comparatively (fewest failed atoms). Driven
synchronously by `scripts/self-improve-loop.driver.ts` via the engine's `gate()`
combinator — control flow is pure JS, so a weak driver model cannot break the
multi-attempt trace. Run it with:

```bash
bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --pose-id L3-01 --seed 42
```

Flags: `--attempts`, `--seed`, `--steps`, `--pose-id`, `--prompt` (non-pose),
`--mode {best-of-n|reflect}`, `--judge-model <provider/modelId>`, `--dry-run`.

### `--mode` (default `best-of-n`)

The default is **best-of-N**, not reflection. This is a measured verdict, not a
hunch: across the pose library on real flux2-klein (2026-07-04 value-measurement
arc, 7 real-silicon runs), seed sampling was the quality lever that actually
moved quality (correlates 0.96 with human preference — see `klein-int8-local-models`),
while the loop's reflection feedback (failed atoms → targeted prompt expansion)
could **not** fix the one defect it found (fused fingers — a structural
generation weakness, not a prompt-coverage gap). So:

- **`best-of-n` (default)** — each attempt samples a fresh seed with **bare**
  prompts; the validator's reflection feedback is computed but **not** injected.
  The convergence gate (early-exit on attempt 0) and plateau-aware bounded exit
  still fire. This is best-of-N with a cheap early-exit on the easy majority.
- **`reflect` (opt-in, `--mode reflect`)** — pre-0704 behavior: failed-atom
  feedback is injected into the next attempt's prompts. Retained for generators
  where defects may be prompt-coverage gaps (untested on krea2 / non-distilled
  flux2). On flux2-klein it has **not** been observed to beat best-of-N.

### Judge-tier contract — multi-subject poses need the 31b-qat judge

The pose_dsg judge's default served model (the **12b-qat lane**, auto-resolved
by `run.py caption`'s model ladder) **returns 0 atoms on multi-subject
images** — measured 3/3 on the two-person pose L4-02 (the verdict comes back
well-shaped but with zero atoms, faithfulness 0, anatomy all-false; ~3×
latency). It judges single-subject poses correctly. For any multi-subject pose
you MUST pass the stronger tier:

```bash
bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh --pose-id L4-02 \
  --judge-model google/gemma-4-31b-qat
```

Without `--judge-model`, multi-subject poses will exhaust the full attempt budget
on unscored (0-atom) attempts. (Since 2026-07-04, repeated unscored attempts do
trip the plateau guard — see below — but the verdict is still untrustworthy.)
The 12b-qat default is fine for single-subject poses.

#### Judge-tier auto-fallback (2026-07-04)

`judgePose` now **auto-retries ONCE with the 31b-qat tier** when the
configured judge returns a 0-atom verdict, so multi-subject poses no longer
silently fail when you forget `--judge-model`. The fallback is logged visibly
(`[judge] pose_dsg returned 0 atoms under ... → retrying once with ...`) and
flagged on the verdict (`judgeFallback: true`) so the tier dependency stays
observable. Single-subject poses judge fine under the default and never
trigger the fallback, so they pay no latency cost. The fallback is suppressed
when `--judge-model` is already the 31b-qat tier (no retry storm on a pinned
fallback). Explicit `--judge-model google/gemma-4-31b-qat` is still the
cheapest path for a known multi-subject run (avoids the wasted default-tier
call), but forgetting it is no longer a hard failure.

### Plateau guard (and the unscored blind-spot fix)

The loop tracks a stable "failed signature" per attempt and halts early when it
is unchanged for `--consecutive-static` (default 2) rounds — surfacing an
unfixable structural defect as `needsReview` instead of burning the full budget.
Since 2026-07-04 this signature includes an `unscored:N` token, so repeated
judge flakes / 0-atom verdicts are caught as a plateau (previously the empty
signature bypassed the guard — the most common hard-pose failure mode exhausted
the full budget). Regression-tested in
`s2-agent-ext-ultracode/tests/regression-self-improve-loop.test.ts`.

