# Study: adding LTX-2.3 `dev` transformer support to `native-i2v`

Research pass only — no code changed. Answers "what would it take to run
`native-i2v` (and everything built on it: `native-relay`, `StoryboardConfig`
grid-guide) against the `dev` checkpoint instead of only `distilled`."

## Current state: `native-i2v` is hardcoded to `distilled`, everywhere

Five files hardcode the distilled checkpoint path directly — none of them
go through `LTXModelRegistry`:

| File | Line(s) | What's hardcoded |
|---|---|---|
| `Sources/LTXVideoDirector/NativeI2VStage.swift` | 465 | `transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors` |
| `Sources/LTXVideoDirector/NativeI2VStage.swift` | 500 | `SigmaSchedule.distilledSigmas` (fixed 8-step schedule) |
| `Sources/LTXVideoDirector/NativeI2VStage.swift` | 57, 13-18 | error text / header prose say "distilled" only |
| `Sources/LTXVideoDirector/NativeT2AStage.swift` | 147 | same hardcoded distilled path (native text-to-audio) |
| `Sources/LTXVideoDirector/NativeUpscaleStage.swift` | 443, 604, 777, 951 | same hardcoded distilled path, ×4 (post-upscale refinement passes triggered by `native-i2v --refine`) |
| `Sources/LTXVideoDirectorCLI/NativeI2VCommand.swift` | 61, 188 | CLI help text + status print say "distilled"; no `--transformer` flag exists at all |

`NativeRelayStage.swift` has no hardcode of its own — it calls
`NativeI2VStage.generate` for every segment (`NativeRelayStage.swift:178-200`),
so it inherits whatever `NativeI2VStage` does. `StoryboardConfig.swift`
(`toCameraMoveRequest`/`toHardCutRequest`) never sets a transformer-variant
field, because `NativeI2VStage.Request` doesn't have one to set.

## Good news: the loader and config are already variant-generic

- `Transformer/TransformerCheckpointLoader.swift` and
  `Transformer/QuantizedWeights.swift` operate purely on raw key/shape
  dictionaries — nothing distilled-specific in either file.
- `NativeI2VStage.swift`'s `distilledConfig(numLayers:)` (lines 230-247) is
  misleadingly named: `mlx-models/ltx-mlx/distilled/embedded_config.json`
  and `mlx-models/ltx-mlx/dev/embedded_config.json` are **byte-identical**
  (same 48 blocks, same dims/heads/rope). The values it hardcodes are
  correct for `dev` too.
- `LTXModelRegistry.swift` already models the three variants
  (`.dev`/`.distilled`/`.dasiwa`, `defaultForI2V = .dasiwa`) and can
  discover installed checkpoints (`installedVariants()`, `variantDir()`),
  but its own comment (line 41) admits "the actual load happens inside
  run.py today" — it's discovery-only, never wired into `NativeI2VStage`.
- `I2VCommand.swift` (the older, non-native, `RunPyBridge`-backed `i2v`
  command) already threads `--transformer <variant>` plus optional
  `--stage1-steps`/`--stage2-steps`/`--cfg-scale`/`--stg-scale` overrides
  into `run.py` (`I2VCommand.swift:31-32, 37-47, 62-77`) — a ready template
  for the same flag on `NativeI2VCommand`.
- `Sampling/SigmaSchedule.swift` already has `ltx2Schedule`/
  `dynamicShiftSchedule` (lines 31-77) — the token-count-adaptive schedule
  `dev` needs per its manifest (`stage1_steps: 30`) — fully ported and unit
  tested, just **dead code** from `NativeI2VStage`'s perspective (no
  Swift caller outside tests).
- `EulerDiffusionStep.swift` / `DenoiseLoop.swift`'s step loop is
  step-count-agnostic (iterates `sigmas.count - 1` pairs) — no hardcoded
  distilled step count there.

Per-variant recommended params today live **only in JSON**, not Swift:

```
mlx-models/transformer/ltx-2.3-dev-q8/manifest.json:
  stage1_steps: 30, stage2_steps: 3, cfg_scale: 5.0, stg_scale: 1.0

mlx-models/transformer/ltx-2.3-distilled-q8/manifest.json:
  stage1_steps: 8,  stage2_steps: 3, cfg_scale: 1.0, stg_scale: 0.0
```

## The real gap: CFG is not implemented in native Swift at all

Grepped all of `swift/ltx-video-director/Sources` for "cfg" (case
insensitive) — zero functional hits. Confirmed by a full read of
`DenoiseLoop.swift`: `run(...)`/`runStreaming(...)` (lines 37-192) call the
transformer **exactly once per sigma step**, conditional (positive-prompt)
embeddings only. No unconditional/negative branch, no `cfg_scale`
parameter, no doubled batch, no blend step anywhere.

By contrast the vendored Python path implements real CFG: a second
"uncond" forward pass gated on `cfg_scale`
(`ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/utils/samplers.py:390-398, 786-799`),
exposed to `run.py` via `python/mlx-movie-director/app/ltx_pipeline.py:304-434`.
STG (`stg_scale`, spatial-temporal guidance) has no native Swift
counterpart either — no "stg" references anywhere in `Sources/`.

`dev`'s manifest-recommended `cfg_scale=5.0` needs real classifier-free
guidance to mean anything. Loading the `dev` checkpoint into today's
`DenoiseLoop` would silently run at effective `cfg=1.0` (no guidance at
all) — very likely degraded/incoherent output relative to what `dev` is
tuned for, not a working "dev mode."

## Wiring change vs. real feature gap

**Small, mechanical** (loader/config are already variant-generic):
- Add `transformerVariant: LTXTransformerVariant` to
  `NativeI2VStage.Request`, default `.distilled` (no behavior change for
  existing callers).
- Swap `NativeI2VStage.swift:465`'s hardcoded URL for a
  variant-selected path via `LTXModelRegistry.variantDir(_:)`.
- Pick `SigmaSchedule.distilledSigmas` vs.
  `SigmaSchedule.ltx2Schedule(steps: 30, ...)` based on variant — code
  already exists, just needs to be called conditionally instead of the
  hardcoded 8-step table.
- Add `--transformer <dev|distilled|dasiwa>` to `NativeI2VCommand.swift`,
  mirroring `I2VCommand.swift`'s existing flag.
- Update the hardcoded status print (`NativeI2VCommand.swift:188`) and
  header/error prose that currently say "distilled" unconditionally.

**Real feature work** (net-new, not a wiring change):
- Implement classifier-free guidance in `DenoiseLoop.swift` /
  `EulerDiffusionStep.swift`: an unconditional (empty/negative-prompt)
  text-embedding path, a second per-step transformer forward pass,
  `uncond + cfg_scale * (cond - uncond)` blending. Roughly doubles
  per-step transformer cost when `cfg_scale != 1.0`.
- STG (`stg_scale`) has no native equivalent either — `dev`'s recommended
  `stg_scale: 1.0` would need its own new implementation if it's to be
  ported faithfully rather than silently dropped.

## Recommendation

Treat this as two separable milestones, not one PR:

1. **Variant plumbing** (mechanical): thread `LTXTransformerVariant`
   through `Request`/CLI/checkpoint-path selection, defaulting to today's
   `.distilled` behavior unchanged. Low risk, testable immediately against
   the already-installed `dev`/`dasiwa` checkpoints for anything that
   doesn't need real guidance (e.g. `dasiwa`, which per its "distilled+DPO'd
   dev variant, fast like distilled" description in
   `LTXModelRegistry.swift:19-20` may not need CFG at all — worth
   confirming its own manifest cfg_scale before assuming).
2. **CFG implementation** (real feature): only needed to make `dev` itself
   (cfg_scale=5.0) produce correct output. Should be scoped, tested, and
   reviewed as its own unit — it changes the core denoise loop and
   roughly doubles per-step cost when active, so it needs its own
   before/after quality check (e.g. a `--self-test` case), not folded
   silently into the variant-plumbing change.

Do NOT ship "dev support" as just the plumbing — running `dev` without CFG
implemented would produce silently-wrong output that looks like a working
feature but isn't; either gate `--transformer dev` behind a clear
"CFG not yet implemented, output quality not representative" warning until
milestone 2 lands, or don't expose `dev` in the CLI until then.

## Status update (2026-07-05): Milestone 1 shipped

`LTXModelRegistry.transformerCheckpointURL(_:)`, `NativeI2VStage.Request
.transformerVariant`, variant-based checkpoint loading + sigma-schedule
selection (`ltx2Schedule(steps: 30, ...)` for non-distilled), and
`NativeI2VCommand --transformer` all landed, defaulting to `.distilled`
(no behavior change for existing callers). Real-checkpoint regression
suite (grid-guide/FFLF/StoryboardConfig/ModelRegistry, 22 tests) passes.
The CLI help text and code comments explicitly warn that selecting
`dev`/`dasiwa` loads the real checkpoint but runs without CFG — Milestone 2
below is what closes that gap.

## Milestone 2 priority check (2026-07-05): no real dev-mode (cfg>1) example exists anywhere in this repo's ComfyUI reference corpus

Before treating Milestone 2 (real CFG in `DenoiseLoop.swift`) as obviously
worth building, audited all 16 files under
`docs/reference/comfyui_workflows/` programmatically (not spot-checked) —
see that directory's README, "Eighth pass." **Every single `CFGGuider`
node in all 16 files runs at `cfg=1`, with zero exceptions** — including
the 15 files whose `CheckpointLoaderSimple` loads the RAW
`ltx-2.3-22b-dev(-fp8).safetensors` weights (not a pre-fused distilled
checkpoint). Combined with the already-known `LoraLoaderModelOnly`
dev→distilled conversion LoRA, the universal pattern is "load dev weights
→ fuse the conversion LoRA → sample at cfg=1" — never "sample dev weights
directly at their own cfg>1." No `STGGuider`/`DualCFGGuider`/STG mechanism
appears anywhere in the corpus either.

**Practical consequence**: unlike every other feature this package has
ported (FFLF, grid-guide, audio-track, upscale+refine, IC-LoRA family),
real CFG has no ComfyUI reference graph in this repo to validate against —
correctness would need to be checked purely against the vendor Python
`ltx_pipelines_mlx/utils/samplers.py` implementation. This is either a
genuinely novel port (no shortcut of "match this JSON node-for-node") or a
sign that raw dev+CFG sampling isn't actually how this model is used in
practice, community-wide. Treat Milestone 2 as an open prioritization
question, not an assumed-necessary next step, until there's a concrete
reason (a specific quality complaint about `.distilled`/`.dasiwa` output,
or a specific request to match `mlx-models/transformer/ltx-2.3-dev-q8`'s
manifest params exactly) to invest in it.

## Status update (2026-07-07): a concrete reason now exists — production's own default is dasiwa+CFG, and the "no-CFG dev usage" assumption above is wrong for THIS repo

Re-checked `LTXModelRegistry.defaultForI2V` — it's `.dasiwa`, not
`.distilled`. `mlx-models/transformer/ltx-2.3-dasiwa-golden-lace-v3-q8/manifest.json`
recommends `cfg_scale: 5.0, stg_scale: 1.0` (same shape as `dev`, not
`distilled`'s `cfg=1.0`). And `python/mlx-movie-director/app/ltx_pipeline.py`
confirms **production actually samples dasiwa/dev at real cfg>1 with the
distilled LoRA fused only at `0.999` strength for stability** — the LoRA
fusion is not a CFG-avoidance trick here, it runs genuine two-(or more-)pass
guidance on top. This means the "Milestone 2 priority check" conclusion two
sections up (no example anywhere samples dev at cfg>1, so maybe skip it) does
**not** hold for this repo's own production usage, even though it holds for
the external ComfyUI reference corpus. `native-i2v`'s hardcoded `.distilled`
default is a real, silent quality gap versus what `I2VEngine`'s `.dasiwa`
default actually produces.

**The guidance is bigger than plain 2-pass CFG.** Read
`ltx_pipeline.py:53-56` and `guiders.py` in full:

```python
_GUIDER_RESCALE_SCALE = 0.7
_GUIDER_MODALITY_SCALE = 3.0   # NOT 1.0 — modality (cross-modal A2V/V2A) guidance is ON by default
_GUIDER_STG_BLOCKS = [28]
```

Production's video guider for a joint audio+video dasiwa/dev call runs up to
**4 forward passes per step** (`samplers.py:374-442`,
`MultiModalGuider.calculate`):

1. `cond` — normal conditioned prediction (always).
2. `uncond_text` — CFG, active whenever `cfg_scale != 1.0` (dasiwa: 5.0).
3. `uncond_perturbed` — STG, active whenever `stg_scale != 0.0` (dasiwa: 1.0);
   perturbation = skip self-attention in `stg_blocks` (`[28]`) only.
4. `uncond_modality` — cross-modal guidance, active whenever
   `modality_scale != 1.0` (constant `3.0`, so **always on** for any joint
   audio+video call); perturbation = skip A2V/V2A cross-attention.

Combine formula (`guiders.py:107-135`, exact):

```
pred = cond
     + (cfg_scale - 1)      * (cond - uncond_text)
     + stg_scale             * (cond - uncond_perturbed)
     + (modality_scale - 1) * (cond - uncond_modality)

if rescale_scale != 0:
    factor = sqrt(var(cond)) / (sqrt(var(pred)) + 1e-8)
    factor = rescale_scale * factor + (1 - rescale_scale)
    pred = pred * factor
```

Audio uses its own `MultiModalGuiderParams` with `cfg_scale=7.0` (`_FLF2V_AUDIO_CFG_SCALE`
is the FLF2V-specific 7.0 override; the general audio CFG default is also 7.0
per `samplers.py:363`), same `stg_scale`/`stg_blocks`/`rescale_scale` as video.

**Revised Milestone 2 scope** (supersedes the two-milestone plan above — this
is now milestone 2a/2b, not a single "implement CFG" unit):
- **2a (CFG only, video)**: unconditional pass + `(cfg_scale-1)*(cond-uncond)`
  blend + rescale. Minimum viable — makes cfg_scale meaningful at all.
- **2b (STG)**: perturbed pass with self-attention skip on `stg_blocks`.
  Needs a way to run the transformer with block 28's self-attention masked
  out — check whether `Transformer/*.swift` has any hook for this or if it's
  net-new plumbing through the block stack.
- **2c (modality guidance)**: only relevant when audio is requested alongside
  video (native-i2v generates both by default per its joint audio+video
  design) — cross-attention skip (A2V/V2A) is a 4th pass. Given
  `modality_scale=3.0` is production's actual constant (not a knob anyone
  tunes down), this can't be skipped for parity unless a product decision is
  made to accept audio-guidance being worse in native than production.
- Each sub-milestone should get its own before/after quality check
  (a `--self-test` case), not be bundled — 2a alone is testable against a
  video-only (no-audio) dasiwa call; 2c requires an audio-bearing call.

**Memory cost**: 4 passes ≈ 4x per-step transformer forward cost (dev/dasiwa
already the heaviest checkpoint). The vendor Python side already documents
this is why some of ITS OWN pipelines default `stg_scale=0.0` for 32GB Macs
(`CLAUDE.md`'s "Guidance System" section) — dasiwa's manifest recommending
`stg_scale=1.0` regardless may be a copied template value, not a verified
memory-safe choice on this hardware; worth confirming empirically (does the
existing Python `run.py video t2i2v --transformer dasiwa` actually run with
stg_scale=1.0 today without OOM on this machine?) before committing the
native Swift port to replicate it exactly.

## Status update (2026-07-07, later): Milestone 2a (CFG only) shipped

`Sampling/CFGGuidance.swift` (new) implements the CFG term of
`MultiModalGuider.calculate` (`guiders.py`) — `cond + (cfgScale-1)*(cond-uncond)`
plus the optional variance-preserving rescale — and
`DEFAULT_NEGATIVE_PROMPT` copied verbatim from `utils/constants.py`.
`DenoiseLoop.runStreaming` gained `uncondVideoTextEmbeds`/`cfgScale`/
`rescaleScale` parameters (all default to off — `cfgScale: Float = 1.0`,
`uncondVideoTextEmbeds: MLXArray? = nil` — so every existing caller is
behavior-identical unless it opts in). When active, an extra unconditional
forward pass runs per step (video stream only — audio guidance is 2c, not
implemented), doubling per-step transformer cost for `.dev`/`.dasiwa`.

`NativeI2VStage.Request` gained `cfgScale: Double?` (nil = variant default:
`1.0` for `.distilled`, `5.0` for `.dev`/`.dasiwa`, matching their manifest
and `ltx_pipeline.py`'s own default) and `rescaleScale: Float = 0.7`
(matches production's `_GUIDER_RESCALE_SCALE`). `NativeI2VCommand` exposes
both as `--cfg-scale`/`--rescale-scale`. The negative prompt is encoded via
a second `NativeTextEncodeStage.encode` call, only when CFG is active.

**Not yet done** (tracked as 2b/2c above, unchanged): STG (block-28
self-attention perturbation) and modality guidance (cross-modal A2V/V2A
perturbation) — so `.dev`/`.dasiwa` output is now CFG-guided but still not
full parity with production's 4-pass guidance. No real-checkpoint parity
test has been run yet (build + existing regression suite only) — before
trusting this for quality-sensitive use, run a real `.dasiwa` generation and
visually compare against the Python `run.py` equivalent.
